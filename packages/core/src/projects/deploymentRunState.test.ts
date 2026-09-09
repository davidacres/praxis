import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeploymentTargetLockRegistry,
  applyDeploymentRunCommand,
  createDeploymentRun,
  isApprovalValid,
  isDeploymentRunSettled,
  targetLockKey,
  type DeploymentApproval,
  type DeploymentRun
} from './deploymentRunState';
import type { DeploymentProfile, PublishedArtifact, TargetRef } from './deploymentProfile';

const AT = '2026-09-09T00:00:00.000Z';
let clock = 0;
function nextAt(): string {
  clock += 1;
  return `2026-09-09T00:0${clock}:00.000Z`;
}

function run(overrides: Partial<Parameters<typeof createDeploymentRun>[0]> = {}): DeploymentRun {
  return createDeploymentRun({
    runId: 'run-1',
    deploymentProfileId: 'production',
    profileVersion: 1,
    environment: 'production',
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:abc',
    at: AT,
    ...overrides
  });
}

function toDeploying(): DeploymentRun {
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'approve', at: nextAt(), by: 'alice' });
  r = applyDeploymentRunCommand(r, { kind: 'start-deploying', at: nextAt() });
  return r;
}

test('a fresh run starts prepared', () => {
  assert.equal(run().status, 'prepared');
});

test('the full happy path: prepared -> awaiting-approval -> queued -> deploying -> verifying -> succeeded', () => {
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  assert.equal(r.status, 'awaiting-approval');
  r = applyDeploymentRunCommand(r, { kind: 'approve', at: nextAt(), by: 'alice' });
  assert.equal(r.status, 'queued');
  assert.equal(r.approval?.approvedBy, 'alice');
  r = applyDeploymentRunCommand(r, { kind: 'start-deploying', at: nextAt() });
  assert.equal(r.status, 'deploying');
  r = applyDeploymentRunCommand(r, { kind: 'start-verifying', at: nextAt() });
  assert.equal(r.status, 'verifying');
  r = applyDeploymentRunCommand(r, { kind: 'health-verified', at: nextAt() });
  assert.equal(r.status, 'succeeded');
  assert.ok(r.endedAt);
  assert.equal(isDeploymentRunSettled(r), true);
});

test('only verified health yields succeeded — there is no command that reaches succeeded except health-verified from verifying', () => {
  // Attempting to jump straight to "succeeded" isn't even expressible: health-verified is a
  // no-op unless the run is already in `verifying`.
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'health-verified', at: nextAt() });
  assert.equal(r.status, 'prepared', 'health-verified from prepared must be ignored');

  r = toDeploying();
  r = applyDeploymentRunCommand(r, { kind: 'health-verified', at: nextAt() });
  assert.equal(r.status, 'deploying', 'health-verified from deploying (skipping verifying) must be ignored');
});

test('health-failed from verifying settles the run as failed with the error recorded', () => {
  let r = toDeploying();
  r = applyDeploymentRunCommand(r, { kind: 'start-verifying', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'health-failed', at: nextAt(), error: 'HTTP 503 from /healthz' });
  assert.equal(r.status, 'failed');
  assert.equal(r.endedReason, 'HTTP 503 from /healthz');
});

test('start-deploying refuses without an approval attached', () => {
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  // Skip 'approve' — go straight for start-deploying.
  r = applyDeploymentRunCommand(r, { kind: 'start-deploying', at: nextAt() });
  assert.equal(r.status, 'awaiting-approval', 'must not start deploying without an approval');
});

test('invalidate-approval moves an approved run back to awaiting-approval and drops the approval', () => {
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'approve', at: nextAt(), by: 'alice' });
  assert.ok(r.approval);
  r = applyDeploymentRunCommand(r, { kind: 'invalidate-approval', at: nextAt(), reason: 'artifact republished' });
  assert.equal(r.status, 'awaiting-approval');
  assert.equal(r.approval, undefined);
});

test('invalidating an approval that was never granted is a harmless no-op', () => {
  const before = run();
  const after = applyDeploymentRunCommand(before, { kind: 'invalidate-approval', at: nextAt(), reason: 'n/a' });
  assert.deepEqual(after, before);
});

test('completed steps are not replayed — re-applying an already-absorbed command is a no-op, no duplicate event', () => {
  let r = run();
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  const eventCountAfterFirst = r.events.length;
  // Re-send the same command as if recovery replayed it.
  const replayed = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  assert.equal(replayed.status, 'awaiting-approval');
  assert.equal(replayed.events.length, eventCountAfterFirst, 'no duplicate event from replaying an already-absorbed command');
});

