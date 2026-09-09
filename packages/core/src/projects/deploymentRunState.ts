/**
 * Durable deployment run state and event log (FX-BF-023 / TASK-153).
 *
 * Same architecture as `workflows/workflowRun.ts` on purpose — a run is a
 * reduced value, not an object with methods; every transition is a pure
 * `(run, command) => run` step that appends to an event log; a settled run
 * absorbs nothing further; replaying a command a run has already absorbed
 * returns the run unchanged rather than duplicating an event. That last
 * property is this task's own acceptance criterion in code: "completed
 * steps are not replayed."
 *
 * Three invariants the transition table itself enforces, not a runtime
 * check bolted on top of it:
 *
 * - **Only verified health yields `succeeded`.** There is no command that
 *   moves any status straight to `succeeded` except `health-verified` fired
 *   from `verifying` — the vocabulary of commands has no shortcut.
 * - **A settled run (`succeeded`/`failed`/`cancelled`/`rolled-back`)
 *   absorbs nothing further** except the crash-safety commands
 *   (`mark-unknown` is deliberately still accepted on `unknown` itself, an
 *   idempotent no-op) — mirroring `isRunSettled`'s exact role in
 *   `workflowRun.ts`.
 * - **`unknown` is a real, reachable status**, not an error path bolted on:
 *   a crash after `deploy-started`/`verify-started` but before the next
 *   acknowledged event reconciles to `unknown`, never silently to
 *   `succeeded` or a duplicated `deploy-started`. Wiring an actual restart
 *   reconciler that *detects* the crash and issues `mark-unknown` is
 *   FX-BE-058's next task (TASK-154, "persist side effects and
 *   reconcile"); this module defines the status this reduces to and the
 *   commands that can act on it once reached, not the detection itself.
 *
 * Approval binding and target locking are deliberately separate, smaller
 * functions rather than folded into the reducer: `isApprovalValid` compares
 * a stored `DeploymentApproval` against the *current* profile/artifact (the
 * reducer has no access to "current" anything — it only ever reacts to an
 * explicit command), and `DeploymentTargetLockRegistry` tracks a resource
 * the reducer doesn't model at all (which runs contend for the same target)
 * — deliberately decoupled so a caller can re-check either at whatever
 * point actually matters (before issuing `approve`, before issuing
 * `start-deploying`) without the reducer needing to reach outside itself.
 */

import type { DeploymentProfile, PublishedArtifact, TargetRef } from './deploymentProfile';

export const DEPLOYMENT_RUN_SCHEMA_VERSION = 1;

export type DeploymentRunStatus =
  | 'prepared'
  | 'awaiting-approval'
  | 'queued'
  | 'deploying'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'rolling-back'
  | 'rolled-back';

const SETTLED_STATUSES: ReadonlySet<DeploymentRunStatus> = new Set(['succeeded', 'failed', 'cancelled', 'rolled-back']);

export function isDeploymentRunSettled(run: DeploymentRun): boolean {
  return SETTLED_STATUSES.has(run.status);
}

export type DeploymentRunEventKind =
  | 'prepared'
  | 'approval-requested'
  | 'approved'
  | 'approval-invalidated'
  | 'enqueued'
  | 'deploy-started'
  | 'verify-started'
  | 'health-verified'
  | 'health-failed'
  | 'cancelled'
  | 'marked-unknown'
  | 'rollback-started'
  | 'rolled-back'
  | 'rollback-failed';

export interface DeploymentRunEvent {
  /** `<runId>-<sequence>`; the sequence is the log length at append time. */
  id: string;
  at: string;
  kind: DeploymentRunEventKind;
  message: string;
}

/**
 * Binds one approval to exactly the profile version, artifact digest, and
 * environment it was granted against — "approval binds profile version,
 * digest and environment," this task's own words. `isApprovalValid`
 * re-checks all three; any mismatch (the profile was edited, a different
 * artifact was published, the environment changed) means the approval no
 * longer covers what's about to be deployed.
 */
export interface DeploymentApproval {
  deploymentProfileId: string;
  profileVersion: number;
  artifactId: string;
  artifactDigest: string;
  environment: string;
  approvedBy: string;
  approvedAt: string;
}

export interface DeploymentRun {
  schemaVersion: number;
  runId: string;
  deploymentProfileId: string;
  /** The profile version and artifact this run was prepared against — embedded, not re-read, same discipline as `WorkflowRun.definition`: editing the profile later must never rewrite an in-flight run's own history. */
  profileVersion: number;
  environment: string;
  artifactId: string;
  artifactDigest: string;
  status: DeploymentRunStatus;
  approval?: DeploymentApproval;
  events: DeploymentRunEvent[];
  startedAt: string;
  endedAt?: string;
  endedReason?: string;
}

