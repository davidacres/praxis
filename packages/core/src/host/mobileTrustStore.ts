export interface MobileTrustedDevice {
  deviceId: string;
  label: string;
  hostId: string;
  hostKeyFingerprint: string;
  devicePublicKey: string;
  projectIds: readonly string[];
  pairedAt: string;
  revokedAt?: string;
}

export interface MobileTrustStore {
  list(hostId: string): readonly MobileTrustedDevice[];
  save(device: MobileTrustedDevice): void;
  revoke(hostId: string, deviceId: string, revokedAt: string): boolean;
  rotateHostKey(hostId: string, fingerprint: string): void;
}

export class InMemoryMobileTrustStore implements MobileTrustStore {
  constructor(devices: readonly MobileTrustedDevice[] = []) { for (const device of devices) this.save(device); }
  private readonly devices = new Map<string, MobileTrustedDevice>();
  list(hostId: string): readonly MobileTrustedDevice[] {
    return [...this.devices.values()].filter(device => device.hostId === hostId);
  }
  save(device: MobileTrustedDevice): void { this.devices.set(`${device.hostId}:${device.deviceId}`, device); }
  revoke(hostId: string, deviceId: string, revokedAt: string): boolean {
    const key=`${hostId}:${deviceId}`; const current=this.devices.get(key);
    if (!current || current.revokedAt) return false;
    this.devices.set(key,{...current,revokedAt}); return true;
  }
  rotateHostKey(hostId: string, fingerprint: string): void {
    for (const device of this.list(hostId)) this.devices.set(`${hostId}:${device.deviceId}`,{...device,hostKeyFingerprint:fingerprint,revokedAt:device.revokedAt});
  }
}

export function canReconnectTrustedDevice(
  store: MobileTrustStore,
  hostId: string,
  deviceId: string,
  hostKeyFingerprint: string,
): boolean {
  return store.list(hostId).some(device =>
    device.deviceId === deviceId &&
    !device.revokedAt &&
    device.hostKeyFingerprint === hostKeyFingerprint,
  );
}
