/**
 * Desktop pairing ledger: trusted devices on disk, one active single-use
 * invitation and in-flight confirmation requests in memory.
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
    details: { displayName: string; publicKeyHex: string; endpoints: readonly { address: string; port: number }[] },
  ): MobilePairingInvitation | undefined {
    if (!isActivePairingToken(this.token, now)) return undefined;
    return createMobilePairingInvitation(this.token, details);
  }

  issueInvitation(
    hostId: string,
    details: { displayName: string; publicKeyHex: string; endpoints: readonly { address: string; port: number }[] },
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

  /** Unknown peer during an active invitation becomes a confirmation request. */
  submitUnpaired(publicKeyHex: string, now = new Date().toISOString()): MobilePairingPendingRequest | undefined {
    if (!isActivePairingToken(this.token, now)) return undefined;
    const hostId = this.token.hostId;
    const existing = [...this.pending.values()].find(request => request.devicePublicKey.toLowerCase() === publicKeyHex.toLowerCase());
    if (existing) return existing;
    const request: MobilePairingPendingRequest = {
      requestId: randomUUID(),
      tokenId: this.token.tokenId,
      hostId,
      deviceId: mobileDeviceIdForPublicKey(publicKeyHex),
      devicePublicKey: publicKeyHex,
      deviceLabel: `Phone ${publicKeyHex.slice(0, 6)}`,
      requestedAt: now,
    };
    this.pending.set(request.requestId, request);
    return request;
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
