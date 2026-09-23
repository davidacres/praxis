/**
 * The phone side of the desktop LAN transport, independent of any socket
 * library: React Native passes a `react-native-tcp-socket` connector, tests
 * pass `node:net`. It runs the Noise IK handshake (pinning the desktop key),
 * follows the listener's status frames through pairing, correlates request
 * ids with replies, and turns every failure into a `MobileConnectionError`
 * that says what went wrong instead of "the connection closed".
 */
import type { KeyPair } from './noise';
import { RecordAssembler, SecureChannel } from './secureChannel';
import {
  MobileConnectionError,
  classifyMobileTransportFailure,
  isTerminalMobileStatus,
  mobileConnectionStatus,
  type MobileConnectionStatus,
  type MobileReplayResult,
  type MobileEventFrame,
  type MobileReplyErrorCode,
  type MobileRequestFrame,
  type MobileServerFrame,
} from './wire';

export interface MobileByteSocket {
  write(bytes: Uint8Array): void;
  destroy(): void;
}

export interface MobileSocketHandlers {
  onConnect(): void;
  onData(bytes: Uint8Array): void;
  onError(error: unknown): void;
  onClose(): void;
}

/** Opens a TCP connection and reports its lifecycle through `handlers`. */
export type MobileSocketConnector = (handlers: MobileSocketHandlers) => MobileByteSocket;

export interface MobileSecureClientOptions {
  connect: MobileSocketConnector;
  /** `address:port`, used only in messages. */
  endpoint: string;
  staticKeyPair: KeyPair;
  /** The desktop host key pinned at pairing. */
  remoteStaticPublicKey: Uint8Array;
  /** Invitation token presented when the desktop does not know this phone yet. */
  pairingTokenId?: string;
  prologue?: Uint8Array;
  /** TCP connect + handshake + first status, excluding time spent awaiting desktop confirmation. */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * A desktop from before status frames never sends one: after the handshake,
   * silence this long means "ready" (0 disables the fallback).
   */
  legacyReadyAfterMs?: number;
}

/** A request the desktop answered with an error. */
export class MobileRequestError extends Error {
  constructor(message: string, readonly code?: MobileReplyErrorCode) {
    super(message);
    this.name = 'MobileRequestError';
  }
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

type Stage = 'connect' | 'handshake' | 'session';

export class MobileSecureClient {
  private socket?: MobileByteSocket;
  private channel?: SecureChannel;
  private stage: Stage = 'connect';
  private ready = false;
  private closed = false;
  private lastStatus?: MobileConnectionStatus;
  private abandon?: (error: MobileConnectionError, notify: boolean) => void;
  private requestSequence = 0;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly eventListeners = new Set<(envelope: MobileEventFrame['envelope']) => void>();
  private readonly statusListeners = new Set<(status: MobileConnectionStatus) => void>();
  private readonly closeListeners = new Set<(error: MobileConnectionError) => void>();

  constructor(private readonly options: MobileSecureClientOptions) {}

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  get status(): MobileConnectionStatus | undefined {
    return this.lastStatus;
  }

