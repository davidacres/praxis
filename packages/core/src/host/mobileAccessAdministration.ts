import type { MobileAccessMode } from './mobileAccessPolicy';

export interface MobileAccessSettings {
  mode: MobileAccessMode;
  hostName: string;
  allowedInterfaces: readonly string[];
  allowedSubnets: readonly string[];
  remoteSignInRequired: boolean;
}

export interface MobilePairedDevice {
  deviceId: string;
  label: string;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
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
