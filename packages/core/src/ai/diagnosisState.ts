/**
 * Bounded diagnosis attempts and snapshot freshness (FX-BE-052 / TASK-136).
 *
 * A diagnosis session repeats a reproduce → hypothesize → fix → verify loop,
 * and every step of that loop can go wrong in a way that must stop it rather
 * than spin it forever: an agent that cannot reproduce the failure, a fix
 * that still doesn't pass, or a verification run that finishes against a
 * snapshot a later change has already superseded.
 *
 * This reuses the exact bounding shape `workflowRun.ts` already established
 * for a workflow stage's attempts (`WorkflowNodeAttempt`, `maxAttempts`,
 * `timeoutMs`) and the freeze-and-inspect discipline `workflowStageSession.ts`
 * established for snapshots (`findSnapshot` — "Review... inspects *this*, not
 * whatever the worktree happens to hold by the time it runs") rather than
 * inventing a second, differently-shaped attempt model. A diagnosis session
 * is lighter than a governed workflow run (no approval gate, no branching),
 * so it gets its own small state machine instead of being forced through the
 * full orchestrator — but the shape of "bounded, attempt-numbered, one
 * snapshot at a time" is deliberately the same one.
 */

export type DiagnosisAttemptOutcome = 'running' | 'verified' | 'failed' | 'cancelled';

export interface DiagnosisAttempt {
  /** 1-based, matching WorkflowNodeAttempt.attempt. */
  attempt: number;
  outcome: DiagnosisAttemptOutcome;
  startedAt: string;
  endedAt?: string;
  /** The commit/worktree ref this attempt's fix froze, once it made one. */
  snapshotRef?: string;
  /** Set only once verification actually ran against snapshotRef, above. */
  verifiedAt?: string;
  error?: string;
}

export interface DiagnosisPolicy {
  maxAttempts: number;
  timeoutMs: number;
}

export const DEFAULT_DIAGNOSIS_POLICY: DiagnosisPolicy = { maxAttempts: 3, timeoutMs: 30 * 60 * 1000 };

export type DiagnosisStatus = 'running' | 'verified' | 'unresolved' | 'cancelled';

export interface DiagnosisState {
  sessionKey: string;
  attempts: DiagnosisAttempt[];
  /** The most recently frozen snapshot, if any. Cleared to a new value whenever an attempt freezes one — never reused across attempts. */
  currentSnapshotRef?: string;
  status: DiagnosisStatus;
  /** Present once status settles to 'unresolved' — the actionable reason a caller shows verbatim. */
  unresolvedReason?: string;
}

export function startDiagnosisState(sessionKey: string, at: string): DiagnosisState {
  return {
    sessionKey,
    attempts: [{ attempt: 1, outcome: 'running', startedAt: at }],
    status: 'running'
  };
}

function currentAttempt(state: DiagnosisState): DiagnosisAttempt | undefined {
  return state.attempts[state.attempts.length - 1];
}

/** Whether another attempt is allowed under the policy — the same question `canRetry(run, nodeId)` answers for a workflow stage. */
export function canAttemptDiagnosis(state: DiagnosisState, policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY): boolean {
  return state.status === 'running' && state.attempts.length < policy.maxAttempts;
}

export function isDiagnosisTimedOut(state: DiagnosisState, now: string, policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY): boolean {
  const attempt = currentAttempt(state);
  if (!attempt || attempt.outcome !== 'running') return false;
  return Date.parse(now) - Date.parse(attempt.startedAt) >= policy.timeoutMs;
}

/**
 * Freezes a new snapshot for the current attempt. Any prior verification is
 * discarded here, not merely left stale and hoped nobody reads it: a check
 * that passed against the last snapshot says nothing about this one, so
 * `verifiedAt` on the *previous* record stays exactly what it was (history is
 * never rewritten) while `currentSnapshotRef` moves on — that is what makes a
 * verification against the old ref rejected as stale, below.
 */
export function freezeDiagnosisSnapshot(state: DiagnosisState, snapshotRef: string): DiagnosisState {
  const attempts = [...state.attempts];
  const last = attempts[attempts.length - 1];
  if (!last || last.outcome !== 'running') return state;
  attempts[attempts.length - 1] = { ...last, snapshotRef };
  return { ...state, attempts, currentSnapshotRef: snapshotRef };
}

