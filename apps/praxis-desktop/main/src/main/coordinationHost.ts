import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyCoordination,
  COORDINATION_SCHEMA_VERSION,
  emptyCoordinationState,
  scopedSnapshot,
  type CoordinationCommand,
  type CoordinationResult,
  type CoordinationState
} from '@praxis/core';

/**
 * The single local coordination broker (FX-BF-048 / TASK-392), host side. Electron-free so
 * it can be tested across real processes.
 *
 * One broker per OS user owns all state. The first process to create `broker.lock`
 * exclusively becomes the leader: it applies commands in order, persists the state
 * atomically to `agent.sessions.chat.json` *before* answering, and serves other processes
 * (a second app instance, a native hook adapter) over an authenticated local socket. Every
 * other process is a follower and sends its commands there.
 *
 * Two rules from the design are held strictly:
 * - **A lock is only taken over from a dead owner.** A lock whose recorded process is still
 *   alive is never removed, however old it looks.
 * - **Unreadable state is not an empty registry.** A snapshot that fails to parse is kept
 *   aside and the broker refuses grants until someone resets it, because guessing "nobody
 *   holds anything" is how two agents end up in the same file.
 *
 * On takeover, claims the previous broker recorded as executing become `recovery-required`
 * under the new epoch: their work may still be running.
 */

export const COORDINATION_FILE = 'agent.sessions.chat.json';
const LOCK_FILE = 'broker.lock';
const TOKEN_FILE = 'broker.token';

export interface CoordinationEndpoint {
  send(command: CoordinationCommand): Promise<CoordinationResult>;
  snapshot(sessionKey?: string, sinceSequence?: number): Promise<unknown>;
  close(): Promise<void>;
  readonly role: 'leader' | 'follower';
  /** Set while state could not be read: grants are refused until reset. */
  readonly blockedReason?: string;
}

/** The OS-user coordination root, shared by every Praxis profile; a test sets its own. */
export function defaultCoordinationRoot(): string {
  return process.env.PRAXIS_COORDINATION_ROOT || path.join(os.homedir(), '.praxis', 'coordination');
}

