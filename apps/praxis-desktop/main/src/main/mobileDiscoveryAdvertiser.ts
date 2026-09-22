/**
 * Publishes untrusted LAN discovery hints while the mobile listener is bound.
 *
 * Hints carry host identity (id, display name, key fingerprint, TCP port) and
 * never a pairing token, private key, or grant. Phones must still complete the
 * authenticated pairing path before any command is accepted.
 */
import * as dgram from 'node:dgram';

export const MOBILE_DISCOVERY_MULTICAST_ADDRESS = '239.255.90.90';
export const MOBILE_DISCOVERY_PORT = 43199;
export const MOBILE_DISCOVERY_VERSION = 1 as const;
const DEFAULT_INTERVAL_MS = 1500;

export interface MobileDiscoveryHint {
  version: typeof MOBILE_DISCOVERY_VERSION;
  hostId: string;
  displayName: string;
  fingerprint: string;
  port: number;
  addresses: readonly string[];
}

export function encodeMobileDiscoveryHint(hint: MobileDiscoveryHint): string {
  return JSON.stringify({
    v: hint.version,
    hostId: hint.hostId,
    displayName: hint.displayName,
    fingerprint: hint.fingerprint,
    port: hint.port,
    addresses: [...hint.addresses],
  });
}

export function parseMobileDiscoveryHint(raw: string): MobileDiscoveryHint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if ('tokenId' in record || 'privateKey' in record || 'pairingCode' in record || 'publicKeyHex' in record) {
    return undefined;
  }
  if (record.v !== MOBILE_DISCOVERY_VERSION) return undefined;
  if (typeof record.hostId !== 'string' || !record.hostId.trim()) return undefined;
  if (typeof record.displayName !== 'string' || !record.displayName.trim()) return undefined;
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{16}$/i.test(record.fingerprint)) return undefined;
  if (typeof record.port !== 'number' || record.port < 1024 || record.port > 65535) return undefined;
  if (!Array.isArray(record.addresses) || !record.addresses.every(item => typeof item === 'string')) return undefined;
  return {
    version: MOBILE_DISCOVERY_VERSION,
    hostId: record.hostId.trim(),
    displayName: record.displayName.trim(),
    fingerprint: record.fingerprint.toLowerCase(),
    port: record.port,
    addresses: record.addresses.map(item => item.trim()).filter(Boolean),
  };
}

export interface MobileDiscoveryAdvertiserDeps {
  broadcast?: (payload: Buffer) => void;
  intervalMs?: number;
}

export class MobileDiscoveryAdvertiser {
  private timer?: ReturnType<typeof setInterval>;
  private socket?: dgram.Socket;
  private payload?: Buffer;
  private running = false;

  constructor(private readonly deps: MobileDiscoveryAdvertiserDeps = {}) {}

  get advertised(): boolean {
    return this.running;
  }

  start(hint: MobileDiscoveryHint): void {
    this.payload = Buffer.from(encodeMobileDiscoveryHint(hint), 'utf8');
    if (this.running) {
      this.emit();
      return;
    }
    this.running = true;
    if (!this.deps.broadcast) this.openSocket();
    this.emit();
    this.timer = setInterval(() => this.emit(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    this.payload = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private emit(): void {
    if (!this.payload) return;
    if (this.deps.broadcast) {
      this.deps.broadcast(this.payload);
      return;
    }
    this.socket?.send(this.payload, MOBILE_DISCOVERY_PORT, MOBILE_DISCOVERY_MULTICAST_ADDRESS);
  }

  private openSocket(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => {
      this.running = false;
    });
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
      } catch {
        // Best-effort: some sandboxes refuse multicast options.
      }
    });
    this.socket = socket;
  }
}

let advertiser: MobileDiscoveryAdvertiser | undefined;

export function startMobileDiscoveryAdvertisement(hint: MobileDiscoveryHint): void {
  if (!advertiser) advertiser = new MobileDiscoveryAdvertiser();
  advertiser.start(hint);
}

export function stopMobileDiscoveryAdvertisement(): void {
  advertiser?.stop();
}

export function isMobileDiscoveryAdvertised(): boolean {
  return advertiser?.advertised === true;
}

export function resetMobileDiscoveryAdvertiser(): void {
  advertiser?.stop();
  advertiser = undefined;
}