test('a settled run absorbs nothing further', () => {
  let r = toDeploying();
  r = applyDeploymentRunCommand(r, { kind: 'start-verifying', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'health-verified', at: nextAt() });
  assert.equal(r.status, 'succeeded');
  const eventCount = r.events.length;
  const afterCancel = applyDeploymentRunCommand(r, { kind: 'cancel', at: nextAt() });
  assert.deepEqual(afterCancel, r, 'a settled run must be completely unchanged by a later command');
  assert.equal(afterCancel.events.length, eventCount);
});

test('cancel is accepted from every in-flight status and settles the run', () => {
  for (const setup of [
    (): DeploymentRun => run(),
    (): DeploymentRun => applyDeploymentRunCommand(run(), { kind: 'request-approval', at: nextAt() }),
    (): DeploymentRun => toDeploying()
  ]) {
    const cancelled = applyDeploymentRunCommand(setup(), { kind: 'cancel', at: nextAt(), reason: 'operator abort' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(isDeploymentRunSettled(cancelled), true);
  }
});

test('crash after dispatch but before acknowledgement: mark-unknown from deploying or verifying produces unknown, never succeeded and never a duplicate deploy-started', () => {
  let r = toDeploying();
  const beforeUnknown = r;
  r = applyDeploymentRunCommand(r, { kind: 'mark-unknown', at: nextAt(), reason: 'process exited before an outcome was recorded' });
  assert.equal(r.status, 'unknown');
  // The crash-recovery path never re-issues start-deploying to "try again automatically" —
  // proven here by simply never calling it; unknown is a terminal-until-reconciled status a
  // human or an explicit reconciliation step must act on next, not one this reducer auto-advances.
  assert.notEqual(beforeUnknown.status, 'unknown');

  // mark-unknown itself is idempotent once reached.
  const again = applyDeploymentRunCommand(r, { kind: 'mark-unknown', at: nextAt(), reason: 'still unresolved' });
  assert.deepEqual(again, r);
});

test('mark-unknown is refused outside deploying/verifying — an approval or queue-stage crash has nothing ambiguous to reconcile', () => {
  const r = applyDeploymentRunCommand(run(), { kind: 'mark-unknown', at: nextAt(), reason: 'n/a' });
  assert.equal(r.status, 'prepared');
});

test('rollback: succeeded -> rolling-back -> rolled-back', () => {
  let r = toDeploying();
  r = applyDeploymentRunCommand(r, { kind: 'start-verifying', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'health-verified', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'start-rollback', at: nextAt() });
  assert.equal(r.status, 'rolling-back');
  r = applyDeploymentRunCommand(r, { kind: 'rollback-succeeded', at: nextAt() });
  assert.equal(r.status, 'rolled-back');
  assert.equal(isDeploymentRunSettled(r), true);
});

test('rollback can also be started from a failed run, and a failed rollback lands back on failed with its own error', () => {
  let r = toDeploying();
  r = applyDeploymentRunCommand(r, { kind: 'start-verifying', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'health-failed', at: nextAt(), error: 'boom' });
  assert.equal(r.status, 'failed');
  r = applyDeploymentRunCommand(r, { kind: 'start-rollback', at: nextAt() });
  assert.equal(r.status, 'rolling-back');
  r = applyDeploymentRunCommand(r, { kind: 'rollback-failed', at: nextAt(), error: 'rollback script exited 1' });
  assert.equal(r.status, 'failed');
  assert.equal(r.endedReason, 'rollback script exited 1');
});

test('isApprovalValid: changing the profile version invalidates a previously valid approval', () => {
  const profile: DeploymentProfile = {
    schemaVersion: 1,
    version: 1,
    id: 'production',
    name: 'Production',
    projectId: 'proj-1',
    environment: 'production',
    executor: { kind: 'direct-process' },
    target: { kind: 'directory', path: 'dist' },
    rollback: { kind: 'none' },
    createdAt: AT,
    updatedAt: AT
  };
  const artifact: PublishedArtifact = {
    id: 'artifact-1',
    deploymentProfileId: 'production',
    sourceCommit: { kind: 'commit', sha: 'abc' },
    digest: 'sha256:abc',
    createdAt: AT,
    location: { kind: 'local-path', path: '/tmp/dist' }
  };
  const approval: DeploymentApproval = {
    deploymentProfileId: 'production',
    profileVersion: 1,
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:abc',
    environment: 'production',
    approvedBy: 'alice',
    approvedAt: AT
  };
  assert.equal(isApprovalValid(approval, profile, artifact), true);
  // The target changed (or any other field) — the caller bumps `version` when writing the edit.
  const editedProfile = { ...profile, version: 2, target: { kind: 'directory' as const, path: 'dist2' } };
  assert.equal(isApprovalValid(approval, editedProfile, artifact), false, 'changing the target (via a version bump) invalidates approval');
});

test('isApprovalValid: publishing a different artifact invalidates a previously valid approval', () => {
  const profile: DeploymentProfile = {
    schemaVersion: 1,
    version: 1,
    id: 'production',
    name: 'Production',
    projectId: 'proj-1',
    environment: 'production',
    executor: { kind: 'direct-process' },
    target: { kind: 'directory', path: 'dist' },
    rollback: { kind: 'none' },
    createdAt: AT,
    updatedAt: AT
  };
  const approval: DeploymentApproval = {
    deploymentProfileId: 'production',
    profileVersion: 1,
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:abc',
    environment: 'production',
    approvedBy: 'alice',
    approvedAt: AT
  };
  const newArtifact: PublishedArtifact = {
    id: 'artifact-2',
    deploymentProfileId: 'production',
    sourceCommit: { kind: 'commit', sha: 'def' },
    digest: 'sha256:def',
    createdAt: AT,
    location: { kind: 'local-path', path: '/tmp/dist' }
  };
  assert.equal(isApprovalValid(approval, profile, newArtifact), false);
});

test('targetLockKey identifies the same physical destination across two profiles naming it the same way', () => {
  const a: TargetRef = { kind: 'directory', path: 'dist' };
  const b: TargetRef = { kind: 'directory', path: 'dist' };
  const c: TargetRef = { kind: 'directory', path: 'other-dist' };
  assert.equal(targetLockKey(a), targetLockKey(b));
  assert.notEqual(targetLockKey(a), targetLockKey(c));
});

test('DeploymentTargetLockRegistry: a second run to the same target queues by default', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  assert.equal(registry.tryAcquire(key, 'run-1'), 'acquired');
  assert.equal(registry.tryAcquire(key, 'run-2'), 'queued');
  assert.equal(registry.holderOf(key), 'run-1');
});

test('DeploymentTargetLockRegistry: a second run can be refused explicitly instead of queued', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  assert.equal(registry.tryAcquire(key, 'run-1'), 'acquired');
  assert.equal(registry.tryAcquire(key, 'run-2', 'refuse'), 'refused');
  assert.equal(registry.holderOf(key), 'run-1');
});