function socketPath(root: string): string {
  // Windows has no Unix sockets: a named pipe keyed by the root.
  if (process.platform === 'win32') return `\\\\.\\pipe\\praxis-coordination-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  // Unix socket paths are short-limited; the root is hashed into the temp dir when it is long.
  const direct = path.join(root, 'broker.sock');
  return direct.length < 100 ? direct : path.join(os.tmpdir(), `praxis-coord-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.sock`);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Writes JSON atomically: a unique temp file in the same directory, flushed, then renamed over. */
function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function readState(file: string, epoch: string): { state: CoordinationState; blockedReason?: string } {
  if (!fs.existsSync(file)) return { state: emptyCoordinationState(epoch) };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CoordinationState;
    if (raw?.schemaVersion !== COORDINATION_SCHEMA_VERSION || !Array.isArray(raw.claims) || !raw.sessions || typeof raw.sessions !== 'object') {
      throw new Error(`unexpected shape (schema ${raw?.schemaVersion})`);
    }
    // A new broker, a new epoch: whatever the last one saw executing may still be running.
    const claims = raw.claims.map(claim => (claim.state === 'executing' || claim.state === 'cleaning-up' ? { ...claim, state: 'recovery-required' as const } : claim));
    return {
      state: {
        ...raw,
        epoch,
        claims,
        waiters: [],
        sessions: Object.fromEntries(Object.entries(raw.sessions).map(([key, session]) => [key, session.state === 'ended' ? session : { ...session, state: 'stale' as const }]))
      }
    };
  } catch (error) {
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      fs.copyFileSync(file, aside);
    } catch {
      /* keep going: the refusal below is what matters */
    }
    return {
      state: emptyCoordinationState(epoch),
      blockedReason: `Coordination state could not be read (${error instanceof Error ? error.message : String(error)}); a copy is at ${aside}. No resources are granted until it is reset.`
    };
  }
}

type WirePayload = { op: 'send'; command: CoordinationCommand } | { op: 'snapshot'; sessionKey?: string; since?: number };
type Wire = WirePayload & { id: number; token: string };

class Leader implements CoordinationEndpoint {
  public readonly role = 'leader' as const;
  private state: CoordinationState;
  private queue: Promise<unknown> = Promise.resolve();
  private server?: net.Server;
  private ticker?: NodeJS.Timeout;
  public blockedReason?: string;
  private readonly onChange?: (state: CoordinationState) => void;

  constructor(private readonly root: string, private readonly token: string, epoch: string, options: { now?: () => number; onChange?: (state: CoordinationState) => void } = {}) {
    const loaded = readState(path.join(root, COORDINATION_FILE), epoch);
    this.state = loaded.state;
    this.blockedReason = loaded.blockedReason;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    if (!this.blockedReason) this.persist(this.state);
  }

  private readonly now: () => number;

  private persist(state: CoordinationState): void {
    writeAtomic(path.join(this.root, COORDINATION_FILE), state);
  }

  async listen(): Promise<void> {
    const where = socketPath(this.root);
    if (process.platform !== 'win32') fs.rmSync(where, { force: true });
    this.server = net.createServer(socket => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(where, () => resolve());
    });
    if (process.platform !== 'win32') fs.chmodSync(where, 0o600);
    // Leases and stale sessions are judged on the broker's clock, on a steady beat.
    this.ticker = setInterval(() => void this.send({ kind: 'tick' }), 15_000);
    this.ticker.unref?.();
  }

  private serve(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1_000_000) socket.destroy();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.answer(socket, line);
      }
    });
    socket.on('error', () => undefined);
  }

  private async answer(socket: net.Socket, line: string): Promise<void> {
    let message: Wire;
    try {
      message = JSON.parse(line) as Wire;
    } catch {
      return;
    }
    // Every request carries the token from the user-only token file: another user cannot speak to this broker.
    if (message.token !== this.token) {
      socket.write(`${JSON.stringify({ id: message.id, result: { ok: false, error: 'Not authorised.' } })}\n`);
      return;
    }
    const result = message.op === 'send' ? await this.send(message.command) : await this.snapshot(message.sessionKey, message.since);
    socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  send(command: CoordinationCommand): Promise<CoordinationResult> {
    const run = async (): Promise<CoordinationResult> => {
      if (this.blockedReason && (command.kind === 'acquire' || command.kind === 'start')) return { ok: false, error: this.blockedReason };
      const { state, result } = applyCoordination(this.state, command, this.now());
      if (state !== this.state) {
        // Persisted before the answer goes out: a grant nobody wrote down was never given.
        if (!this.blockedReason) this.persist(state);
        this.state = state;
        this.onChange?.(state);
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async snapshot(sessionKey?: string, since?: number): Promise<unknown> {
    return sessionKey ? scopedSnapshot(this.state, sessionKey, since) : this.state;
  }

  /** Clears an unreadable state (after a person looked at the copy) and starts granting again. */
  reset(): void {
    this.state = emptyCoordinationState(this.state.epoch);
    this.blockedReason = undefined;
    this.persist(this.state);
  }

  async close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.root, LOCK_FILE), 'utf8')) as { pid: number };
      if (lock.pid === process.pid) fs.rmSync(path.join(this.root, LOCK_FILE), { force: true });
    } catch {
      /* not ours, or already gone */
    }
  }
}

class Follower implements CoordinationEndpoint {
  public readonly role = 'follower' as const;
  private socket?: net.Socket;
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  constructor(private readonly root: string, private readonly token: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath(this.root), () => resolve());
      socket.once('error', reject);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const { id, result } = JSON.parse(line) as { id: number; result: unknown };
            this.pending.get(id)?.(result);
            this.pending.delete(id);
          } catch {
            /* ignore a malformed line */
          }
        }
      });
      socket.on('close', () => {
        // A lost broker is not a grant: every pending request is refused.
        for (const [, resolvePending] of this.pending) resolvePending({ ok: false, error: 'The coordination broker went away; nothing was granted.' });
        this.pending.clear();
      });
      this.socket = socket;
    });
  }

  private call(payload: WirePayload): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) return Promise.resolve({ ok: false, error: 'Not connected to the coordination broker; nothing was granted.' });
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.socket!.write(`${JSON.stringify({ ...payload, id, token: this.token })}\n`);
    });
  }

  send(command: CoordinationCommand): Promise<CoordinationResult> {
    return this.call({ op: 'send', command }) as Promise<CoordinationResult>;
  }

  snapshot(sessionKey?: string, since?: number): Promise<unknown> {
    return this.call({ op: 'snapshot', sessionKey, since });
  }

  async close(): Promise<void> {
    this.socket?.end();
  }
}

/**
 * Joins the coordination broker under `root`: becomes it if no live process holds the
 * lock, otherwise connects to the one that does.
 */
export async function joinCoordination(
  root = defaultCoordinationRoot(),
  options: { now?: () => number; onChange?: (state: CoordinationState) => void } = {}
): Promise<CoordinationEndpoint & { reset?: () => void }> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(root, TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) {
    try {
      fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      /* another process made it first */
    }
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const lockFile = path.join(root, LOCK_FILE);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const epoch = randomUUID();
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, epoch, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      const leader = new Leader(root, token, epoch, options);
      await leader.listen();
      return leader;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: { pid?: number } = {};
    try {
      holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {
      /* a lock mid-write: try again shortly */
    }
    if (holder.pid && processAlive(holder.pid)) {
      const follower = new Follower(root, token);
      try {
        await follower.connect();
        return follower;
      } catch {
        // Alive but not listening yet (it is still starting): wait and retry rather than take over.
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
    }
    if (holder.pid) {
      // Its recorded owner is dead: the lock is stale and may be replaced.
      fs.rmSync(lockFile, { force: true });
    } else {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Could not join the coordination broker at ${root}: another process holds it but does not answer.`);
}

