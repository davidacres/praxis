import { selectRustHostBinary } from './rustHostSelection';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  RustEventEnvelope,
  RustHostStatus,
  RustRpcError,
  RustRpcRequest,
  RustRpcResponse
} from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { broadcastToAllWindows, broadcastToWindows } from './windowBroadcast';

/**
 * Channels where `preload/index.ts` expects multiple positional arguments after `event`
 * (`(_event, projectId, status)` / `(_event, projectId, line)`) rather than a single payload.
 */
const MULTI_ARG_EVENT_CHANNELS = new Set<string>(['runs:statusChanged', 'runs:log']);

/** Wire frame emitted on stdout by `praxis-host --stdio`. */
type HostWireFrame =
  | { kind: 'ready'; status: RustHostStatus; registeredChannels: string[] }
  | { kind: 'response'; envelope: RustRpcResponse }
  | { kind: 'event'; envelope: RustEventEnvelope };

/** Error thrown when a Rust host RPC invocation returns `ok: false`. */
export class RustHostRpcError extends Error {
  readonly code: string;
  readonly channel: string;

  constructor(channel: string, error: RustRpcError) {
    super(error.message);
    this.name = 'RustHostRpcError';
    this.code = error.code;
    this.channel = channel;
  }
}

/** Pluggable transport backing [`RustHostBridge`] (N-API in-process, stdio daemon, or test double). */
export interface RustHostTransport {
  start?(): Promise<void>;
  dispatch(request: RustRpcRequest): Promise<RustRpcResponse>;
  onEvent(listener: (envelope: RustEventEnvelope) => void): () => void;
  registeredChannels?(): readonly string[];
  dispose(): Promise<void> | void;
}

export interface StdioRustHostOptions {
  /** Explicit path to the `praxis-host` executable. Resolved automatically when omitted. */
  executablePath?: string;
  /** Isolated Electron/test `userData` directory (`--user-data-dir`). */
  userDataDir: string;
  /** Shared or isolated per-test `settings.json` path (`--settings-path`). */
  settingsPath: string;
  /** Whether `--demo` fixtures are enabled. */
  demoMode?: boolean;
  /** Whether `PRAXIS_E2E=1` test mode is active. */
  e2eMode?: boolean;
  /** Extra environment variables passed to the child process. */
  env?: Record<string, string | undefined>;
  /** Startup handshake timeout in milliseconds (defaults to 10,000ms). */
  startupTimeoutMs?: number;
  onReady?: (status: RustHostStatus) => void;
}

/** Resolves an explicit override or the newest local Cargo binary (release wins ties). */
export function resolveRustHostBinaryPath(): string {
  return selectRustHostBinary(path.resolve(__dirname, '../../../../..'));
}

/** Returns `true` if a compiled `praxis-host` binary is discoverable on this system. */
export function hasRustHostBinary(): boolean {
  try {
    resolveRustHostBinaryPath();
    return true;
  } catch {
    return false;
  }
}

/**
 * Persistent NDJSON stdio transport talking to `crates/praxis-host` (`praxis-host --stdio`).
 * Works identically under Electron and plain Node (`node --test`) without N-API ABI coupling.
 */
