import { broadcastToAllWindows } from './windowBroadcast';
import {
  PreviewAccessRegistry,
  RUN_STATE_SCHEMA_VERSION,
  RunServiceManager,
  clearRunState,
  reconcileRunState,
  readRunState,
  writeRunState,
  type PersistedRunState,
  type ReconciledService,
  type RunLogLine,
  type RunProfile,
  type RunServiceStatus
} from '@praxis/core';
import { runStateStorageRoot } from './runStateStorage';

/**
 * Per-project `RunServiceManager` registry (FX-BE-055 / TASK-146) — the
 * piece TASK-144's manager and TASK-145's origin-grant registry were built
 * without: something that actually owns one manager per project, persists
 * its status to survive a relaunch, and grants/revokes preview access as
 * services come up and go down.
 *
 * At most one active run per project — the same "one run at a time" rule
 * `RunServiceManager` itself enforces, just keyed here across projects.
 */

interface ProjectRun {
  manager: RunServiceManager;
  runId: string;
  startedAt: string;
  profile: RunProfile;
}

const runs = new Map<string, ProjectRun>();

/** Shared with `previewBrowser.ts` — the one registry every preview navigation is checked against. */
export const previewAccess = new PreviewAccessRegistry();

function broadcast(channel: string, ...args: unknown[]): void {
  broadcastToAllWindows(channel, ...args);
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persist(projectId: string, entry: ProjectRun): Promise<void> {
  const state: PersistedRunState = {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    projectId,
    runId: entry.runId,
    startedAt: entry.startedAt,
    services: entry.manager.status().map(status => ({ serviceId: status.id, pid: status.pid, state: status.state, startedAt: status.startedAt }))
  };
  await writeRunState(runStateStorageRoot(), state);
}

function requireRun(projectId: string): ProjectRun {
  const entry = runs.get(projectId);
  if (!entry) throw new Error('No run is active for this project.');
  return entry;
}

export interface StartProjectRunOptions {
  projectId: string;
  projectFolder: string;
  profile: RunProfile;
  readinessTimeoutMs?: number;
}

export async function startProjectRun(options: StartProjectRunOptions): Promise<void> {
  if (runs.has(options.projectId)) throw new Error('A run is already active for this project; stop it before starting another.');

  const manager = new RunServiceManager();
  const entry: ProjectRun = { manager, runId: newRunId(), startedAt: new Date().toISOString(), profile: options.profile };
  runs.set(options.projectId, entry);

  manager.on('status', (status: RunServiceStatus) => {
    broadcast('runs:statusChanged', options.projectId, status);
    void persist(options.projectId, entry);
    if (status.state === 'ready') {
      const service = options.profile.services.find(s => s.id === status.id);
      if (service?.port !== undefined) {
        try {
          previewAccess.grant(options.projectId, entry.runId, status.id, `http://127.0.0.1:${service.port}`);
        } catch {
          // Not a private/loopback origin somehow — nothing to grant, nothing to preview.
        }
      }
    }
  });
  manager.on('log', (line: RunLogLine) => broadcast('runs:log', options.projectId, line));

  try {
    await manager.start(options.profile, { projectFolder: options.projectFolder, readinessTimeoutMs: options.readinessTimeoutMs });
  } catch (error) {
    runs.delete(options.projectId);
    previewAccess.revokeRun(options.projectId, entry.runId);
    throw error;
  }
}

/**
 * Stops the whole run, revokes every preview grant it held, and clears its
 * persisted state — a clean, deliberate closure. Each service's own
 * `runs:statusChanged` broadcast (state `stopped`) already fires from the
 * `manager.on('status', …)` listener registered in `startProjectRun` as
 * `manager.stop()` tears each one down; nothing extra is broadcast here.
 */
export async function stopProjectRun(projectId: string): Promise<void> {
  const entry = runs.get(projectId);
  if (!entry) return;
  await entry.manager.stop();
  previewAccess.revokeRun(projectId, entry.runId);
  runs.delete(projectId);
  await clearRunState(runStateStorageRoot(), projectId);
}

export function projectRunStatus(projectId: string): RunServiceStatus[] {
  return runs.get(projectId)?.manager.status() ?? [];
}

export async function stopProjectRunService(projectId: string, serviceId: string): Promise<void> {
  await requireRun(projectId).manager.stopService(serviceId);
}

export async function startProjectRunService(projectId: string, serviceId: string): Promise<void> {
  await requireRun(projectId).manager.startService(serviceId);
}

export async function restartProjectRunService(projectId: string, serviceId: string): Promise<void> {
  await requireRun(projectId).manager.restartService(serviceId);
}

/**
 * Conservative post-restart reconciliation (TASK-146's other half). Only
 * meaningful for a project with no in-memory manager already owning it this
 * session — once `startProjectRun` has run, `projectRunStatus` is the live
 * truth and there is nothing stale to reconcile. A record that reconciles
 * to entirely `stopped-while-closed` is cleared; anything `unknown-running`
 * is left on disk (and returned) for the user to see and act on.
 */
export async function reconcileProjectRun(projectId: string): Promise<ReconciledService[]> {
  if (runs.has(projectId)) return [];
  const persisted = await readRunState(runStateStorageRoot(), projectId);
  if (!persisted) return [];
  const reconciled = reconcileRunState(persisted);
  if (reconciled.every(service => service.state === 'stopped-while-closed')) {
    await clearRunState(runStateStorageRoot(), projectId);
  }
  return reconciled;
}

/** Test/reset seam — no production caller needs this; a real relaunch is a fresh process with an empty `runs` map for free. */
export function resetRunManagerRegistry(): void {
  runs.clear();
  previewAccess.revokeAll();
}