  onEvent(listener: (envelope: MobileEventFrame['envelope']) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Every status frame, including `pairing-pending` while the desktop has not confirmed yet. */
  onStatus(listener: (status: MobileConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires once when an established or pending connection ends, with the reason. */
  onClose(listener: (error: MobileConnectionError) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Resolves once the desktop reports `ready`; rejects with a `MobileConnectionError`. */
  connect(): Promise<void> {
    if (this.socket) return Promise.reject(new Error('MobileSecureClient.connect() may only be called once.'));
    const channel = SecureChannel.initiator({
      staticKeyPair: this.options.staticKeyPair,
      remoteStaticPublicKey: this.options.remoteStaticPublicKey,
      ...(this.options.prologue ? { prologue: this.options.prologue } : {}),
    });
    this.channel = channel;
    const assembler = new RecordAssembler();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armTimeout = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(classifyMobileTransportFailure({ stage: this.stage, endpoint: this.options.endpoint, timedOut: true })), this.options.connectTimeoutMs ?? 15_000);
      };
      const disarmTimeout = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      let legacyTimer: ReturnType<typeof setTimeout> | undefined;
      const clearLegacy = (): void => {
        if (legacyTimer) clearTimeout(legacyTimer);
        legacyTimer = undefined;
      };
      const fail = (error: MobileConnectionError, notify = true): void => {
        disarmTimeout();
        clearLegacy();
        if (this.closed) return;
        this.closed = true;
        this.socket?.destroy();
        this.rejectPending(error);
        if (!settled) {
          settled = true;
          reject(error);
        } else if (notify) {
          for (const listener of this.closeListeners) listener(error);
        }
      };
      this.abandon = fail;
      const onStatus = (status: MobileConnectionStatus): void => {
        clearLegacy();
        this.lastStatus = status;
        for (const listener of this.statusListeners) listener(status);
        if (isTerminalMobileStatus(status.code)) {
          fail(MobileConnectionError.fromStatus(status));
          return;
        }
        if (status.code === 'ready') {
          this.ready = true;
          disarmTimeout();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (status.code === 'pairing-required') {
          const tokenId = this.options.pairingTokenId?.trim();
          if (!tokenId) {
            fail(MobileConnectionError.fromStatus(status));
            return;
          }
          this.send({ id: 'pair', kind: 'pair', payload: { tokenId } });
          return;
        }
        // pairing-pending: someone has to act on the desktop, so no deadline applies.
        disarmTimeout();
      };

      armTimeout();
      this.socket = this.options.connect({
        onConnect: () => {
          if (this.closed) return;
          this.stage = 'handshake';
          this.socket?.write(channel.nextHandshakeMessage());
        },
        onData: bytes => {
          if (this.closed) return;
          let records: Uint8Array[];
          try {
            records = assembler.push(bytes);
          } catch (error) {
            fail(new MobileConnectionError('protocol-error', 'The desktop sent a malformed record.', true, error instanceof Error ? error.message : String(error)));
            return;
          }
          for (const record of records) {
            if (this.closed) return;
            if (!channel.open) {
              try {
                channel.readHandshakeMessage(record);
              } catch (error) {
                fail(new MobileConnectionError(
                  'handshake-failed',
                  'The desktop’s identity did not match the host key this phone pinned. If the desktop reset its key, scan a new pairing invitation.',
                  false,
                  error instanceof Error ? error.message : String(error),
                ));
                return;
              }
              if (channel.open) {
                this.stage = 'session';
                const legacyMs = this.options.legacyReadyAfterMs ?? 3_000;
                if (legacyMs > 0) {
                  legacyTimer = setTimeout(() => {
                    if (this.closed || settled) return;
                    this.ready = true;
                    disarmTimeout();
                    settled = true;
                    resolve();
                  }, legacyMs);
                }
              }
              continue;
            }
            let frame: MobileServerFrame;
            try {
              frame = decode<MobileServerFrame>(channel.decrypt(record));
            } catch (error) {
              fail(new MobileConnectionError('protocol-error', 'A message from the desktop could not be decrypted.', true, error instanceof Error ? error.message : String(error)));
              return;
            }
            if (frame.kind === 'status') {
              onStatus(mobileConnectionStatus(frame.status.code, frame.status.message));
            } else if (frame.kind === 'event') {
              for (const listener of this.eventListeners) listener(frame.envelope);
            } else if (frame.kind === 'reply') {
              if (frame.id === 'pair') {
                if (!frame.ok) fail(new MobileConnectionError('invitation-invalid', frame.error || 'The desktop refused the pairing invitation.', false));
                continue;
              }
              const waiting = this.pending.get(frame.id);
              if (!waiting) continue;
              clearTimeout(waiting.timer);
              this.pending.delete(frame.id);
              if (frame.ok) waiting.resolve(frame.value);
              else waiting.reject(new MobileRequestError(frame.error || 'The desktop rejected the request.', frame.code));
            }
          }
        },
        onError: error => {
          fail(this.lastStatus && isTerminalMobileStatus(this.lastStatus.code)
            ? MobileConnectionError.fromStatus(this.lastStatus)
            : classifyMobileTransportFailure({ stage: this.stage, endpoint: this.options.endpoint, cause: error }));
        },
        onClose: () => {
          fail(this.lastStatus && isTerminalMobileStatus(this.lastStatus.code)
            ? MobileConnectionError.fromStatus(this.lastStatus)
            : classifyMobileTransportFailure({ stage: this.stage, endpoint: this.options.endpoint }));
        },
      });
    });
  }

  private send(frame: MobileRequestFrame): void {
    if (!this.socket || !this.channel?.open || this.closed) throw new MobileConnectionError('connection-lost', 'The Praxis desktop is not connected.', true);
    this.socket.write(this.channel.encrypt(encode(frame)));
  }

  private rejectPending(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  request<T>(kind: 'read' | 'command' | 'replay', payload: unknown): Promise<T> {
    if (!this.isReady) {
      return Promise.reject(new MobileConnectionError('connection-lost', 'The Praxis desktop is not connected.', true));
    }
    this.requestSequence += 1;
    const id = `m-${Date.now().toString(36)}-${this.requestSequence.toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MobileConnectionError('timed-out', 'The Praxis desktop did not answer in time.', true));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try {
        this.send({ id, kind, payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  read<T>(request: unknown): Promise<T> { return this.request<T>('read', request); }
  command<T>(command: unknown): Promise<T> { return this.request<T>('command', command); }
  /** Asks the desktop to stream every retained event after `afterSequence`. */
  replay(afterSequence: number): Promise<MobileReplayResult> { return this.request('replay', { afterSequence }); }

  /** Closes without notifying `onClose` listeners (the caller chose to close). */
  close(): void {
    const error = new MobileConnectionError('connection-lost', 'The connection was closed on this phone.', true);
    if (this.abandon) {
      this.abandon(error, false);
      return;
    }
    this.closed = true;
  }
}