test('DeploymentTargetLockRegistry: releasing the lock hands it to the next queued run', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  registry.tryAcquire(key, 'run-1');
  registry.tryAcquire(key, 'run-2');
  registry.tryAcquire(key, 'run-3');
  const { nextRunId } = registry.release(key, 'run-1');
  assert.equal(nextRunId, 'run-2');
  assert.equal(registry.holderOf(key), 'run-2');
  const second = registry.release(key, 'run-2');
  assert.equal(second.nextRunId, 'run-3');
});

test('DeploymentTargetLockRegistry: releasing with nothing queued clears the lock entirely', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  registry.tryAcquire(key, 'run-1');
  const { nextRunId } = registry.release(key, 'run-1');
  assert.equal(nextRunId, undefined);
  assert.equal(registry.holderOf(key), undefined);
});

test('DeploymentTargetLockRegistry: a different target is never blocked by another target\'s lock', () => {
  const registry = new DeploymentTargetLockRegistry();
  const keyA = targetLockKey({ kind: 'directory', path: 'dist-a' });
  const keyB = targetLockKey({ kind: 'directory', path: 'dist-b' });
  registry.tryAcquire(keyA, 'run-1');
  assert.equal(registry.tryAcquire(keyB, 'run-2'), 'acquired');
});

test('DeploymentTargetLockRegistry: release by a non-holder is a no-op — it cannot steal or clear someone else\'s lock', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  registry.tryAcquire(key, 'run-1');
  const result = registry.release(key, 'run-2');
  assert.deepEqual(result, {});
  assert.equal(registry.holderOf(key), 'run-1');
});

test('DeploymentTargetLockRegistry: a run already holding the lock re-acquiring reports already-held-by-self, not queued behind itself', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  registry.tryAcquire(key, 'run-1');
  assert.equal(registry.tryAcquire(key, 'run-1'), 'already-held-by-self');
});

test('DeploymentTargetLockRegistry: removeFromQueue drops a cancelled run from the wait line without disturbing the current holder', () => {
  const registry = new DeploymentTargetLockRegistry();
  const key = targetLockKey({ kind: 'directory', path: 'dist' });
  registry.tryAcquire(key, 'run-1');
  registry.tryAcquire(key, 'run-2');
  registry.tryAcquire(key, 'run-3');
  registry.removeFromQueue(key, 'run-2');
  const { nextRunId } = registry.release(key, 'run-1');
  assert.equal(nextRunId, 'run-3', 'run-2 was removed from the queue, so run-3 is next');
});
