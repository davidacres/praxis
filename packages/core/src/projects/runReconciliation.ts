/**
 * Run-state persistence and conservative post-restart reconciliation
 * (FX-BE-055 / TASK-146).
 *
 * `RunServiceManager` (TASK-144) is purely in-memory — its `ChildProcess`
 * handles, and everything that depends on them (live log streaming, a clean
 * stop), are gone the moment the Electron process that owned it exits. A
 * managed service's own OS process is not: `npm run dev` doesn't stop just
 * because Praxis did. On the next launch, Praxis only knows a project *had*
 * services running, by pid, from whatever it last persisted — it has no
 * `ChildProcess` to reattach to and no way to re-verify what "ready" ever
 * meant for that process (a probe can't tell if this pid is the same
 * program versus a different process the OS happened to reuse the number
 * for). So reconciliation only ever answers one question, conservatively:
 * is a process with this pid still alive? If yes, the honest label is
 * `unknown` — Praxis cannot claim `ready` or stream its logs, only that
 * *something* is still running there and a person should look. If no, the
 * record is stale and can be cleared. Nothing is ever auto-restarted here.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const RUN_STATE_SCHEMA_VERSION = 1;

export interface PersistedRunServiceRecord {
  serviceId: string;
  pid?: number;
  /** The service's state as last observed before persistence — 'ready' or 'starting' are the only ones worth reconciling; a 'stopped'/'failed' record with no pid is cleared. */
  state: string;
  startedAt?: string;
}

export interface PersistedRunState {
  schemaVersion: number;
  projectId: string;
  runId: string;
  startedAt: string;
  services: PersistedRunServiceRecord[];
}

/** One service's status after comparing its persisted record against the current OS process table. */
export type ReconciledServiceState = 'unknown-running' | 'stopped-while-closed';

export interface ReconciledService {
  serviceId: string;
  pid?: number;
  state: ReconciledServiceState;
}

const RUN_STATE_FILE_NAME = 'run-state.json';

function stateFilePath(storageRoot: string, projectId: string): string {
  return path.join(storageRoot, projectId, RUN_STATE_FILE_NAME);
}

/** Overwrites (never appends) the persisted run-state record for one project. */
export async function writeRunState(storageRoot: string, state: PersistedRunState): Promise<void> {
  const filePath = stateFilePath(storageRoot, state.projectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** No persisted state (nothing was ever running, or it was already cleared) returns `undefined`, not an error. */
export async function readRunState(storageRoot: string, projectId: string): Promise<PersistedRunState | undefined> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(storageRoot, projectId), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedRunState;
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.services) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Clears a project's persisted run-state — call this once every reconciled service is `stopped-while-closed`, or once the user has acted on the `unknown-running` ones. */
export async function clearRunState(storageRoot: string, projectId: string): Promise<void> {
  await rm(stateFilePath(storageRoot, projectId), { force: true });
}

/**
 * Whether a process with this pid currently exists — signal 0 asks the OS
 * "does this pid exist and am I allowed to signal it" without sending an
 * actual signal, on every platform Node runs `process.kill` on, POSIX and
 * Windows alike.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists, but owned by someone else —
    // still "alive" from Praxis's point of view, just not something it can
    // safely claim to have started.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Conservatively reconciles a persisted run-state record against the live
 * process table. A record with no pid (never got as far as spawning before
 * the app closed) reconciles straight to `stopped-while-closed`.
 */
export function reconcileRunState(state: PersistedRunState): ReconciledService[] {
  return state.services.map(record => ({
    serviceId: record.serviceId,
    pid: record.pid,
    state: record.pid !== undefined && isPidAlive(record.pid) ? 'unknown-running' : 'stopped-while-closed'
  }));
}
