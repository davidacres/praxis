import TcpSocket from 'react-native-tcp-socket';
import * as SecureStore from 'expo-secure-store';
import { generateKeyPair, RecordAssembler, SecureChannel, type KeyPair } from '@praxis/mobile-protocol';
import type { MobileCommand, MobileEventEnvelope, MobileReadRequest } from '@praxis/core';

export interface MobileHostConfiguration {
  hostId: string;
  hostName?: string;
  address: string;
  port: number;
  hostPublicKeyHex: string;
  projectId?: string;
}

type RequestFrame = { id: string; kind: 'read' | 'command' | 'replay'; payload: unknown };
type ReplyFrame = { id: string; kind: 'reply'; ok: boolean; value?: unknown; error?: string };
type EventFrame = { kind: 'event'; envelope: MobileEventEnvelope };
type ServerFrame = ReplyFrame | EventFrame;

const DEVICE_KEY = 'praxis.mobile.devicePrivateKey.v1';
const HOST_CONFIGURATION_KEY = 'praxis.mobile.hostConfiguration.v1';
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

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

export class NativeMobileConnection {
  private socket?: ReturnType<typeof TcpSocket.createConnection>;
  private channel?: SecureChannel;
  private assembler = new RecordAssembler();
  private requestSequence = 0;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(event: MobileEventEnvelope) => void>();
  private readonly stateListeners = new Set<(connected: boolean, error?: Error) => void>();

  constructor(readonly config: MobileHostConfiguration) {}

  async connect(): Promise<void> {
    if (this.socket && this.channel?.open) return;
    const identity = await deviceIdentity();
    const channel = SecureChannel.initiator({
      staticKeyPair: identity,
      remoteStaticPublicKey: fromHex(this.config.hostPublicKeyHex),
    });
    this.channel = channel;
    this.assembler = new RecordAssembler();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = TcpSocket.createConnection({
        host: this.config.address,
        port: this.config.port,
        interface: 'wifi',
        connectTimeout: 10_000,
      }, () => socket.write(channel.nextHandshakeMessage()));
      this.socket = socket;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.rejectPending(error);
        for (const listener of this.stateListeners) listener(false, error);
      };
      socket.setTimeout(30_000, () => fail(new Error('The Praxis desktop connection timed out.')));
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('The Praxis desktop connection closed.')));
      socket.on('data', raw => {
        const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
        let records: Uint8Array[];
        try {
          records = this.assembler.push(bytes);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          socket.destroy();
          return;
        }
        for (const record of records) {
          try {
            if (!channel.open) {
              channel.readHandshakeMessage(record);
              if (channel.open && !settled) {
                settled = true;
                socket.setTimeout(0);
                resolve();
              }
              continue;
            }
            const frame = decode<ServerFrame>(channel.decrypt(record));
            if (frame.kind === 'event') {
              for (const listener of this.listeners) listener(frame.envelope);
            } else {
              const pending = this.pending.get(frame.id);
              if (!pending) continue;
              clearTimeout(pending.timer);
              this.pending.delete(frame.id);
              if (frame.ok) pending.resolve(frame.value);
              else pending.reject(new Error(frame.error || 'The desktop rejected the request.'));
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            socket.destroy();
          }
        }
      });
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(kind: RequestFrame['kind'], payload: unknown): Promise<T> {
    const socket = this.socket;
    const channel = this.channel;
    if (!socket || !channel?.open) return Promise.reject(new Error('The Praxis desktop is offline.'));
    this.requestSequence += 1;
    const id = `mobile-${Date.now().toString(36)}-${this.requestSequence.toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The Praxis desktop did not answer in time.'));
      }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      socket.write(channel.encrypt(encode({ id, kind, payload } satisfies RequestFrame)));
    });
  }

  read<T>(request: MobileReadRequest): Promise<T> { return this.request<T>('read', request); }
  command<T>(command: MobileCommand): Promise<T> { return this.request<T>('command', command); }
  replay(afterSequence: number): Promise<{ replaying: boolean }> { return this.request('replay', { afterSequence }); }

  subscribe(listener: (event: MobileEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }


  subscribeState(listener: (connected: boolean, error?: Error) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.channel = undefined;
    this.rejectPending(new Error('The Praxis desktop connection closed.'));
  }
}
