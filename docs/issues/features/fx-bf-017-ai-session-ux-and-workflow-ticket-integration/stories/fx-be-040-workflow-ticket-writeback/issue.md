# FX-BE-040 — Ticket-triggered workflow runs with outcome write-back

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** FX-BF-013

## Business or operational impact
Workflows are project-scoped automation, not ticket-triggered — there was no source ticket for a run to write back to, so a run's outcome (pass, fail, cancel) left no trace anywhere a team using a real tracker would see it.

## Scope
- `WorkflowRun` gains an optional `issueKey`/`issueConnectionId` (set at `createWorkflowRun`) and `issueWriteBackAt` (an idempotency marker the host sets after a successful write-back). `WorkflowRunSummary` surfaces `issueKey`; `startRun`'s IPC contract gains an optional `issue: { issueKey, connectionId }`.
- A settled run (succeeded/failed/cancelled) posts a best-effort comment back to its ticket. No status transition — Praxis has no target-status mapping for a tracker's own workflow, and a comment is the one write-back every backend already supports the same way.
- Every run-settling save in `workflowIpc.ts` (start, approve, bypass-gate, manual advance, startup recovery) routes through one `saveRun()` wrapper so a new call site can't silently skip the write-back check the way `approveRun`/`bypassGate` originally did.
- `normalizeWorkflowRun` (the disk-round-trip repair function) updated to preserve the three new fields — it previously reconstructed a run field-by-field and dropped anything it didn't know about.
- The run monitor's "Start a run" form gets an optional ticket picker (the datalist pattern `IssueDetail`'s parent-issue field already uses), populated from the project's own board plus any linked boards, resolving the board's real id via `board.list()` rather than assuming `project.defaultBoardId` (true for app-storage projects, false for folder-backed ones).
- A settled, ticket-linked run shows "Linked to KEY" on the run board immediately, not only once write-back completes.

## Acceptance criteria
- Starting a run with a matched ticket ties it to that ticket; an unmatched key starts an ordinary run rather than guessing at a connection.
- A run that settles via any path (orchestrator-driven completion, Approve, bypass gate, or startup recovery) posts its write-back exactly once.
- The comment never invents a status transition and states the run's outcome, duration, and per-stage result.

## Validation
- `npm run check-types`
- `npm run test:core` (`workflowRun.test.ts`, `workflowRunSummary.test.ts`, `workflowOrchestrator.test.ts`)
- `npm run test:desktop` (`workflowRun.spec.ts`)

## Close when
A workflow run started against a real ticket writes its outcome back as a comment, regardless of which path settled the run.