const LOST = /went away|Not connected/;

/**
 * A coordination endpoint that survives its broker going away: a follower whose leader
 * died rejoins — becoming the leader itself if the lock's owner is dead — and retries the
 * request once. Nothing is ever reported granted that the broker did not grant.
 */
export class ResilientCoordination implements CoordinationEndpoint {
  private endpoint?: CoordinationEndpoint & { reset?: () => void };
  private joining?: Promise<CoordinationEndpoint & { reset?: () => void }>;

  constructor(
    private readonly root = defaultCoordinationRoot(),
    private readonly options: { now?: () => number; onChange?: (state: CoordinationState) => void } = {}
  ) {}

  get role(): 'leader' | 'follower' {
    return this.endpoint?.role ?? 'follower';
  }

  get blockedReason(): string | undefined {
    return this.endpoint?.blockedReason;
  }

  private async current(): Promise<CoordinationEndpoint & { reset?: () => void }> {
    if (this.endpoint) return this.endpoint;
    this.joining ??= joinCoordination(this.root, this.options).then(endpoint => {
      this.endpoint = endpoint;
      this.joining = undefined;
      return endpoint;
    }, error => {
      this.joining = undefined;
      throw error;
    });
    return this.joining;
  }

  async send(command: CoordinationCommand): Promise<CoordinationResult> {
    try {
      const result = await (await this.current()).send(command);
      if (result.ok || !LOST.test(result.error)) return result;
      await this.endpoint?.close().catch(() => undefined);
      this.endpoint = undefined;
      return await (await this.current()).send(command);
    } catch (error) {
      return { ok: false, error: `Coordination is unavailable (${error instanceof Error ? error.message : String(error)}); nothing was granted.` };
    }
  }

  async snapshot(sessionKey?: string, since?: number): Promise<unknown> {
    return (await this.current()).snapshot(sessionKey, since);
  }

  reset(): void {
    this.endpoint?.reset?.();
  }

  async close(): Promise<void> {
    await this.endpoint?.close();
    this.endpoint = undefined;
  }
}

/**
 * Connects to a running broker without ever becoming one — for a short-lived process such
 * as a native hook, whose exit would otherwise strand its claims. `undefined` when no broker
 * is running.
 */
export async function connectToCoordination(root = defaultCoordinationRoot()): Promise<CoordinationEndpoint | undefined> {
  const tokenFile = path.join(root, TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) return undefined;
  const follower = new Follower(root, fs.readFileSync(tokenFile, 'utf8').trim());
  try {
    await follower.connect();
    return follower;
  } catch {
    return undefined;
  }
}