export interface RecordVerificationInput {
  /** The snapshot the verification actually ran against. */
  snapshotRef: string;
  passed: boolean;
  at: string;
  error?: string;
}

export type RecordVerificationResult =
  | { applied: true; state: DiagnosisState }
  | { applied: false; reason: 'stale-snapshot' };

/**
 * Records a verification result. Accepted only when `snapshotRef` still
 * matches the state's current frozen snapshot — a verification run kicked
 * off against an older snapshot that only finishes after a newer fix has
 * already landed is rejected as stale, not applied to the wrong attempt.
 */
export function recordDiagnosisVerification(state: DiagnosisState, input: RecordVerificationInput): RecordVerificationResult {
  if (!state.currentSnapshotRef || input.snapshotRef !== state.currentSnapshotRef) {
    return { applied: false, reason: 'stale-snapshot' };
  }
  const attempts = [...state.attempts];
  const last = attempts[attempts.length - 1];
  if (!last || last.outcome !== 'running') return { applied: false, reason: 'stale-snapshot' };

  if (input.passed) {
    attempts[attempts.length - 1] = { ...last, outcome: 'verified', endedAt: input.at, verifiedAt: input.at };
    return { applied: true, state: { ...state, attempts, status: 'verified' } };
  }

  attempts[attempts.length - 1] = { ...last, outcome: 'failed', endedAt: input.at, error: input.error ?? 'Verification failed.' };
  return { applied: true, state: { ...state, attempts } };
}

/**
 * Opens the next attempt when the policy still allows one; otherwise settles
 * the session as `unresolved` with an actionable reason. This is the "an
 * unresolved reproduction stops with an actionable reason" contract — a
 * session that runs out of budget always ends with a stated reason, never a
 * silent stop.
 */
export function retryOrResolveDiagnosis(
  state: DiagnosisState,
  at: string,
  policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY
): DiagnosisState {
  if (state.status !== 'running') return state;
  const last = currentAttempt(state);
  if (last?.outcome === 'running') return state; // Still mid-attempt; nothing to resolve yet.

  if (canAttemptDiagnosis(state, policy)) {
    return {
      ...state,
      attempts: [...state.attempts, { attempt: state.attempts.length + 1, outcome: 'running', startedAt: at }]
    };
  }
  return {
    ...state,
    status: 'unresolved',
    unresolvedReason: `Repair attempts exhausted (${state.attempts.length}/${policy.maxAttempts}); the check still fails.`
  };
}

/**
 * Marks the current attempt as having failed to even reproduce the failure
 * (the agent found nothing to fix, or ran out of steps before making a
 * change), then applies the same retry-or-resolve budget as any other
 * failure — an unreproduced attempt is not exempt from the attempt cap.
 */
export function markUnreproduced(
  state: DiagnosisState,
  at: string,
  reason: string,
  policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY
): DiagnosisState {
  const attempts = [...state.attempts];
  const last = attempts[attempts.length - 1];
  if (last && last.outcome === 'running') attempts[attempts.length - 1] = { ...last, outcome: 'failed', endedAt: at, error: reason };
  return retryOrResolveDiagnosis({ ...state, attempts }, at, policy);
}

/** Stops the current attempt as cancelled and settles the whole session — the local child process for that attempt is stopped by the same AbortSignal chain runWorkflowCheck/spawnCheck already implement (FX-BE-024/TASK-112); this just records the outcome once it happens. */
export function cancelDiagnosis(state: DiagnosisState, at: string): DiagnosisState {
  if (state.status !== 'running') return state;
  const attempts = [...state.attempts];
  const last = attempts[attempts.length - 1];
  if (last && last.outcome === 'running') attempts[attempts.length - 1] = { ...last, outcome: 'cancelled', endedAt: at };
  return { ...state, attempts, status: 'cancelled' };
}

/** A timed-out attempt is treated as an unreproduced failure of that attempt, subject to the same attempt cap. */
export function timeoutDiagnosisAttempt(
  state: DiagnosisState,
  at: string,
  policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY
): DiagnosisState {
  return markUnreproduced(state, at, `Attempt exceeded its ${policy.timeoutMs}ms budget.`, policy);
}