export function createDeploymentRun(input: {
  runId: string;
  deploymentProfileId: string;
  profileVersion: number;
  environment: string;
  artifactId: string;
  artifactDigest: string;
  at: string;
}): DeploymentRun {
  const run: DeploymentRun = {
    schemaVersion: DEPLOYMENT_RUN_SCHEMA_VERSION,
    runId: input.runId,
    deploymentProfileId: input.deploymentProfileId,
    profileVersion: input.profileVersion,
    environment: input.environment,
    artifactId: input.artifactId,
    artifactDigest: input.artifactDigest,
    status: 'prepared',
    events: [],
    startedAt: input.at
  };
  return append(run, { at: input.at, kind: 'prepared', message: 'Deployment prepared.' });
}

// ── Commands ─────────────────────────────────────────────────────────────

export type DeploymentRunCommand =
  | { kind: 'request-approval'; at: string }
  | { kind: 'approve'; at: string; by: string }
  | { kind: 'invalidate-approval'; at: string; reason: string }
  | { kind: 'enqueue'; at: string }
  | { kind: 'start-deploying'; at: string }
  | { kind: 'start-verifying'; at: string }
  | { kind: 'health-verified'; at: string }
  | { kind: 'health-failed'; at: string; error: string }
  | { kind: 'cancel'; at: string; reason?: string }
  | { kind: 'mark-unknown'; at: string; reason: string }
  | { kind: 'start-rollback'; at: string }
  | { kind: 'rollback-succeeded'; at: string }
  | { kind: 'rollback-failed'; at: string; error: string };

/**
 * The one reducer. There is no blanket "settled runs absorb nothing"
 * shortcut here — `succeeded` and `failed` are settled outcomes
 * (`isDeploymentRunSettled` reports them as such) but still accept
 * `start-rollback`, so each command below checks its own precise allowed
 * source status instead. Every check still adds up to the same guarantee:
 * replaying a command a run has already processed, or sending one that
 * doesn't apply to its current status, returns the run completely
 * unchanged (no new event) — which is what makes replay-safe recovery
 * possible, a caller unsure whether a command was already applied can
 * simply re-send it.
 */
export function applyDeploymentRunCommand(run: DeploymentRun, command: DeploymentRunCommand): DeploymentRun {
  // Truly terminal — nothing, rollback included, ever acts on these again.
  if (run.status === 'cancelled' || run.status === 'rolled-back') return run;

  switch (command.kind) {
    case 'request-approval':
      return transition(run, ['prepared'], 'awaiting-approval', command.at, 'approval-requested', 'Approval requested.');
    case 'approve': {
      if (run.status !== 'awaiting-approval') return run;
      const approval: DeploymentApproval = {
        deploymentProfileId: run.deploymentProfileId,
        profileVersion: run.profileVersion,
        artifactId: run.artifactId,
        artifactDigest: run.artifactDigest,
        environment: run.environment,
        approvedBy: command.by,
        approvedAt: command.at
      };
      return append({ ...run, status: 'queued', approval }, { at: command.at, kind: 'approved', message: `Approved by ${command.by}.` });
    }
    case 'invalidate-approval': {
      // Only meaningful once approved; invalidating an unapproved run is a no-op, not an error.
      if (run.status !== 'queued' && run.status !== 'awaiting-approval') return run;
      const { approval: _approval, ...withoutApproval } = run;
      return append(
        { ...withoutApproval, status: 'awaiting-approval' },
        { at: command.at, kind: 'approval-invalidated', message: `Approval invalidated: ${command.reason}` }
      );
    }
    case 'enqueue':
      return transition(run, ['queued'], 'queued', command.at, 'enqueued', 'Queued — waiting for its target to be free.');
    case 'start-deploying':
      // Requires a still-valid approval — a queued run with no approval attached (or one that
      // was invalidated and never re-approved) cannot start; the reducer refuses rather than
      // silently deploying unapproved. The *validity* check (profile/artifact still matching)
      // is `isApprovalValid`'s job, run by the caller before issuing this command.
      if (run.status !== 'queued' || !run.approval) return run;
      return append({ ...run, status: 'deploying' }, { at: command.at, kind: 'deploy-started', message: 'Deployment started.' });
    case 'start-verifying':
      return transition(run, ['deploying'], 'verifying', command.at, 'verify-started', 'Verifying deployed health.');
    case 'health-verified':
      if (run.status !== 'verifying') return run;
      return settle(run, 'succeeded', command.at, 'health-verified', 'Health verified — deployment succeeded.');
    case 'health-failed':
      if (run.status !== 'verifying') return run;
      return settle(run, 'failed', command.at, 'health-failed', `Health check failed: ${command.error}`, command.error);
    case 'cancel': {
      if (!['prepared', 'awaiting-approval', 'queued', 'deploying', 'verifying'].includes(run.status)) return run;
      return settle(run, 'cancelled', command.at, 'cancelled', command.reason ? `Cancelled: ${command.reason}` : 'Cancelled.', command.reason);
    }
    case 'mark-unknown': {
      if (run.status === 'unknown') return run; // idempotent — already reconciling
      if (!['deploying', 'verifying'].includes(run.status)) return run;
      return append({ ...run, status: 'unknown' }, { at: command.at, kind: 'marked-unknown', message: `Status unknown: ${command.reason}` });
    }
    case 'start-rollback':
      return transition(run, ['succeeded', 'failed'], 'rolling-back', command.at, 'rollback-started', 'Rolling back.');
    case 'rollback-succeeded':
      if (run.status !== 'rolling-back') return run;
      return settle(run, 'rolled-back', command.at, 'rolled-back', 'Rollback succeeded.');
    case 'rollback-failed':
      if (run.status !== 'rolling-back') return run;
      // Rollback failing does not invent a new status — it lands back on `failed` with the
      // rollback's own error recorded, since "rolled-back" would misreport what happened.
      return settle(run, 'failed', command.at, 'rollback-failed', `Rollback failed: ${command.error}`, command.error);
  }
}

