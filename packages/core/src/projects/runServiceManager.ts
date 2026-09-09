/**
 * Local process lifecycle for a project's Run profile (FX-BE-055 / TASK-144).
 *
 * Spawns each `RunServiceDefinition` as a real child process, waits for its
 * declared readiness probe (or a short settle window when none is declared)
 * before treating it as up, and starts dependents only once every service
 * they `dependsOn` is ready — a service whose dependency failed is marked
 * failed in turn and never spawned at all.
 *
 * Process termination uses `host/processTree.ts`'s shared "kill the whole
 * tree, not just the leader" helper: `detached: true` on POSIX makes each
 * child its own process group leader, torn down with `process.kill(-pid, …)`;
 * Windows has no process groups, so `taskkill /T` walks the tree instead.
 * Only a pid this instance itself spawned is ever touched — there is no code
 * path that accepts or guesses at a foreign pid.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as path from 'node:path';
import { checkHttpOk, checkTcpOpen } from '../host/networkProbe';
import { killProcessTree } from '../host/processTree';
import { validateRunProfile, type RunProfile, type RunServiceDefinition } from './runProfile';

export type RunServiceState = 'pending' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';

export interface RunServiceStatus {
  id: string;
  state: RunServiceState;
  pid?: number;
  startedAt?: string;
  readyAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface RunLogLine {
  serviceId: string;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

export interface StartRunOptions {
  /** A service's own `cwd` is repo-relative; resolved against this. */
  projectFolder: string;
  /** How long a service may take to satisfy its readiness probe (or settle, with none declared) before it is marked failed. Defaults to 30s. */
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
/** A probe-less service must stay alive this long to be considered ready — long enough to distinguish a real launch from an instant crash, short enough not to stall an otherwise-healthy run. */
const NO_PROBE_SETTLE_MS = 400;
const PROBE_POLL_INTERVAL_MS = 200;
const PROBE_CONNECT_TIMEOUT_MS = 1_000;

interface ManagedService {
  definition: RunServiceDefinition;
  status: RunServiceStatus;
  child?: ChildProcess;
}

export interface RunServiceManager {
  on(event: 'status', listener: (status: RunServiceStatus) => void): this;
  on(event: 'log', listener: (line: RunLogLine) => void): this;
  off(event: 'status' | 'log', listener: (...args: never[]) => void): this;
}

/**
 * Owns at most one active run at a time: `start` refuses to begin a second
 * run while one is already active, rather than losing track of a process
 * tree it already owns. Create a fresh instance per concurrent run (e.g.
 * one per project) instead of sharing one across projects.
 */
export class RunServiceManager extends EventEmitter {
  private services = new Map<string, ManagedService>();
  private stopped = true;
  /** The options `start()` was last called with — reused by `startService`/`restartService` so a single service can be relaunched with the same project folder and readiness timeout. */
  private runOptions: StartRunOptions | undefined;

  /** A snapshot of every tracked service's current status, in profile order. */
  public status(): RunServiceStatus[] {
    return [...this.services.values()].map(managed => ({ ...managed.status }));
  }

  public async start(profile: RunProfile, options: StartRunOptions): Promise<void> {
    if (!this.stopped) throw new Error('A run is already active; stop it before starting another.');
    const { valid, errors } = validateRunProfile(profile);
    if (!valid) {
      throw new Error(`Run profile is invalid: ${errors.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`);
    }

    this.stopped = false;
    this.runOptions = options;
    this.services = new Map(
      profile.services.map(definition => [definition.id, { definition, status: { id: definition.id, state: 'pending' as const } }])
    );

    // Validated profiles are acyclic (validateRunProfile's own DFS check), so
    // this topological order always terminates.
    const order = topoOrder(profile.services);
    const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const started = new Map<string, Promise<void>>();

    for (const id of order) {
      started.set(
        id,
        (async () => {
          const managed = this.services.get(id);
          if (!managed) return;
          const deps = managed.definition.dependsOn ?? [];
          if (deps.length > 0) {
            await Promise.all(deps.map(dep => started.get(dep)));
            const failedDep = deps.find(dep => this.services.get(dep)?.status.state === 'failed');
            if (failedDep) {
              this.setStatus(managed, { state: 'failed', error: `Dependency "${failedDep}" failed to become ready.` });
              return;
            }
          }
          if (this.stopped) return; // a stop() raced this start
          await this.startOne(managed, options.projectFolder, readinessTimeoutMs);
        })()
      );
    }
    await Promise.all(started.values());
  }

