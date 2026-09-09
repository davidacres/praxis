---
type: Task
id: TASK-136
title: "Bound repair attempts and freshness"
status: in-progress
story: FX-BE-052
updated: 2026-09-07
dependencies: [TASK-135]
---

# TASK-136: Bound repair attempts and freshness

**Priority:** High
**Created:** 2026-09-07

## Goal

Use existing workflow stages with explicit attempt and elapsed-time budgets; freeze each changed snapshot and invalidate prior verification when that snapshot changes.

## Implementation entry points

packages/core/src/ai; packages/core/src/workflows; renderer/src/ai. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-135
## Acceptance criteria

- An unresolved reproduction stops with an actionable reason; stale green checks cannot pass a repaired snapshot; cancellation stops local child processes.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the state machine is implemented and thoroughly unit-tested; it is not yet wired into a
live diagnosis session's actual event flow (agent completion, verify dispatch). Left `in-progress`.**

**Interpretation of "use existing workflow stages":** read literally as reusing the workflow engine's
orchestrator/scheduler wholesale, that would mean routing every diagnosis session through a real
multi-node `WorkflowRun` (approval gates, join semantics and all) — a mismatch for what is meant to
be a light, closed reproduce→fix→verify loop, and a risky rewrite of TASK-135's already-tested
session-starting path. Interpreted instead as: reuse the *shape* workflow stages already established
for exactly this problem — `WorkflowNodeAttempt`'s bounded, numbered attempts
(`maxAttempts`/`timeoutMs`), and `workflowStageSession.ts`'s `findSnapshot` discipline ("Review...
inspects *this*, not whatever the worktree happens to hold by the time it runs") — without forcing
diagnosis through the full orchestrator. Recorded here so the interpretation is checkable, not
assumed.

**Implemented:** `packages/core/src/ai/diagnosisState.ts` (new) — `DiagnosisState`/`DiagnosisAttempt`
(the same numbered-attempt shape as `WorkflowNodeAttempt`), `canAttemptDiagnosis`/
`isDiagnosisTimedOut` (mirroring `canRetry`), `freezeDiagnosisSnapshot` (records a new snapshot ref
for the current attempt), and `recordDiagnosisVerification` — the load-bearing function: a
verification is applied only when its `snapshotRef` still equals `state.currentSnapshotRef`; anything
verified against a superseded snapshot is rejected with `{ applied: false, reason: 'stale-snapshot' }`
rather than silently accepted. `retryOrResolveDiagnosis`/`markUnreproduced`/`timeoutDiagnosisAttempt`
settle the session as `unresolved` with a stated reason once the attempt budget is spent — "an
unresolved reproduction stops with an actionable reason." `cancelDiagnosis` records cancellation;
actually stopping the local child process is TASK-133's existing `AbortSignal` chain through
`spawnCheck`/`runWorkflowCheck` (already tested there — "cancellation terminates an active check that
ignores SIGTERM"), reused as-is once a verify step is wired to call it.

**Commands run:** `npm run test:core` — 506/506 (16 new: stale-snapshot rejection, verification
applied only against the current snapshot, attempt-budget exhaustion producing the exact "exhausted
(N/N)" message, timeout counting against the budget, cancellation idempotence, and that
`retryOrResolveDiagnosis`/`freezeDiagnosisSnapshot` are no-ops once a session has settled).
`check-types` — clean.

**Remaining limitations — this is the honest gap:**
- `DiagnosisState` is not yet persisted or driven by real events. Nothing in
  `diagnosisSession.ts` (TASK-135) yet creates a `DiagnosisState`, calls `freezeDiagnosisSnapshot`
  when an ACP session's fix lands, or calls a verify step (`runWorkflowCheck` against the frozen
  snapshot) and feeds its result into `recordDiagnosisVerification`. The state machine is proven
  correct in isolation; wiring it to the actual session lifecycle — which needs to react to ACP
  session-update events the way `workflowAgentStage.ts` does for workflow stages — is real remaining
  work, naturally continuous with TASK-137 ("show diagnosis and verified outcomes"), which needs the
  same wiring to have anything to show.
- Cancellation propagation from a `DiagnosisState` transition to a live `AbortController` is not
  wired; only the state-recording half exists here.