function transition(
  run: DeploymentRun,
  allowedFrom: DeploymentRunStatus[],
  to: DeploymentRunStatus,
  at: string,
  kind: DeploymentRunEventKind,
  message: string
): DeploymentRun {
  if (!allowedFrom.includes(run.status)) return run;
  return append({ ...run, status: to }, { at, kind, message });
}

function settle(
  run: DeploymentRun,
  status: DeploymentRunStatus,
  at: string,
  kind: DeploymentRunEventKind,
  message: string,
  endedReason?: string
): DeploymentRun {
  return append({ ...run, status, endedAt: at, ...(endedReason ? { endedReason } : {}) }, { at, kind, message });
}

function append(run: DeploymentRun, event: Omit<DeploymentRunEvent, 'id'>): DeploymentRun {
  return { ...run, events: [...run.events, { id: `${run.runId}-${run.events.length}`, ...event }] };
}

/**
 * "Changing artifact or target invalidates approval": `profileVersion` is
 * the whole profile's version (bumped by whoever writes the profile
 * whenever *any* field changes — including `target`), so comparing it
 * alone catches a target change with no separate target-specific check
 * needed. A caller re-checks this immediately before `approve` and again
 * immediately before `start-deploying` — a profile edited or an artifact
 * republished in between either point invalidates what looked valid a
 * moment earlier.
 */
export function isApprovalValid(approval: DeploymentApproval, profile: DeploymentProfile, artifact: PublishedArtifact): boolean {
  return (
    approval.deploymentProfileId === profile.id &&
    approval.profileVersion === profile.version &&
    approval.artifactId === artifact.id &&
    approval.artifactDigest === artifact.digest &&
    approval.environment === profile.environment
  );
}

// ── Target locking ───────────────────────────────────────────────────────

/** A stable identity for "this is the same physical destination" — two profiles naming the same directory, or the same local-process executable+cwd, or the same IIS site, contend for the one lock. */
export function targetLockKey(target: TargetRef): string {
  switch (target.kind) {
    case 'directory':
      return `directory:${target.path}`;
    case 'local-process':
      return `local-process:${target.executable}:${target.cwd ?? ''}`;
    case 'iis':
      return `iis:${target.siteName}`;
  }
}

export type LockAcquireResult = 'acquired' | 'queued' | 'refused' | 'already-held-by-self';

/**
 * In-memory target-lock registry — "concurrent deployment to a locked
 * target is queued or refused explicitly," never silently allowed to run
 * alongside another deployment to the same destination. `policy` is the
 * caller's choice per attempt: `'queue'` (the default — wait in line)
 * or `'refuse'` (reject outright rather than wait, for a caller that would
 * rather fail fast than sit in a queue of unknown length).
 */
export class DeploymentTargetLockRegistry {
  private readonly holders = new Map<string, string>();
  private readonly queues = new Map<string, string[]>();

  tryAcquire(lockKey: string, runId: string, policy: 'queue' | 'refuse' = 'queue'): LockAcquireResult {
    const holder = this.holders.get(lockKey);
    if (holder === runId) return 'already-held-by-self';
    if (!holder) {
      this.holders.set(lockKey, runId);
      return 'acquired';
    }
    if (policy === 'refuse') return 'refused';
    const queue = this.queues.get(lockKey) ?? [];
    if (!queue.includes(runId)) {
      queue.push(runId);
      this.queues.set(lockKey, queue);
    }
    return 'queued';
  }

  /** Releases the lock; if another run was queued for it, that run now holds it and its id is returned so the caller can advance it. */
  release(lockKey: string, runId: string): { nextRunId?: string } {
    if (this.holders.get(lockKey) !== runId) return {};
    this.holders.delete(lockKey);
    const queue = this.queues.get(lockKey) ?? [];
    const next = queue.shift();
    if (next === undefined) {
      this.queues.delete(lockKey);
      return {};
    }
    this.holders.set(lockKey, next);
    this.queues.set(lockKey, queue);
    return { nextRunId: next };
  }

  /** Removes `runId` from a lock's wait queue without affecting the current holder — for a queued run that gets cancelled before its turn. */
  removeFromQueue(lockKey: string, runId: string): void {
    const queue = this.queues.get(lockKey);
    if (!queue) return;
    const next = queue.filter(id => id !== runId);
    if (next.length > 0) this.queues.set(lockKey, next);
    else this.queues.delete(lockKey);
  }

  holderOf(lockKey: string): string | undefined {
    return this.holders.get(lockKey);
  }
}
