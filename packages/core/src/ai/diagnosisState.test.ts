import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelDiagnosis,
  canAttemptDiagnosis,
  DEFAULT_DIAGNOSIS_POLICY,
  freezeDiagnosisSnapshot,
  isDiagnosisTimedOut,
  markUnreproduced,
  recordDiagnosisVerification,
  retryOrResolveDiagnosis,
  startDiagnosisState,
  timeoutDiagnosisAttempt,
  type DiagnosisPolicy
} from './diagnosisState';

const T0 = '2026-09-08T00:00:00.000Z';
const POLICY: DiagnosisPolicy = { maxAttempts: 2, timeoutMs: 60_000 };

test('a fresh session starts running with one open attempt', () => {
  const state = startDiagnosisState('diag-1', T0);
  assert.equal(state.status, 'running');
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].outcome, 'running');
});

// ── Snapshot freshness ──────────────────────────────────────────────────

test('a verification against the current snapshot is applied and settles the session as verified', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = freezeDiagnosisSnapshot(state, 'sha-1');
  const result = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: true, at: T0 });
  assert.equal(result.applied, true);
  if (result.applied) {
    assert.equal(result.state.status, 'verified');
    assert.equal(result.state.attempts[0].verifiedAt, T0);
  }
});

test('a verification against a snapshot that is no longer current is rejected as stale', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = freezeDiagnosisSnapshot(state, 'sha-1');
  // A second fix landed before the first verification came back.
  state = freezeDiagnosisSnapshot(state, 'sha-2');
  const result = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: true, at: T0 });
  assert.deepEqual(result, { applied: false, reason: 'stale-snapshot' });
});

test('a verification with no snapshot ever frozen is rejected, not silently accepted', () => {
  const state = startDiagnosisState('diag-1', T0);
  const result = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: true, at: T0 });
  assert.deepEqual(result, { applied: false, reason: 'stale-snapshot' });
});

test('freezing a new snapshot never resurrects an already-recorded verification for a prior attempt', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = freezeDiagnosisSnapshot(state, 'sha-1');
  const verified = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: true, at: T0 });
  assert.equal(verified.applied, true);
  if (!verified.applied) return;
  // The session is settled 'verified'; freezing again is a no-op because the
  // current attempt is no longer 'running'.
  const after = freezeDiagnosisSnapshot(verified.state, 'sha-2');
  assert.equal(after.currentSnapshotRef, 'sha-1');
  assert.equal(after.attempts[0].snapshotRef, 'sha-1');
});

test('a failing verification against the current snapshot keeps the session running for a retry decision', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = freezeDiagnosisSnapshot(state, 'sha-1');
  const result = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: false, at: T0, error: 'still exits 1' });
  assert.equal(result.applied, true);
  if (result.applied) {
    assert.equal(result.state.status, 'running');
    assert.equal(result.state.attempts[0].outcome, 'failed');
    assert.equal(result.state.attempts[0].error, 'still exits 1');
  }
});

// ── Attempt budget ──────────────────────────────────────────────────────

test('canAttemptDiagnosis is true until the attempt cap is reached', () => {
  const state = startDiagnosisState('diag-1', T0);
  assert.equal(canAttemptDiagnosis(state, POLICY), true);
});

test('retryOrResolveDiagnosis opens a new attempt when the policy still allows one', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = markUnreproduced(state, T0, 'No hypothesis formed.', POLICY);
  assert.equal(state.status, 'running');
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].outcome, 'failed');
  assert.equal(state.attempts[0].error, 'No hypothesis formed.');
  assert.equal(state.attempts[1].outcome, 'running');
});

test('exhausting the attempt budget settles the session as unresolved with an actionable reason', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = markUnreproduced(state, T0, 'No hypothesis formed.', POLICY); // attempt 2 opens
  state = markUnreproduced(state, T0, 'Fix did not apply.', POLICY); // budget (2) spent
  assert.equal(state.status, 'unresolved');
  assert.equal(canAttemptDiagnosis(state, POLICY), false);
  assert.match(state.unresolvedReason ?? '', /exhausted \(2\/2\)/);
});

test('a session already settled unresolved does not reopen a further attempt', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = markUnreproduced(state, T0, 'a', POLICY);
  state = markUnreproduced(state, T0, 'b', POLICY);
  const before = state;
  state = retryOrResolveDiagnosis(state, T0, POLICY);
  assert.deepEqual(state, before);
});

test('retryOrResolveDiagnosis is a no-op while the current attempt is still running', () => {
  const state = startDiagnosisState('diag-1', T0);
  const after = retryOrResolveDiagnosis(state, T0, POLICY);
  assert.deepEqual(after, state);
});

// ── Timeout ─────────────────────────────────────────────────────────────

test('isDiagnosisTimedOut is false before the budget elapses and true at or after it', () => {
  const state = startDiagnosisState('diag-1', T0);
  assert.equal(isDiagnosisTimedOut(state, '2026-09-08T00:00:59.999Z', POLICY), false);
  assert.equal(isDiagnosisTimedOut(state, '2026-09-08T00:01:00.000Z', POLICY), true);
});

test('a timed-out attempt counts against the attempt budget like any other failure', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = timeoutDiagnosisAttempt(state, '2026-09-08T00:01:00.000Z', POLICY);
  assert.equal(state.status, 'running');
  assert.equal(state.attempts[0].outcome, 'failed');
  assert.match(state.attempts[0].error ?? '', /budget/);
  assert.equal(state.attempts.length, 2);
});

// ── Cancellation ────────────────────────────────────────────────────────

test('cancelling a running session marks the open attempt cancelled and settles the session', () => {
  const state = startDiagnosisState('diag-1', T0);
  const after = cancelDiagnosis(state, '2026-09-08T00:00:05.000Z');
  assert.equal(after.status, 'cancelled');
  assert.equal(after.attempts[0].outcome, 'cancelled');
  assert.equal(after.attempts[0].endedAt, '2026-09-08T00:00:05.000Z');
});

test('cancelling an already-settled session is a no-op', () => {
  let state = startDiagnosisState('diag-1', T0);
  state = freezeDiagnosisSnapshot(state, 'sha-1');
  const verified = recordDiagnosisVerification(state, { snapshotRef: 'sha-1', passed: true, at: T0 });
  assert.equal(verified.applied, true);
  if (!verified.applied) return;
  const after = cancelDiagnosis(verified.state, T0);
  assert.deepEqual(after, verified.state);
});

test('the default policy allows 3 attempts', () => {
  assert.equal(DEFAULT_DIAGNOSIS_POLICY.maxAttempts, 3);
});
