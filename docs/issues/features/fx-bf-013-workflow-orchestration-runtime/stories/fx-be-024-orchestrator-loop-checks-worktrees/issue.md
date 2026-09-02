# FX-BE-024 — Orchestrator loop, check execution, and run worktrees

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-019, FX-BE-022

## Business or operational impact
The deterministic half of a run must advance on its own against a stable
snapshot, with no manual stage clicks.

## Scope
- A main-process `WorkflowOrchestrator` that dispatches what `scheduleWorkflowRun`
  reports ready, applies the commands, and re-schedules.
- Deterministic check execution in the run worktree with exit-code outcome and
  captured output.
- One git worktree per run, created on start, cleaned up on settle/cancel.

## Acceptance criteria
- A checks-and-joins-only workflow runs to completion or a blocked state with no
  user action.
- A check's exit code decides its gate; its output is an inspectable artifact.
- Mutating stages never run against the worktree concurrently.
- The run worktree is reused by every stage and removed when the run ends.

## Validation
- `npm run build`
- `npm run test:core`
- `npm run test:desktop`

## Close when
A workflow whose only agent stage is stubbed runs its checks, joins, and gate
evaluation end to end against one per-run worktree.
