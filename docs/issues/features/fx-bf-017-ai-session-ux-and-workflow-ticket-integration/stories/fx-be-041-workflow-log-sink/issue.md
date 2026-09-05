# FX-BE-041 — Wire workflow failures into the Output tab's log bus

**Type:** Story  **Status:** Complete  **Priority:** P3  **Depends on:** FX-BE-040

## Business or operational impact
The Output tab already tailed the shared log bus for AI sessions and Jira/GitLab backend calls (`[ai]`/`[jira]`/`[gitlab]` tags), but the workflow subsystem never wired in — a write-back failure or a worktree snapshot that couldn't be frozen went to a bare `console.error` no UI ever surfaces, discoverable only with a main-process console attached.

## Scope
- New `workflowLogSink.ts`: a `[workflow]`-tagged tee of the log bus, colocated outside both consumers to avoid a cycle (`workflowAgentStage.ts` is imported by `workflowOrchestratorInstance.ts`).
- Two existing bare `console.error` calls routed through it: a write-back failure in `writeBackToIssue`, and a worktree-snapshot failure in `freezeWorktree`.
- Deliberately not a blanket per-stage-failure logger: a run's own stage failures/timeouts already show in the run monitor's timeline and stage detail (they're part of `WorkflowRun.events`) — mirroring those into the global bus too would just duplicate that UI. This is only for failures with no other visible surface at all.

## Acceptance criteria
- A write-back failure (e.g. a ticket that no longer exists) appears in the Output tab tagged `[workflow]`, including the run id and ticket key.
- Ordinary stage failures/timeouts, already visible in the run monitor, are not duplicated into the global log.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`workflowRun.spec.ts`)

## Close when
A workflow-subsystem failure with no other UI is visible in the Output tab, the same way an AI session or backend-service failure already is.
