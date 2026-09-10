---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-115
title: Wire stage completion, artifact extraction, and the snapshot commit
status: Done
story: FX-BE-025
updated: 2026-09-02
dependencies: [TASK-114, TASK-113]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-115: Wire stage completion, artifact extraction, and the snapshot commit
## Wire stage completion, artifact extraction, and the snapshot commit
## Goal
Close the loop between a finished agent session and the run.
## Done when
- A subscription to `AiSessionManager` lifecycle detects a workflow-attributed
  session reaching `completed` / `failed` / `aborted`.
- For a mutating stage the run worktree is committed and the sha recorded as the
  stage's `snapshotRef`; a non-mutating stage inherits the upstream snapshot.
- Typed artifacts are extracted from the session output against the node's
  declared `outputs` (diff from the commit, report / plan from the transcript
  result); an undeclared artifact is dropped.
- The orchestrator is handed `node-succeeded` with those artifacts or
  `node-failed` with the reason, and re-schedules.
- A session that ends with none of its required artifacts fails the stage.
## Notes
`updateAgentOutput` / `updateAgentDelivery` on `AiSessionManager` already capture
the result payload. The engine's `settleNode` enforces the required-artifact
check — this task just supplies real artifacts.

## Description


## Dependencies



## Comments