  /** Tears down every tracked process tree. Safe to call repeatedly — a second call while already stopped is a no-op, never a re-kill or an error. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([...this.services.values()].map(managed => this.stopOne(managed)));
  }

  /** Stops one service (Run controls' per-service Stop) without affecting the rest of the run. Dependents are left running — their own probe/health surfaces the resulting problem rather than this cascading a stop through the graph. */
  public async stopService(serviceId: string): Promise<void> {
    const managed = this.requireService(serviceId);
    await this.stopOne(managed);
  }

  /**
   * (Re)starts one currently-stopped/failed service in an active run, reusing
   * the `projectFolder`/`readinessTimeoutMs` the run itself was started with.
   * Refuses when the service's own dependencies are not currently `ready` —
   * unlike the bulk fan-out in `start()`, a direct per-service action gets a
   * clear rejection rather than being silently marked failed on its behalf.
   */
  public async startService(serviceId: string): Promise<void> {
    if (this.stopped || !this.runOptions) throw new Error('No run is active; call start() first.');
    const managed = this.requireService(serviceId);
    const notReady = (managed.definition.dependsOn ?? []).filter(dep => this.services.get(dep)?.status.state !== 'ready');
    if (notReady.length > 0) {
      throw new Error(`Cannot start "${serviceId}": dependency ${notReady.map(id => `"${id}"`).join(', ')} is not ready.`);
    }
    await this.startOne(managed, this.runOptions.projectFolder, this.runOptions.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  }

  /** Stop then start one service — Run controls' per-service Restart. */
  public async restartService(serviceId: string): Promise<void> {
    await this.stopService(serviceId);
    await this.startService(serviceId);
  }

  private requireService(serviceId: string): ManagedService {
    const managed = this.services.get(serviceId);
    if (!managed) throw new Error(`Unknown service "${serviceId}".`);
    return managed;
  }

  private setStatus(managed: ManagedService, patch: Partial<RunServiceStatus>): void {
    managed.status = { ...managed.status, ...patch };
    this.emit('status', { ...managed.status });
  }

  private startOne(managed: ManagedService, projectFolder: string, readinessTimeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      void (async () => {
        const { definition } = managed;

        const preflight = preflightIssue(definition);
        if (preflight) {
          this.setStatus(managed, { state: 'failed', error: preflight });
          resolve();
          return;
        }

        if (definition.port !== undefined && !(await isPortAvailable(definition.port))) {
          this.setStatus(managed, { state: 'failed', error: `Port ${definition.port} is already in use.` });
          resolve();
          return;
        }

        if (this.stopped) {
          resolve();
          return;
        }

        this.setStatus(managed, { state: 'starting', startedAt: new Date().toISOString() });
        const cwd = definition.cwd ? path.join(projectFolder, definition.cwd) : projectFolder;
        const child = spawn(definition.executable, definition.args ?? [], {
          cwd,
          shell: false,
          detached: process.platform !== 'win32',
          env: { ...process.env, ...(definition.env ?? {}) }
        });
        managed.child = child;

        let settled = false;
        let pollHandle: NodeJS.Timeout | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let settleHandle: NodeJS.Timeout | undefined;
        const clearTimers = (): void => {
          if (pollHandle) clearInterval(pollHandle);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (settleHandle) clearTimeout(settleHandle);
        };

        const finishReady = (): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          this.setStatus(managed, { state: 'ready', pid: child.pid, readyAt: new Date().toISOString() });
          resolve();
        };
        const finishFailed = (error: string, exitCode?: number | null, signal?: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          this.setStatus(managed, { state: 'failed', error, exitCode: exitCode ?? undefined, signal: signal ?? undefined });
          resolve();
        };

        child.once('spawn', () => {
          managed.status.pid = child.pid;
        });
        child.once('error', error => finishFailed(`Could not start ${definition.executable}: ${error.message}`));
        child.once('exit', (code, signal) => {
          managed.child = undefined;
          if (!settled) {
            finishFailed(`${definition.name} exited before it became ready (code ${code ?? 'null'}).`, code, signal);
          } else if (!this.stopped && managed.status.state === 'ready') {
            this.setStatus(managed, { state: 'failed', error: `${definition.name} exited unexpectedly.`, exitCode: code, signal });
          }
        });

        const collect = (streamName: 'stdout' | 'stderr') => (chunk: Buffer): void => {
          for (const line of chunk.toString().split(/\r?\n/)) {
            if (!line) continue;
            this.emit('log', { serviceId: definition.id, stream: streamName, text: line, at: new Date().toISOString() } satisfies RunLogLine);
            if (!settled && definition.readinessProbe?.kind === 'log-line' && line.includes(definition.readinessProbe.match)) {
              finishReady();
            }
          }
        };
        child.stdout?.on('data', collect('stdout'));
        child.stderr?.on('data', collect('stderr'));

        timeoutHandle = setTimeout(() => {
          finishFailed(`Readiness timed out after ${readinessTimeoutMs}ms.`);
          void killProcessTree(child, false);
        }, readinessTimeoutMs);

        const probe = definition.readinessProbe;
        if (!probe) {
          settleHandle = setTimeout(finishReady, NO_PROBE_SETTLE_MS);
        } else if (probe.kind === 'tcp') {
          pollHandle = setInterval(() => {
            void checkTcp(probe.port).then(ok => ok && finishReady());
          }, PROBE_POLL_INTERVAL_MS);
        } else if (probe.kind === 'http') {
          // preflightIssue already guaranteed definition.port is set for an http probe.
          pollHandle = setInterval(() => {
            void checkHttp(definition.port!, probe.path, probe.expectedStatus).then(ok => ok && finishReady());
          }, PROBE_POLL_INTERVAL_MS);
        }
        // A log-line probe is checked inline as stdout/stderr arrive, above.
      })();
    });
  }

  private async stopOne(managed: ManagedService): Promise<void> {
    if (managed.status.state === 'failed' || managed.status.state === 'stopped') return;
    const child = managed.child;
    if (!child?.pid) {
      this.setStatus(managed, { state: 'stopped' });
      return;
    }
    this.setStatus(managed, { state: 'stopping' });
    await new Promise<void>(resolve => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceTimer);
        resolve();
      };
      child.once('exit', finish);
      void killProcessTree(child, false);
      const forceTimer = setTimeout(() => void killProcessTree(child, true), 3_000);
    });
    managed.child = undefined;
    this.setStatus(managed, { state: 'stopped' });
  }
}

/** Catches a schema gap `validateRunProfile` doesn't (yet) enforce: an http probe has no base URL of its own — it needs the service's own `port`. Checked before anything is spawned. */
function preflightIssue(definition: RunServiceDefinition): string | undefined {
  if (definition.readinessProbe?.kind === 'http' && definition.port === undefined) {
    return 'An http readiness probe requires the service to declare a port.';
  }
  return undefined;
}

/** DFS emitting each service after its dependencies — assumes an already-validated, acyclic profile. */
function topoOrder(services: RunServiceDefinition[]): string[] {
  const byId = new Map(services.map(service => [service.id, service]));
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep);
    }
    order.push(id);
  };
  for (const service of services) visit(service.id);
  return order;
}

/** Binds a throwaway server on the port to prove nothing else already holds it — the same failure mode the real service's own bind would hit. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

function checkTcp(port: number): Promise<boolean> {
  return checkTcpOpen('127.0.0.1', port, PROBE_CONNECT_TIMEOUT_MS);
}

function checkHttp(port: number, probePath: string, expectedStatus?: number): Promise<boolean> {
  return checkHttpOk('127.0.0.1', port, probePath, expectedStatus, PROBE_CONNECT_TIMEOUT_MS);
}

