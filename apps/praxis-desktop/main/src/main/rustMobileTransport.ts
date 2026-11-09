import * as os from 'node:os';
import {
  handleMobileCommand,
  handleMobileRead,
  type MobileAccessPolicy,
  type MobileCommand,
  type MobileReadRequest,
  type RustRpcResponse,
} from '@praxis/core';
import { mobileConnectionStatus, type MobileConnectionStatus } from '@praxis/mobile-protocol';
import type { MobileLanAuthorizedPeer, MobileLanServerDeps } from './mobileLanServer';
import type { MobileRelayClientOptions, MobileRelayState } from './mobileRelayClient';
import type { MobileListenerTransport, MobileRelayTransport } from './mobileTransport';
import { StdioRustHostTransport, RustHostRpcError, type RustHostTransport, type StdioRustHostOptions } from './rustHostBridge';

interface ListenerSnapshot {
  listening: boolean;
  port?: number | null;
  addresses: string[];
  bindError?: string | null;
  connectionCount: number;
  relay?: RelaySnapshot;
}

interface RelaySnapshot { state: MobileRelayState; channel?: string | null; error?: string | null }

export interface RustMobileTransportOptions {
  host: Omit<StdioRustHostOptions, 'onCall'>;
  /** Trusted OS inventory; injectable for loopback integration tests. */
  interfaces?: () => Array<{ interfaceName: string; address: string }>;
  createTransport?: (options: StdioRustHostOptions) => RustHostTransport;
  requestTimeoutMs?: number;
}

/** Noise/TCP/relay in Rust, with the existing desktop application's services in Electron. */
export class RustMobileTransport implements MobileListenerTransport {
  private readonly transport: RustHostTransport;
  private snapshot: ListenerSnapshot = { listening: false, addresses: [], connectionCount: 0 };
  private nextId = 0;
  private cursor = 0;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private eventFlush?: Promise<void>;
  private failure?: Error;
  private disposed = false;
  private relayState?: (snapshot: RelaySnapshot) => void;
  private readCalls = 0;
  private commandCalls = 0;

  constructor(private readonly deps: MobileLanServerDeps, private readonly options: RustMobileTransportOptions) {
    this.transport = (options.createTransport ?? (opts => new StdioRustHostTransport(opts)))({
      ...options.host,
      restartOnExit: false,
      onReady: status => {
        options.host.onReady?.(status);
        deps.onLog?.(`[mobile] Rust transport host ready: ${JSON.stringify(status)}`);
      },
      onCall: (method, params) => this.onCall(method, params),
    });
  }

  get listening(): boolean { return this.snapshot.listening; }
  get port(): number | undefined { return this.snapshot.port ?? undefined; }
  get addresses(): readonly string[] { return this.snapshot.addresses; }
  get bindError(): string | undefined { return this.failure?.message ?? this.snapshot.bindError ?? undefined; }
  connectionCount(): number { return this.snapshot.connectionCount; }

  diagnostics() {
    return { mode: 'rust' as const, ...(this.transport instanceof StdioRustHostTransport ? this.transport.diagnostics() : {}),
      listening: this.listening, readCalls: this.readCalls, commandCalls: this.commandCalls };
  }

