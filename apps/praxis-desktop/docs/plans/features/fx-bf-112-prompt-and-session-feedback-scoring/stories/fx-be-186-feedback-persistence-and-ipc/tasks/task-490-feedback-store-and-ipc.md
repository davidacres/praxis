---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-490
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-186
---

# TASK-490: Persist session and prompt feedback evaluations and expose typed IPC

Parent: [FX-BE-186](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Implement `SessionFeedbackStore` in `packages/core/src/ai/feedback/sessionFeedbackStore.ts` and expose `evaluatePrompt`, `evaluateSession`, `submitSessionFeedback`, and `getSessionFeedback` through `packages/core/src/host/ipcContracts.ts`, `apps/praxis-desktop/main/src/main/aiIpc.ts`, and `apps/praxis-desktop/main/src/preload/index.ts`. Load full session transcripts when evaluating unloaded historical sessions.

## Dependencies

TASK-489

## Acceptance criteria

- Evaluating an unloaded historical session loads its transcript events before running `evaluateSessionOrPrompt`.
- `SessionFeedbackStore` persists reports by `sessionId` (and optional `turnIndex`) and updates `AgentSessionRecord.feedbackSummary` (`{ overallScore, grade, verdict, updatedAt }`).
- Preload exposes typed `window.praxis.ai.evaluatePrompt`, `evaluateSession`, `submitSessionFeedback`, and `getSessionFeedback` methods.

## Validation

Add unit tests in `packages/core/src/ai/feedback/sessionFeedbackStore.test.ts` and register in `packages/core/package.json`.

## Done when

Store and IPC tests pass and `npm run check-types` succeeds.

## Description


## Comments
