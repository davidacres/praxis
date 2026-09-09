/**
 * The `direct-process` executor's own action surface (FX-BE-059 / TASK-158):
 * prepare, approve, deploy, health results, and explicit rollback — five
 * pure orchestration functions over the `DeploymentRun` state machine
 * (TASK-153), its durable store and crash reconciliation (TASK-154), the
 * target lock registry (TASK-153), the process executor (TASK-156), and
 * the directory target (TASK-157). Nothing new is invented here: this
 * module composes what those five tasks already built, and does not
 * reimplement the state machine's own transition guards.
 *
 * **Repeated click and reconnect cannot duplicate execution** is two
 * separate guarantees stacked on top of each other:
 *
 * - `DeploymentTargetLockRegistry.tryAcquire` is a synchronous, in-memory
 *   check with no `await` before it returns — in a single-threaded runtime
 *   that makes it atomic against a second call for the *same run* arriving
 *   before the first has finished (`'already-held-by-self'`) or a second
 *   run contending for the *same target* (`'refused'`). Either result
 *   refuses to touch the real executor a second time.
 * - `applyDeploymentRunCommand('start-deploying')` (TASK-153) only ever
 *   succeeds from `'queued'`; calling it again on a run already
 *   `'deploying'`/`'verifying'`/settled/`'unknown'` is a no-op that returns
 *   the same run object, which this module treats as "nothing to dispatch"
 *   rather than proceeding — this is what makes a stale reconnect (the UI
 *   re-sending "deploy" for a run it already dispatched before losing its
 *   connection) safe: the reducer itself refuses to re-open a settled or
 *   in-flight run, and this module never overrides that refusal.
 *
 * Health verification is deliberately kept separate from rollback: a health
 * check that fails lands the run on `failed` and stops there — rollback is
 * always a distinct, explicit action a caller invokes afterward, matching
 * `applyDeploymentRunCommand`'s own `start-rollback` guard (`succeeded` or
 * `failed` only, never invoked automatically by the deploy path itself).
 */

import * as path from 'node:path';
import {
  SUPPORTED_EXECUTOR_KINDS,
  SUPPORTED_TARGET_KINDS,
  type DeploymentProfile,
  type PublishedArtifact
} from '../projects/deploymentProfile';
import {
  applyDeploymentRunCommand,
  createDeploymentRun,
  isApprovalValid,
  targetLockKey,
  type DeploymentRun,
  type DeploymentTargetLockRegistry
} from '../projects/deploymentRunState';
import type { DeploymentRunStore } from '../projects/deploymentRunStore';
import type { PublishManifest } from '../projects/publishManifest';
import { applyDirectoryDeployment, restoreDirectoryBackup, verifyDirectoryHealth } from './directoryTarget';
import { runDirectProcessDeployment } from './directProcessExecutor';

// ── Prepare ──────────────────────────────────────────────────────────────

export interface PrepareDirectDeploymentInput {
  store: DeploymentRunStore;
  runId: string;
  profile: DeploymentProfile;
  artifact: PublishedArtifact;
  now: () => string;
  /** Linking context (TASK-160) — see `DeploymentRun`'s own doc for why these are opt-in and immutable once set. */
  issueKey?: string;
  issueConnectionId?: string;
  workflowRunId?: string;
  targetUrl?: string;
}

/** Creates and persists a fresh run — a no-op-safe entry point: calling it again with the same `runId` after the first call has already advanced the run past `prepared` does not reset anything, because `store.save` only ever replaces by `runId` and nothing here re-reads before writing on a first call. A caller re-preparing an already-in-flight run is a caller bug, not a state this function guards against; `runId` uniqueness is the caller's own responsibility, same as `createWorkflowRun`. */
export async function prepareDirectDeployment(input: PrepareDirectDeploymentInput): Promise<DeploymentRun> {
  const run = createDeploymentRun({
    runId: input.runId,
    deploymentProfileId: input.profile.id,
    profileVersion: input.profile.version,
    environment: input.profile.environment,
    artifactId: input.artifact.id,
    artifactDigest: input.artifact.digest,
    at: input.now(),
    issueKey: input.issueKey,
    issueConnectionId: input.issueConnectionId,
    workflowRunId: input.workflowRunId,
    targetUrl: input.targetUrl
  });
  await input.store.save(run);
  return run;
}

// ── Approve ──────────────────────────────────────────────────────────────

export interface ApproveDirectDeploymentInput {
  store: DeploymentRunStore;
  runId: string;
  profile: DeploymentProfile;
  artifact: PublishedArtifact;
  actor: string;
  now: () => string;
}

export interface ApproveDirectDeploymentResult {
  run: DeploymentRun;
  ok: boolean;
  reason?: string;
}

/**
 * Requests then grants approval. Idempotent under a repeated call: once a
 * run is `queued`, `request-approval` and `approve` are both no-ops on it
 * (the reducer's own guards), so re-clicking "approve" after it already
 * succeeded — including after a reconnect — changes nothing and reports
 * `ok: true` against the run exactly as it already stood.
 */