export class StdioRustHostTransport implements RustHostTransport {
  private readonly options: StdioRustHostOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readlineInterface: readline.Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private readyStatus: RustHostStatus | undefined;
  private channels: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (res: RustRpcResponse) => void; reject: (err: Error) => void }
  >();
  private readonly eventListeners = new Set<(envelope: RustEventEnvelope) => void>();

  constructor(options: StdioRustHostOptions) {
    this.options = options;
  }

  get status(): RustHostStatus | undefined {
    return this.readyStatus;
  }

  registeredChannels(): readonly string[] {
    return this.channels;
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const exe = this.options.executablePath ?? resolveRustHostBinaryPath();
      const args = [
        '--stdio',
        `--user-data-dir=${this.options.userDataDir}`,
        `--settings-path=${this.options.settingsPath}`,
        ...(this.options.demoMode ? ['--demo'] : [])
      ];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...this.options.env,
        PRAXIS_USER_DATA_DIR: this.options.userDataDir,
        PRAXIS_SETTINGS_PATH: this.options.settingsPath,
        ...(this.options.e2eMode ? { PRAXIS_E2E: '1' } : {})
      };

      const child = spawn(exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env
      });
      this.child = child;

      const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timed out waiting for praxis-host ready frame after ${timeoutMs}ms.`));
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      const rl = readline.createInterface({ input: child.stdout });
      this.readlineInterface = rl;

      rl.on('line', line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let frame: HostWireFrame;
        try {
          frame = JSON.parse(trimmed) as HostWireFrame;
        } catch {
          return;
        }
        if (frame.kind === 'ready') {
          this.readyStatus = frame.status;
          this.channels = frame.registeredChannels ?? [];
          this.options.onReady?.(frame.status);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (frame.kind === 'response') {
          const entry = this.pending.get(frame.envelope.id);
          if (entry) {
            this.pending.delete(frame.envelope.id);
            entry.resolve(frame.envelope);
          }
          return;
        }
        if (frame.kind === 'event') {
          for (const listener of this.eventListeners) {
            listener(frame.envelope);
          }
        }
      });

      child.once('error', err => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        if (this.child === child) {
          this.resetExitedTransport();
          this.failPending(err instanceof Error ? err : new Error(String(err)));
        }
      });

      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const exitError = new Error(
          `praxis-host exited unexpectedly (code=${String(code)}, signal=${String(signal)})`
        );
        if (!settled) {
          settled = true;
          reject(exitError);
        }
        if (this.child === child) {
          this.resetExitedTransport();
          this.failPending(exitError);
        }
      });
    });

    return this.startPromise;
  }

  async dispatch(request: RustRpcRequest): Promise<RustRpcResponse> {
    await this.start();
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error('praxis-host process is not running.');
    }
    return new Promise<RustRpcResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      const line = `${JSON.stringify(request)}\n`;
      child.stdin.write(line, err => {
        if (err) {
          this.pending.delete(request.id);
          reject(err);
        }
      });
    });
  }

  onEvent(listener: (envelope: RustEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.readlineInterface?.close();
    this.readlineInterface = undefined;
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.failPending(new Error('RustHostTransport disposed.'));
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>(resolve => {
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }

  private resetExitedTransport(): void {
    this.readlineInterface?.close();
    this.readlineInterface = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    this.readyStatus = undefined;
    this.channels = [];
  }

  private failPending(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Broadcasts a Rust-emitted [`RustEventEnvelope`] to all live `BrowserWindow`s (including
 * `mainWindow` and any popped-out detached chat windows), preserving `preload/index.ts`
 * argument conventions.
 */
export function broadcastRustEventToWindows(
  envelope: RustEventEnvelope,
  windows?: readonly BrowserWindow[]
): void {
  const dispatch = windows
    ? (channel: string, ...args: unknown[]) => broadcastToWindows(windows, channel, ...args)
    : (channel: string, ...args: unknown[]) => broadcastToAllWindows(channel, ...args);

  if (MULTI_ARG_EVENT_CHANNELS.has(envelope.channel) && Array.isArray(envelope.payload)) {
    dispatch(envelope.channel, ...envelope.payload);
    return;
  }
  if (envelope.payload === undefined) {
    dispatch(envelope.channel);
    return;
  }
  dispatch(envelope.channel, envelope.payload);
}

export interface RustHostDiagnostics {
  mode: 'rust' | 'typescript';
  reason: string;
  binaryPath?: string;
  delegatedChannelCount: number;
}

export interface RustHostBridgeOptions {
  diagnostics?: RustHostDiagnostics;
  transport: RustHostTransport;
  /**
   * Optional custom window resolver used when forwarding `RustEventEnvelope` notifications.
   * Defaults to `BrowserWindow.getAllWindows()` via `broadcastToAllWindows`.
   */
  getWindows?: () => readonly BrowserWindow[];
  /** Channels initially routed to the Rust host instead of TypeScript fallback handlers. */
  migratedChannels?: Iterable<string>;
}

/**
 * Coordinates IPC channel delegation from Electron's `trustedIpcMain` to `crates/praxis-host`
 * and forwards Rust-emitted events to `mainWindow` and detached chat windows.
 */
export class RustHostBridge {
  private readonly transport: RustHostTransport;
  private readonly getWindows: (() => readonly BrowserWindow[]) | undefined;
  private readonly migrated = new Set<string>();
  private readonly eventListeners = new Set<(envelope: RustEventEnvelope) => void>();
  private readonly unsubscribeTransport: () => void;
  private nextRequestId = 1;
  private readonly diagnostics: RustHostDiagnostics | undefined;

  constructor(options: RustHostBridgeOptions) {
    this.transport = options.transport;
    this.diagnostics = options.diagnostics;
    this.getWindows = options.getWindows;
    for (const channel of options.migratedChannels ?? []) {
      this.migrated.add(channel);
    }
    this.unsubscribeTransport = this.transport.onEvent(envelope => {
      broadcastRustEventToWindows(envelope, this.getWindows?.());
      for (const listener of this.eventListeners) {
        listener(envelope);
      }
    });
  }

  /** Starts the underlying Rust host transport if not already started. */
  async start(): Promise<void> {
    await this.transport.start?.();
  }

  /** Marks `channel` as migrated so `handleOrFallback` delegates it to the Rust host. */
  markChannelMigrated(channel: string): void {
    this.migrated.add(channel);
  }

  /** Reverts `channel` back to its TypeScript fallback handler. */
  unmarkChannelMigrated(channel: string): void {
    this.migrated.delete(channel);
  }

  /** Returns `true` if `channel` is currently routed to the Rust host. */
  isChannelMigrated(channel: string): boolean {
    return this.migrated.has(channel);
  }

  /** Returns the sorted list of channels currently marked as migrated to Rust. */
  migratedChannels(): string[] {
    return [...this.migrated].sort();
  }

  /** Invokes `channel` on the Rust host and unwraps the result or throws [`RustHostRpcError`]. */
  async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (channel === 'host:status' && this.diagnostics?.mode === 'typescript') {
      return { delegation: this.diagnostics } as T;
    }
    const id = `rpc-${this.nextRequestId++}`;
    const response = await this.transport.dispatch({
      id,
      channel,
      args
    });
    if (!response.ok) {
      throw new RustHostRpcError(
        channel,
        response.error ?? {
          code: 'UNKNOWN_RUST_HOST_ERROR',
          message: `Rust host call to '${channel}' failed without an error payload.`
        }
      );
    }
    if (channel === 'host:status' && this.diagnostics) {
      return { ...(response.result as object), delegation: this.diagnostics } as T;
    }
    return response.result as T;
  }

  /** Subscribes to all domain events emitted by the Rust host. */
  onEvent(listener: (envelope: RustEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Seeds `safeStorage`-unlocked secrets from Electron into `crates/praxis-host`'s in-memory
   * `HostSecretStore` so migrated Rust services can use them without calling Electron APIs.
   */
  async syncSecrets(entries: Record<string, string>): Promise<number> {
    return this.invoke<number>('host:secrets:seed', entries);
  }

  /**
   * Registers a privileged IPC channel on `trustedIpcMain` that automatically delegates to
   * `crates/praxis-host` when `isChannelMigrated(channel)` is true, or runs `fallback` otherwise.
   *
   * Sender verification (`isOwnRendererSender`) is enforced by `trustedIpcMain` before either path runs.
   */
  handleOrFallback<TArgs extends any[] = any[], TResult = any>(
    channel: string,
    fallback: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
    ipcTarget: Pick<IpcMain, 'handle'> = ipcMain
  ): void {
    ipcTarget.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (this.migrated.has(channel)) {
        try {
          return await this.invoke<TResult>(channel, ...args);
        } catch (error) {
          // Transport failure may follow a completed mutation. Never replay it in TS.
          if (!(error instanceof RustHostRpcError) || error.code !== 'CHANNEL_NOT_REGISTERED') {
            throw error;
          }
          console.warn(
            `[rustHostBridge] Falling back to TypeScript for channel '${channel}':`,
            error
          );
          return fallback(event, ...(args as TArgs));
        }
      }
      return fallback(event, ...(args as TArgs));
    });
  }

  /**
   * Marks `channels` as migrated and binds each directly on `trustedIpcMain` to `this.invoke`.
   */
  registerChannels(
    channels: readonly string[],
    ipcTarget: Pick<IpcMain, 'handle'> = ipcMain
  ): void {
    for (const channel of channels) {
      this.migrated.add(channel);
      ipcTarget.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
        this.invoke(channel, ...args)
      );
    }
  }

  /** Shuts down the underlying transport and removes event listeners. */
  async dispose(): Promise<void> {
    this.unsubscribeTransport();
    this.eventListeners.clear();
    await this.transport.dispose();
  }
}
