---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-040
title: Ticket-triggered workflow runs with outcome write-back
status: complete
feature: FX-BF-017
issue: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/stories/fx-be-040-workflow-ticket-writeback/issue.md
updated: 2026-09-06
commits: [230329a]
dependencies: [FX-BF-013]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Ticket-triggered workflow runs with outcome write-back

## User or operational impact

Workflows were project-scoped automation, not ticket-triggered — there was no
source ticket for a run to write back to, so a run's outcome (pass, fail,
cancel) left no trace anywhere a team using a real tracker would see it.

## As built (`230329a`)

- `WorkflowRun` gains optional `issueKey` / `issueConnectionId` (set at
  `createWorkflowRun`) and `issueWriteBackAt` — an idempotency marker the host
  sets after a successful write-back. `WorkflowRunSummary` surfaces `issueKey`;
  `startRun`'s IPC contract gains an optional `issue: { issueKey, connectionId }`.
- A settled run (succeeded / failed / cancelled) posts a **best-effort comment**
  back to its ticket. **No status transition** — Praxis has no target-status
  mapping for a tracker's own workflow, and a comment is the one write-back
  every backend already supports the same way.
- Every run-settling save in `workflowIpc.ts` (start, approve, bypass-gate,
  manual advance, startup recovery) routes through a single `saveRun()` wrapper,
  so a new call site cannot silently skip the write-back check the way
  `approveRun` / `bypassGate` originally did.
- `normalizeWorkflowRun` (the disk-round-trip repair function) updated to
  preserve the three new fields — it previously rebuilt a run field-by-field and
  dropped anything it didn't know about.
- The run monitor's "Start a run" form gains an optional ticket picker (the
  datalist pattern `IssueDetail`'s parent-issue field already uses), populated
  from the project's own board plus any linked boards, resolving the board's
  real id via `board.list()` rather than assuming `project.defaultBoardId`
  (true for app-storage projects, false for folder-backed ones).
- A settled, ticket-linked run shows "Linked to KEY" on the run board
  immediately, not only once write-back completes.

## Acceptance criteria — verified

- A run started with a matched ticket is tied to it; an unmatched key starts an
  ordinary run rather than guessing at a connection.
- A run settling via **any** path — orchestrator completion, Approve, bypass
  gate, or startup recovery — posts its write-back exactly once.
- The comment never invents a status transition, and states the run's outcome,
  duration, and per-stage result.

## Tests

`workflowRun.test.ts`, `workflowRunSummary.test.ts`, `workflowOrchestrator.test.ts`
(core) and `workflowRun.spec.ts` (e2e).

## Description


## Dependencies



## Comments