export async function approveDirectDeployment(input: ApproveDirectDeploymentInput): Promise<ApproveDirectDeploymentResult> {
  const existing = requireRun(input.store, input.runId);
  let next = applyDeploymentRunCommand(existing, { kind: 'request-approval', at: input.now() });
  next = applyDeploymentRunCommand(next, { kind: 'approve', at: input.now(), by: input.actor });

  if (!next.approval) {
    return { run: next, ok: false, reason: `Run status is "${next.status}"; approval requires an awaiting-approval run.` };
  }
  if (!isApprovalValid(next.approval, input.profile, input.artifact)) {
    return { run: next, ok: false, reason: 'Approval no longer matches the current profile version or artifact digest.' };
  }

  await input.store.save(next);
  return { run: next, ok: true };
}

// ── Deploy ───────────────────────────────────────────────────────────────

export interface RunDirectDeploymentInput {
  store: DeploymentRunStore;
  locks: DeploymentTargetLockRegistry;
  runId: string;
  profile: DeploymentProfile;
  artifact: PublishedArtifact;
  manifest: PublishManifest;
  /** Resolves a `local-process` target's repo-relative `cwd`; unused for a `directory` target. */
  projectFolder: string;
  /** `directory` target only. */
  excludePaths?: string[];
  backupDir?: string;
  stagingDir?: string;
  /** `local-process` target only — typed inputs forwarded to the script alongside `ARTIFACT_PATH`. */
  processInputs?: Record<string, string>;
  timeoutMs?: number;
  /** Where `profile.healthCheck` (if any) is evaluated against, for either target kind. */
  healthCheckHost?: string;
  healthCheckPort?: number;
  now: () => string;
}

export interface RunDirectDeploymentResult {
  dispatched: boolean;
  run: DeploymentRun;
  reason?: string;
}

export async function runDirectDeployment(input: RunDirectDeploymentInput): Promise<RunDirectDeploymentResult> {
  const existing = requireRun(input.store, input.runId);

  if (!SUPPORTED_EXECUTOR_KINDS.has(input.profile.executor.kind)) {
    return { dispatched: false, run: existing, reason: `Executor "${input.profile.executor.kind}" has no implementation yet.` };
  }
  if (!SUPPORTED_TARGET_KINDS.has(input.profile.target.kind)) {
    return { dispatched: false, run: existing, reason: `Target "${input.profile.target.kind}" has no implementation yet.` };
  }

  const lockKey = targetLockKey(input.profile.target);
  const lock = input.locks.tryAcquire(lockKey, input.runId, 'refuse');
  if (lock === 'refused' || lock === 'already-held-by-self') {
    return {
      dispatched: false,
      run: existing,
      reason:
        lock === 'refused'
          ? 'Target is locked by another deployment run.'
          : 'This run is already dispatching — repeated click ignored.'
    };
  }

  let current = applyDeploymentRunCommand(existing, { kind: 'start-deploying', at: input.now() });
  if (current === existing) {
    input.locks.release(lockKey, input.runId);
    return { dispatched: false, run: existing, reason: `Run status is "${existing.status}", not queued; nothing to dispatch.` };
  }
  // Persist identity before the executor is ever actually invoked (TASK-154's discipline).
  await input.store.save(current);

  let ok: boolean;
  let detail: string;
  try {
    const outcome = await dispatchToTarget(input, current);
    ok = outcome.ok;
    detail = outcome.detail;
    if (outcome.externalId) {
      current = applyDeploymentRunCommand(current, { kind: 'record-external-id', at: input.now(), externalId: outcome.externalId });
      await input.store.save(current);
    }
  } catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  current = applyDeploymentRunCommand(current, { kind: 'start-verifying', at: input.now() });
  await input.store.save(current);

  if (ok && input.profile.healthCheck) {
    const health = await verifyDirectoryHealth(input.profile.healthCheck, input.healthCheckHost ?? '127.0.0.1', input.healthCheckPort ?? 80);
    ok = health.healthy;
    detail = health.detail;
  }

  current = ok
    ? applyDeploymentRunCommand(current, { kind: 'health-verified', at: input.now() })
    : applyDeploymentRunCommand(current, { kind: 'health-failed', at: input.now(), error: detail });
  await input.store.save(current);

  input.locks.release(lockKey, input.runId);
  return { dispatched: true, run: current };
}

