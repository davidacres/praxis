import { createHash } from 'node:crypto';
import type { MobileCapability } from './mobileProtocol';
import type { MobileAccessMode } from './mobileAccessPolicy';
import type { MobilePairingInvitation, MobilePairingPendingRequest } from './mobilePairingHandshake';

export const DEFAULT_MOBILE_LISTENER_PORT = 43100;

export interface MobileAccessSettings {
  mode: MobileAccessMode;
  hostName: string;
  allowedInterfaces: readonly string[];
  allowedSubnets: readonly string[];
  /** TCP port the LAN listener binds. 1024–65535; default 43100. */
  listenPort: number;
  remoteSignInRequired: boolean;
}

export interface MobilePairedDevice {
  deviceId: string;
  label: string;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  publicKeyHex?: string;
  capabilities?: readonly MobileCapability[];
  projectIds?: readonly string[];
}

export interface MobileAuditRecord {
  occurredAt: string;
  actorDeviceId?: string;
  actorSubject?: string;
  hostId: string;
  projectId?: string;
  action: string;
  outcome: 'allowed' | 'denied' | 'revoked' | 'failed';
  details?: Readonly<Record<string, string | number | boolean>>;
}

export function revokeMobileDevice(
  devices: readonly MobilePairedDevice[],
  deviceId: string,
  revokedAt: string,
): readonly MobilePairedDevice[] {
  return devices.map(device =>
    device.deviceId === deviceId && !device.revokedAt ? { ...device, revokedAt } : device,
  );
}

export function isMobileDeviceTrusted(device: MobilePairedDevice, now = new Date().toISOString()): boolean {
  return !device.revokedAt && device.pairedAt <= now;
}

export function createMobileAuditRecord(input: MobileAuditRecord): MobileAuditRecord {
  const details = input.details
    ? Object.fromEntries(Object.entries(input.details).filter(([key]) => !/secret|token|password|transcript|body/i.test(key)))
    : undefined;
  return { ...input, details };
}

export function fingerprintMobileHostKey(publicKeyHex: string): string {
  return createHash('sha256').update(publicKeyHex.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function mobileDeviceIdForPublicKey(publicKeyHex: string): string {
  return `device:${createHash('sha256').update(publicKeyHex.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
}

export interface MobileLanInterface {
  name: string;
  address: string;
}

export interface MobileListenerStatus {
  listening: boolean;
  mode: MobileAccessMode;
  port?: number;
  addresses: readonly string[];
  interfaces: readonly MobileLanInterface[];
  connectionCount: number;
  lastError?: string;
  discovery: {
    advertised: boolean;
    hostId: string;
    displayName: string;
    fingerprint: string;
  };
}

export interface MobilePairingSnapshot {
  hostId: string;
  hostName: string;
  publicKeyHex: string;
  fingerprint: string;
  invitation?: MobilePairingInvitation;
  pending: readonly MobilePairingPendingRequest[];
  devices: readonly MobilePairedDevice[];
  listener: MobileListenerStatus;
  projects: readonly { id: string; name: string }[];
}

export function authorizeMobilePeer(
  devices: readonly MobilePairedDevice[],
  publicKeyHex: string,
  now = new Date().toISOString(),
): MobilePairedDevice | undefined {
  const needle = publicKeyHex.trim().toLowerCase();
  const device = devices.find(candidate => candidate.publicKeyHex?.trim().toLowerCase() === needle);
  if (!device || !isMobileDeviceTrusted(device, now)) return undefined;
  return device;
}
