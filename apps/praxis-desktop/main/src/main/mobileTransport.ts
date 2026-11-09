import type { MobileAccessPolicy } from '@praxis/core';
import type { MobileConnectionStatus } from '@praxis/mobile-protocol';
import type { MobileLanAuthorizedPeer } from './mobileLanServer';

/** Awaitable controls let the in-process and Rust transports share lifecycle ownership. */
export interface MobileListenerTransport {
  readonly listening: boolean;
  readonly port: number | undefined;
  readonly addresses: readonly string[];
  readonly bindError: string | undefined;
  connectionCount(): number;
  start(port: number, policy: MobileAccessPolicy): Promise<void>;
  stop(): Promise<void>;
  dispose?(): Promise<void>;
  applyPolicy(policy: MobileAccessPolicy, dropConnections: boolean): void | Promise<void>;
  dropAll(status?: MobileConnectionStatus): void | Promise<void>;
  dropDevice(deviceId: string, status?: MobileConnectionStatus): number | Promise<number>;
  dropPublicKey(publicKeyHex: string, status?: MobileConnectionStatus): number | Promise<number>;
  promotePending(publicKeyHex: string, grant: MobileLanAuthorizedPeer): void | Promise<void>;
}

export interface MobileRelayTransport {
  readonly state: string;
  readonly channel: string | undefined;
  readonly error: string | undefined;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export function selectMobileTransport(packaged: boolean, env = process.env): 'rust' | 'typescript' {
  const disabled = ['none', 'false', '0', 'off'].includes(env.PRAXIS_RUST_CHANNELS?.trim().toLowerCase() ?? '');
  return !packaged && !disabled && env.PRAXIS_MOBILE_TRANSPORT?.trim().toLowerCase() === 'rust' ? 'rust' : 'typescript';
}
