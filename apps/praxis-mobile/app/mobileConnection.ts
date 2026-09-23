import TcpSocket from 'react-native-tcp-socket';
import * as SecureStore from 'expo-secure-store';
import {
  MobileSecureClient,
  generateKeyPair,
  type KeyPair,
  type MobileConnectionError,
  type MobileConnectionStatus,
  type MobileReplayResult,
} from '@praxis/mobile-protocol';
import type { MobileCommand, MobileEventEnvelope, MobileReadRequest } from '@praxis/core';

export interface MobileHostConfiguration {
  hostId: string;
  hostName?: string;
  address: string;
  port: number;
  hostPublicKeyHex: string;
  projectId?: string;
  /** Present only until the desktop has confirmed this phone; invitations are single-use. */
  pairingTokenId?: string;
  pairingExpiresAt?: string;
}

const DEVICE_KEY = 'praxis.mobile.devicePrivateKey.v1';
const HOST_CONFIGURATION_KEY = 'praxis.mobile.hostConfiguration.v1';

function fromHex(value: string): Uint8Array {
  const clean = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('The desktop host key must be 32 bytes of hexadecimal text.');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

const toHex = (value: Uint8Array): string => [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function deviceIdentity(): Promise<KeyPair> {
  const stored = await SecureStore.getItemAsync(DEVICE_KEY);
  if (stored) return generateKeyPair(fromHex(stored));
  const identity = generateKeyPair();
  await SecureStore.setItemAsync(DEVICE_KEY, toHex(identity.privateKey), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return identity;
}

export async function loadMobileHostConfiguration(): Promise<MobileHostConfiguration | undefined> {
  const stored = await SecureStore.getItemAsync(HOST_CONFIGURATION_KEY);
  if (!stored) return undefined;
  try {
    const value = JSON.parse(stored) as MobileHostConfiguration;
    return value.address && value.hostId && value.hostPublicKeyHex && Number.isInteger(value.port) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function saveMobileHostConfiguration(value: MobileHostConfiguration): Promise<void> {
  await SecureStore.setItemAsync(HOST_CONFIGURATION_KEY, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function forgetMobileHostConfiguration(): Promise<void> {
  await SecureStore.deleteItemAsync(HOST_CONFIGURATION_KEY);
}

/** Hex prefix of this phone's public key — the desktop lists a pending phone as "Phone <prefix>". */
export async function mobileDeviceKeyPrefix(): Promise<string> {
  return toHex((await deviceIdentity()).publicKey).slice(0, 6);
}

/**
 * One encrypted session with the desktop over `react-native-tcp-socket`. The
 * protocol work (handshake, pairing status, request correlation, failure
 * reasons) is `MobileSecureClient`'s, shared with the desktop's tests.
 */
export class NativeMobileConnection {
  private client?: MobileSecureClient;
  private readonly listeners = new Set<(event: MobileEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: MobileConnectionStatus) => void>();
  private readonly closeListeners = new Set<(error: MobileConnectionError) => void>();

  constructor(readonly config: MobileHostConfiguration) {}

  async connect(): Promise<void> {
    if (this.client) throw new Error('This connection was already opened; create a new one to reconnect.');
    const identity: KeyPair = await deviceIdentity();
    const endpoint = `${this.config.address}:${this.config.port}`;
    const client = new MobileSecureClient({
      endpoint,
      staticKeyPair: identity,
      remoteStaticPublicKey: fromHex(this.config.hostPublicKeyHex),
      ...(this.config.pairingTokenId ? { pairingTokenId: this.config.pairingTokenId } : {}),
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
      connect: handlers => {
        const socket = TcpSocket.createConnection({
          host: this.config.address,
          port: this.config.port,
          interface: 'wifi',
          connectTimeout: 10_000,
        }, () => handlers.onConnect());
        socket.on('data', raw => handlers.onData(typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw)));
        socket.on('error', error => handlers.onError(error));
        socket.on('close', () => handlers.onClose());
        return { write: bytes => { socket.write(bytes); }, destroy: () => socket.destroy() };
      },
    });
    this.client = client;
    client.onEvent(envelope => {
      for (const listener of this.listeners) listener(envelope as unknown as MobileEventEnvelope);
    });
    client.onStatus(status => {
      for (const listener of this.statusListeners) listener(status);
    });
    client.onClose(error => {
      for (const listener of this.closeListeners) listener(error);
    });
    await client.connect();
  }

  private get ready(): MobileSecureClient {
    if (!this.client) throw new Error('The Praxis desktop is not connected.');
    return this.client;
  }

  read<T>(request: MobileReadRequest): Promise<T> { return this.ready.read<T>(request); }
  command<T>(command: MobileCommand): Promise<T> { return this.ready.command<T>(command); }
  replay(afterSequence: number): Promise<MobileReplayResult> { return this.ready.replay(afterSequence); }

  subscribe(listener: (event: MobileEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Status frames — notably `pairing-pending` while the desktop has not confirmed this phone. */
  subscribeStatus(listener: (status: MobileConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires once when an established or pending connection ends, with the reason. */
  subscribeClose(listener: (error: MobileConnectionError) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.client?.close();
  }
}