async function dispatchToTarget(
  input: RunDirectDeploymentInput,
  current: DeploymentRun
): Promise<{ ok: boolean; detail: string; externalId?: string }> {
  if (input.profile.target.kind === 'directory') {
    if (!input.backupDir || !input.stagingDir) {
      return { ok: false, detail: 'A directory target deploy requires backupDir and stagingDir.' };
    }
    const applied = await applyDirectoryDeployment({
      target: input.profile.target,
      artifactRootDir: input.artifact.location.path,
      manifest: input.manifest,
      excludePaths: input.excludePaths ?? [],
      backupDir: input.backupDir,
      stagingDir: input.stagingDir
    });
    return { ok: applied.applied, detail: applied.error ?? 'Applied.' };
  }

  if (input.profile.target.kind === 'local-process') {
    const target = input.profile.target;
    const operationId = `direct-process:${input.runId}:${current.attempt}`;
    const result = await runDirectProcessDeployment({
      operationId,
      executable: target.executable,
      args: target.args,
      cwd: target.cwd ? path.join(input.projectFolder, target.cwd) : input.projectFolder,
      inputs: { ARTIFACT_PATH: input.artifact.location.path, ...(input.processInputs ?? {}) },
      timeoutMs: input.timeoutMs
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    return {
      ok,
      detail: result.error ?? `Exit code ${result.exitCode ?? 'null'}.`,
      ...(result.pid ? { externalId: `pid:${result.pid}` } : {})
    };
  }

  return { ok: false, detail: `Target "${input.profile.target.kind}" has no implementation yet.` };
}

// ── Health results ───────────────────────────────────────────────────────

export interface DeploymentHealthResult {
  status: DeploymentRun['status'];
  /** Absent when the run has not yet reached a health outcome (still deploying, never dispatched, etc.). */
  healthy?: boolean;
  detail?: string;
}

/** A read-only summary of a run's last recorded health outcome — the "health results" action. Never mutates the run or the store. */
export function deploymentHealthResult(run: DeploymentRun): DeploymentHealthResult {
  const lastHealthEvent = [...run.events].reverse().find(event => event.kind === 'health-verified' || event.kind === 'health-failed');
  return {
    status: run.status,
    ...(lastHealthEvent
      ? { healthy: lastHealthEvent.kind === 'health-verified', detail: lastHealthEvent.message }
      : {})
  };
}

// ── Explicit rollback ────────────────────────────────────────────────────

export interface RollbackDirectDeploymentInput {
  store: DeploymentRunStore;
  runId: string;
  profile: DeploymentProfile;
  /** `directory` target only — the backup this run's own deploy took. */
  backupDir?: string;
  excludePaths?: string[];
  now: () => string;
}

export interface RollbackDirectDeploymentResult {
  rolledBack: boolean;
  run: DeploymentRun;
  reason?: string;
}

/**
 * Restores the previous version for a `directory` target. For any other
 * target kind — `local-process` has no backup/restore mechanism, per
 * TASK-157's own scope — rollback is refused, and that refusal is not
 * silent: `start-rollback` still fires (so the attempt is on the record),
 * followed immediately by `rollback-failed` with the reason, so the run's
 * own event log carries both that a rollback was attempted and exactly why
 * it could not proceed. This is "unsupported rollback explains the reason
 * and leaves evidence" — the evidence is the run's own event log, the same
 * place every other outcome in this system is recorded.
 */
export async function rollbackDirectDeployment(input: RollbackDirectDeploymentInput): Promise<RollbackDirectDeploymentResult> {
  const existing = requireRun(input.store, input.runId);

  const started = applyDeploymentRunCommand(existing, { kind: 'start-rollback', at: input.now() });
  if (started === existing) {
    return {
      rolledBack: false,
      run: existing,
      reason: `Run status is "${existing.status}"; rollback only applies to a succeeded or failed run.`
    };
  }
  await input.store.save(started);

  if (input.profile.target.kind !== 'directory') {
    const failed = applyDeploymentRunCommand(started, {
      kind: 'rollback-failed',
      at: input.now(),
      error: `Rollback is not supported for target kind "${input.profile.target.kind}" — only a directory target's backup/restore is implemented.`
    });
    await input.store.save(failed);
    return { rolledBack: false, run: failed, reason: failed.endedReason };
  }

  if (!input.backupDir) {
    const failed = applyDeploymentRunCommand(started, {
      kind: 'rollback-failed',
      at: input.now(),
      error: 'No backup directory was recorded for this run; nothing to restore.'
    });
    await input.store.save(failed);
    return { rolledBack: false, run: failed, reason: failed.endedReason };
  }

  const restore = await restoreDirectoryBackup(input.profile.target, input.backupDir, input.excludePaths ?? []);
  const next = restore.restored
    ? applyDeploymentRunCommand(started, { kind: 'rollback-succeeded', at: input.now() })
    : applyDeploymentRunCommand(started, { kind: 'rollback-failed', at: input.now(), error: restore.error ?? 'Restore failed.' });
  await input.store.save(next);
  return { rolledBack: restore.restored, run: next, reason: restore.restored ? undefined : next.endedReason };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function requireRun(store: DeploymentRunStore, runId: string): DeploymentRun {
  const run = store.get(runId);
  if (!run) throw new Error(`Deployment run ${runId} was not found.`);
  return run;
}
