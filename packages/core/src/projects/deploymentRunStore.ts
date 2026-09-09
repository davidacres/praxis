/**
 * Durable deployment run storage and crash reconciliation (FX-BF-023 /
 * TASK-154).
 *
 * `DeploymentRunStore` is `workflows/workflowStore.ts`'s `WorkflowRunStore`
 * verbatim in shape — a `KeyValueStore`-backed list, `save` replacing by
 * `runId`, `normalizeDeploymentRun` defensively parsing whatever the store
 * hands back. This is "persist operation identity before dispatch": a
 * caller driving `applyDeploymentRunCommand` (TASK-153) is expected to
 * `save()` the run immediately after every command — in particular after
 * `start-deploying`, *before* it goes on to actually invoke the executor —
 * so a crash in the narrow window between "decided to dispatch" and
 * "the executor call returned" still leaves a durable record saying
 * dispatch was attempted. `record-external-id` (TASK-153) is `save()`d the
 * same way the moment an external id becomes known.
 *
 * `reconcileDeploymentRun` is the other half: on restart, a run found
 * sitting in `deploying`/`verifying` is exactly "crash after dispatch but
 * before acknowledgement" — its own event log never received a settling
 * event. Reconciliation never guesses an outcome; it always ends at
 * `unknown` (via TASK-153's own `mark-unknown`), but the *reason* attached
 * distinguishes what's actually knowable:
 *
 * - No `externalId` was ever recorded → **lost acknowledgement** — nothing
 *   to check at all, the crash happened before dispatch even confirmed.
 * - An `externalId` was recorded and that operation is still alive →
 *   **unconfirmed but running** — it might still finish on its own; only
 *   its outcome, not its existence, is unknown.
 * - An `externalId` was recorded but that operation is gone → **unconfirmed
 *   and stopped** — something happened to it, but nothing recorded what.
 *
 * A run already sitting in a settled status (`succeeded`, `failed`,
 * `cancelled`, `rolled-back`) needs no reconciliation at all — including a
 * **confirmed failure** (`failed`, from an actual `health-failed` event
 * recorded before the crash): its own event log already answers the
 * question, so reconciliation is a no-op for it, which is exactly how a
 * confirmed failure is told apart from a merely lost acknowledgement.
 */

import type { KeyValueStore } from '../host/stateStore';
import {
  applyDeploymentRunCommand,
  DEPLOYMENT_RUN_SCHEMA_VERSION,
  type DeploymentRun,
  type DeploymentRunEvent,
  type DeploymentRunStatus
} from './deploymentRunState';

const RUNS_KEY = 'praxis.deploymentRuns.v1';

const STATUSES: ReadonlySet<DeploymentRunStatus> = new Set([
  'prepared',
  'awaiting-approval',
  'queued',
  'deploying',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'rolling-back',
  'rolled-back'
]);

function isStatus(value: unknown): value is DeploymentRunStatus {
  return typeof value === 'string' && STATUSES.has(value as DeploymentRunStatus);
}

/** Defensively parses whatever the store hands back — the same discipline `normalizeWorkflowRun` uses, so a malformed or partially-written record comes back as a best-effort run rather than throwing and hiding every other run alongside it. */
export function normalizeDeploymentRun(value: unknown): DeploymentRun | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || !raw.runId) return undefined;
  if (typeof raw.deploymentProfileId !== 'string' || !raw.deploymentProfileId) return undefined;

  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : DEPLOYMENT_RUN_SCHEMA_VERSION,
    runId: raw.runId,
    deploymentProfileId: raw.deploymentProfileId,
    profileVersion: typeof raw.profileVersion === 'number' ? raw.profileVersion : 0,
    environment: typeof raw.environment === 'string' ? raw.environment : '',
    artifactId: typeof raw.artifactId === 'string' ? raw.artifactId : '',
    artifactDigest: typeof raw.artifactDigest === 'string' ? raw.artifactDigest : '',
    status: isStatus(raw.status) ? raw.status : 'prepared',
    attempt: typeof raw.attempt === 'number' && raw.attempt >= 1 ? raw.attempt : 1,
    ...(raw.approval && typeof raw.approval === 'object' ? { approval: raw.approval as DeploymentRun['approval'] } : {}),
    ...(typeof raw.externalId === 'string' ? { externalId: raw.externalId } : {}),
    events: Array.isArray(raw.events) ? (raw.events as DeploymentRunEvent[]) : [],
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.endedReason === 'string' ? { endedReason: raw.endedReason } : {})
  };
}

export class DeploymentRunStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): DeploymentRun[] {
    const value = this.state.get<unknown[]>(RUNS_KEY);
    if (!Array.isArray(value)) return [];
    return value.map(entry => normalizeDeploymentRun(entry)).filter((entry): entry is DeploymentRun => !!entry);
  }

  public forProfile(deploymentProfileId: string): DeploymentRun[] {
    return this.list()
      .filter(run => run.deploymentProfileId === deploymentProfileId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public get(runId: string): DeploymentRun | undefined {
    return this.list().find(run => run.runId === runId);
  }

  /** Inserts or replaces a run — the run itself is the unit of atomicity, same as `WorkflowRunStore.save`. */
  public async save(run: DeploymentRun): Promise<DeploymentRun> {
    const runs = this.list();
    const index = runs.findIndex(candidate => candidate.runId === run.runId);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await this.state.update(RUNS_KEY, runs);
    return run;
  }

  public async remove(runId: string): Promise<void> {
    const runs = this.list();
    const next = runs.filter(run => run.runId !== runId);
    if (next.length === runs.length) throw new Error(`Deployment run ${runId} was not found.`);
    await this.state.update(RUNS_KEY, next);
  }

  /** Every run left in `deploying`/`verifying` — a restart's own worklist of what needs `reconcileDeploymentRun`. */
  public needingReconciliation(): DeploymentRun[] {
    return this.list().filter(run => run.status === 'deploying' || run.status === 'verifying');
  }
}

export interface ReconciliationResult {
  run: DeploymentRun;
  /** Why reconciliation landed where it did — attached to the run's own `marked-unknown` event, and worth logging/showing to a person deciding whether to `retry-dispatch`. */
  note: string;
  /** False when the run was already settled (nothing to reconcile — includes a confirmed failure) or wasn't actually crashed mid-flight. */
  reconciled: boolean;
}

/**
 * Reconciles one run against the live state of whatever it dispatched.
 * `isAlive` is a narrow seam (e.g. `(pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } }`
 * for the direct executor, matching `runReconciliation.ts`'s own `isPidAlive` — passed in rather
 * than imported so this module makes no assumption about what an
 * `externalId` even is for a given executor kind.
 */
export async function reconcileDeploymentRun(
  run: DeploymentRun,
  isAlive: (externalId: string) => boolean | Promise<boolean>,
  at: string
): Promise<ReconciliationResult> {
  if (run.status !== 'deploying' && run.status !== 'verifying') {
    return { run, note: `Status is already "${run.status}" — nothing to reconcile.`, reconciled: false };
  }

  let note: string;
  if (!run.externalId) {
    note = 'No external operation identity was ever recorded before the interruption — lost acknowledgement, outcome unknown.';
  } else if (await isAlive(run.externalId)) {
    note = `The dispatched operation (${run.externalId}) is still running, but its outcome was never confirmed before the interruption.`;
  } else {
    note = `The dispatched operation (${run.externalId}) is no longer running, and no outcome was recorded before the interruption.`;
  }

  const reconciledRun = applyDeploymentRunCommand(run, { kind: 'mark-unknown', at, reason: note });
  return { run: reconciledRun, note, reconciled: true };
}
