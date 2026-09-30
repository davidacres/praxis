/**
 * Desktop pairing ledger: trusted devices on disk, one active single-use
 * invitation and in-flight confirmation requests in memory.
 *
 * An unknown phone only becomes a confirmation request by presenting the
 * current invitation's token (from the QR / pasted invitation) over its
 * authenticated channel; knowing the host key is not enough. Confirming one
 * request consumes the token, so every other request made with it is void.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  authorizeMobilePeer,
  consumeMobilePairing,
  createMobilePairingInvitation,
  isActivePairingToken,
  issueMobilePairingToken,
  mobileDeviceIdForPublicKey,
  revokeMobileDevice,
  type MobileCapability,
  type MobilePairedDevice,
  type MobilePairingInvitation,
  type MobilePairingPendingRequest,
  type MobilePairingToken,
  InMemoryMobilePairingStore,
} from '@praxis/core';

export interface MobilePairingPersist {
  load(): { devices: MobilePairedDevice[] };
  save(state: { devices: MobilePairedDevice[] }): void;
}

export class MobilePairingRegistry {
  private devices: MobilePairedDevice[];
  private token?: MobilePairingToken;
  private readonly tokenStore = new InMemoryMobilePairingStore();
  private readonly pending = new Map<string, MobilePairingPendingRequest>();
  private superseded: MobilePairingPendingRequest[] = [];

  constructor(private readonly persist: MobilePairingPersist) {
    this.devices = [...persist.load().devices];
  }

  listDevices(): readonly MobilePairedDevice[] {
    return this.devices;
  }

  listPending(): readonly MobilePairingPendingRequest[] {
    return [...this.pending.values()].sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  activeInvitation(
    now: string,
    details: { displayName: string; publicKeyHex: string; endpoints: readonly { address: string; port: number }[]; relay?: { url: string; channel: string } },
  ): MobilePairingInvitation | undefined {
    if (!isActivePairingToken(this.token, now)) return undefined;
    return createMobilePairingInvitation(this.token, details);
  }

  issueInvitation(
    hostId: string,
    details: { displayName: string; publicKeyHex: string; endpoints: readonly { address: string; port: number }[]; relay?: { url: string; channel: string } },
    now = new Date(),
  ): MobilePairingInvitation {
    const tokenId = randomBytes(6).toString('hex');
    const token = issueMobilePairingToken(hostId, tokenId, now);
    this.token = token;
    this.tokenStore.save(token);
    this.pending.clear();
    return createMobilePairingInvitation(token, details);
  }

  authorize(publicKeyHex: string, now = new Date().toISOString()): MobilePairedDevice | undefined {
    return authorizeMobilePeer(this.devices, publicKeyHex, now);
  }

  hasActiveInvitation(now = new Date().toISOString()): boolean {
    return isActivePairingToken(this.token, now);
  }

  /** True when this key belonged to a device the desktop revoked (and it has not re-paired). */
  wasRevoked(publicKeyHex: string): boolean {
    const needle = publicKeyHex.toLowerCase();
    const matches = this.devices.filter(device => device.publicKeyHex?.toLowerCase() === needle);
    return matches.length > 0 && matches.every(device => device.revokedAt);
  }

  /**
   * An unknown peer presenting `tokenId`. Only the current, unexpired,
   * unconsumed invitation's token creates (or returns the existing)
   * confirmation request for that key.
   */
  submitUnpaired(
    publicKeyHex: string,
    tokenId: string,
    now = new Date().toISOString(),
  ): { ok: true; request: MobilePairingPendingRequest } | { ok: false; reason: 'no-invitation' | 'expired' | 'used' | 'invalid-token' } {
    const token = this.token;
    if (!token) return { ok: false, reason: 'no-invitation' };
    if (!sameToken(token.tokenId, tokenId)) return { ok: false, reason: 'invalid-token' };
    if (token.consumedAt) return { ok: false, reason: 'used' };
    if (!isActivePairingToken(token, now)) return { ok: false, reason: 'expired' };
    const hostId = token.hostId;
    const existing = [...this.pending.values()].find(request => request.devicePublicKey.toLowerCase() === publicKeyHex.toLowerCase());
    if (existing) return { ok: true, request: existing };
    const request: MobilePairingPendingRequest = {
      requestId: randomUUID(),
      tokenId: token.tokenId,
      hostId,
      deviceId: mobileDeviceIdForPublicKey(publicKeyHex),
      devicePublicKey: publicKeyHex,
      deviceLabel: `Phone ${publicKeyHex.slice(0, 6)}`,
      requestedAt: now,
    };
    this.pending.set(request.requestId, request);
    return { ok: true, request };
  }

  confirm(
    requestId: string,
    grant: { label?: string; capabilities: readonly MobileCapability[]; projectIds: readonly string[] },
    now = new Date().toISOString(),
  ): { ok: true; device: MobilePairedDevice } | { ok: false; reason: string } {
    const pending = this.pending.get(requestId);
    if (!pending) return { ok: false, reason: 'unknown-request' };
    const result = consumeMobilePairing(
      this.tokenStore,
      {
        verify: request => request.devicePublicKey === pending.devicePublicKey,
        confirmDevice: () => true,
      },
      {
        tokenId: pending.tokenId,
        hostId: pending.hostId,
        deviceId: pending.deviceId,
        devicePublicKey: pending.devicePublicKey,
        projectIds: grant.projectIds,
        proof: pending.devicePublicKey,
        requestedAt: pending.requestedAt,
      },
      now,
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    this.pending.delete(requestId);
    const superseded: MobilePairingPendingRequest[] = [];
    for (const [id, other] of this.pending) {
      if (other.tokenId === pending.tokenId) {
        superseded.push(other);
        this.pending.delete(id);
      }
    }
    this.superseded = superseded;
    this.token = this.tokenStore.get(pending.tokenId);
    const device: MobilePairedDevice = {
      deviceId: result.deviceId,
      label: grant.label?.trim() || pending.deviceLabel,
      pairedAt: now,
      publicKeyHex: pending.devicePublicKey,
      capabilities: grant.capabilities,
      projectIds: result.projectIds,
    };
    this.devices = [...this.devices.filter(item => item.deviceId !== device.deviceId), device];
    this.persist.save({ devices: this.devices });
    return { ok: true, device };
  }

  /** Requests voided by the last confirm (same single-use token); cleared when read. */
  takeSuperseded(): MobilePairingPendingRequest[] {
    const out = this.superseded;
    this.superseded = [];
    return out;
  }

  deny(requestId: string): boolean {
    return this.pending.delete(requestId);
  }

  revoke(deviceId: string, now = new Date().toISOString()): MobilePairedDevice | undefined {
    const before = this.devices.find(device => device.deviceId === deviceId);
    this.devices = [...revokeMobileDevice(this.devices, deviceId, now)];
    this.persist.save({ devices: this.devices });
    return this.devices.find(device => device.deviceId === deviceId) ?? before;
  }

  /** After a host-key reset every phone must re-pair. */
  revokeAll(now = new Date().toISOString()): void {
    this.devices = this.devices.map(device => (device.revokedAt ? device : { ...device, revokedAt: now }));
    this.token = undefined;
    this.pending.clear();
    this.persist.save({ devices: this.devices });
  }

  touch(publicKeyHex: string, now = new Date().toISOString()): void {
    const device = authorizeMobilePeer(this.devices, publicKeyHex, now);
    if (!device) return;
    this.devices = this.devices.map(item => item.deviceId === device.deviceId ? { ...item, lastSeenAt: now } : item);
    this.persist.save({ devices: this.devices });
  }
}

function sameToken(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented.trim(), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
