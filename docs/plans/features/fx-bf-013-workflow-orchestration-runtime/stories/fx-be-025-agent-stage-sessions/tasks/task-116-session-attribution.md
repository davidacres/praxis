---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-116
title: Attribute stage sessions to their workflow run and node
status: proposed
story: FX-BE-025
updated: 2026-09-02
dependencies: [TASK-114]
validation: [npm run build, npm run test:core, npm run test:desktop]
---
## Attribute stage sessions to their workflow run and node
## Goal
Make a stage session traceable from the Sessions view back to the run and node
it belongs to.
## Done when
- `AgentSessionRecord` carries optional `workflowRunId` / `workflowNodeId`, set
  when the orchestrator starts the session.
- The Sessions list shows a badge / filter for workflow-run sessions and links
  to the run monitor.
- The run monitor's stage row links to the underlying session.
- `stageSessions(run)` / `currentStageSession` (already in core) resolve the
  same ids the record carries.
## Notes
This completes the TASK-099 intent — the contract existed, this is the wiring
into `AiSessionManager` and the UI.

## Description


## Dependencies



## Comments