  private async invoke<T>(channel: string, params?: unknown): Promise<T> {
    if (this.disposed) throw new Error('Rust mobile transport is disposed.');
    if (this.failure) throw this.failure;
    let timer: NodeJS.Timeout | undefined;
    const response = await Promise.race([
      this.transport.dispatch({ id: `mobile-${++this.nextId}`, channel, args: params === undefined ? [] : [params] }),
      new Promise<RustRpcResponse>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Rust mobile control timed out: ${channel}`)), this.options.requestTimeoutMs ?? 10_000);
      }),
    ]).catch(error => {
      // Fail closed on transport loss; listener recreation must remain explicit.
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.snapshot = { listening: false, addresses: [], connectionCount: 0 };
      clearInterval(this.timer);
      this.timer = undefined;
      this.relayState?.({ state: 'error', error: this.failure.message });
      void Promise.resolve(this.transport.dispose()).catch(() => undefined);
      throw this.failure;
    }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new RustHostRpcError(channel, response.error ?? { code: 'MOBILE_BRIDGE_ERROR', message: 'Rust mobile call failed.' });
    return response.result as T;
  }

  private async onCall(method: string, params: unknown): Promise<unknown> {
    if (this.disposed || this.failure) throw new Error('Rust mobile transport is unavailable.');
    switch (method) {
      case 'mobile.read':
        this.readCalls++;
        return handleMobileRead(this.deps.app, params as MobileReadRequest);
      // One Electron ledger serves IPC and transport retries, including late completion.
      case 'mobile.command':
        this.commandCalls++;
        return handleMobileCommand(this.deps.app, params as MobileCommand);
      case 'mobile.authorizePeer': return this.deps.authorizePeer?.((params as { publicKey: string }).publicKey) ?? null;
      case 'mobile.unpairedPeer': {
        const { publicKey, tokenId } = params as { publicKey: string; tokenId?: string | null };
        return this.deps.onUnpairedPeer?.(publicKey, tokenId ?? undefined) ?? mobileConnectionStatus('access-denied');
      }
      case 'mobile.relayState': this.relayState?.(params as RelaySnapshot); return null;
      default: throw new Error(`Unknown mobile host call: ${method}`);
    }
  }

  private keyParams() {
    return { hostPrivateKey: Buffer.from(this.deps.hostStaticKey.privateKey).toString('hex'), ...(this.deps.pairingCode ? { pairingCode: this.deps.pairingCode } : {}) };
  }

  private flushEvents(): Promise<void> {
    if (!this.eventFlush) {
      this.eventFlush = this.copyEvents().finally(() => { this.eventFlush = undefined; });
    }
    return this.eventFlush;
  }

  private async copyEvents(): Promise<void> {
    const through = this.deps.app.ledger.latestSequence();
    while (this.cursor < through) {
      const events = this.deps.app.ledger.replay(this.cursor, 100);
      if (!events.length) break;
      for (const event of events) {
        await this.invoke('mobile:appendEvent', event);
        this.cursor = event.sequence;
      }
    }
  }

  private beginPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = this.refresh().catch(error => {
        this.deps.onLog?.(`[mobile] Rust transport refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { this.polling = undefined; });
    }, 100);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    await this.flushEvents();
    this.snapshot = await this.invoke<ListenerSnapshot>('mobile:status');
    if (this.snapshot.relay) this.relayState?.(this.snapshot.relay);
  }

  async start(port: number, policy: MobileAccessPolicy): Promise<void> {
    await this.polling;
    await this.flushEvents();
    const addresses = this.options.interfaces?.() ?? Object.entries(os.networkInterfaces()).flatMap(([interfaceName, entries]) =>
      (entries ?? []).filter(entry => !entry.address.includes('%') && !entry.address.startsWith('fe80:')).map(entry => ({ interfaceName, address: entry.address })));
    try {
      this.snapshot = await this.invoke<ListenerSnapshot>('mobile:start', { port, policy, addresses, ...this.keyParams() });
      this.deps.onLog?.(`[mobile] Rust transport listening on ${this.port} (${policy.mode}).`);
      this.beginPolling();
    } catch (error) {
      this.snapshot = { listening: false, addresses: [], connectionCount: 0, bindError: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.relayState) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.polling;
    this.snapshot = await this.invoke<ListenerSnapshot>('mobile:stop');
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.disposed = true;
    await this.transport.dispose();
    await this.polling;
    this.snapshot = { listening: false, addresses: [], connectionCount: 0 };
  }

  async applyPolicy(policy: MobileAccessPolicy, dropConnections: boolean): Promise<void> {
    await this.invoke('mobile:applyPolicy', { policy, dropConnections });
  }
  async dropAll(status = mobileConnectionStatus('host-shutdown')): Promise<void> {
    await this.invoke('mobile:dropAll', { status });
  }
  async dropDevice(deviceId: string, status = mobileConnectionStatus('device-revoked')): Promise<number> {
    return this.invoke<number>('mobile:dropDevice', { deviceId, status });
  }
  async dropPublicKey(publicKey: string, status = mobileConnectionStatus('pairing-rejected')): Promise<number> {
    return this.invoke<number>('mobile:dropPublicKey', { publicKey, status });
  }
  async promotePending(publicKey: string, grant: MobileLanAuthorizedPeer): Promise<void> {
    await this.invoke('mobile:promote', { publicKey, grant });
  }

  createRelay(options: Omit<MobileRelayClientOptions, 'onStream'>): MobileRelayTransport {
    let snapshot: RelaySnapshot = { state: 'stopped' };
    const receive = (value: RelaySnapshot) => {
      const changed = snapshot.state !== value.state || snapshot.channel !== value.channel || snapshot.error !== value.error;
      snapshot = value;
      if (changed) {
        options.onLog?.(`[mobile] Rust relay ${value.state}.`);
        options.onStateChange?.();
      }
    };
    return {
      get state() { return snapshot.state; },
      get channel() { return snapshot.channel ?? undefined; },
      get error() { return snapshot.error ?? undefined; },
      start: async () => {
        this.relayState = receive;
        await this.polling;
        await this.flushEvents();
        const state = await this.invoke<RelaySnapshot>('mobile:relayStart', {
          relayUrl: options.relayUrl,
          relaySigningKey: options.identity.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
          ...this.keyParams(),
        });
        receive(state);
        this.beginPolling();
      },
      stop: async () => {
        this.relayState = undefined;
        receive(await this.invoke<RelaySnapshot>('mobile:relayStop'));
        if (!this.listening) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    };
  }
}
