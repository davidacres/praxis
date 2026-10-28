---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Story
**Priority:** High
id: FX-BE-186
type: Story
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
issue: docs/issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/issue.md
---

# FX-BE-186: Feedback persistence, IPC commands, and optional AI prompt rewrite

Parent: [FX-BF-112](../../feature.md). Issue mirror: [FX-BE-186](../../../../../issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/issue.md).

## User or operational impact

Evaluations and human feedback for prompts and sessions persist across restarts, are accessible over typed IPC, and can optionally generate an AI-assisted prompt rewrite grounded in the deterministic findings without altering the deterministic score.

## Scope

- Implement `SessionFeedbackStore` in `packages/core/src/ai/feedback/sessionFeedbackStore.ts` backed by profile-local `session-feedback.json`, and wire `ai:evaluatePrompt`, `ai:evaluateSession`, `ai:submitSessionFeedback`, `ai:getSessionFeedback`, and `ai:rewritePromptFromFeedback` in `ipcContracts.ts`, `main/src/main/aiIpc.ts`, and `main/src/preload/index.ts`.
- Implement `promptRewriteHelper.ts` to build a bounded prompt-improvement request from a `DeterministicFeedbackReport` while preserving `overallScore` and `dimensions` untouched.

## Dependencies

FX-BE-185

## Acceptance criteria

- 490: Submitting feedback or evaluating a session persists the `DeterministicFeedbackReport` in `session-feedback.json`, updates `AgentSessionRecord.feedbackSummary`, and survives an app restart.
- 490: `ai:evaluatePrompt` resolves the current workspace skill/agent catalog and configured MCP servers in main before invoking `evaluateSessionOrPrompt`.
- 491: `ai:rewritePromptFromFeedback` returns a suggested prompt rewrite and rationale grounded in the report's `findings`, without modifying `overallScore`, `grade`, or `dimensions`.

## Tasks

- [TASK-490: Persist session and prompt feedback evaluations and expose typed IPC](tasks/task-490-feedback-store-and-ipc.md)
- [TASK-491: Add optional remediation prompt rewriter grounded in deterministic findings](tasks/task-491-remediation-prompt-rewriter.md)

## Validation

Run `npm run build:core`, `npm run test:core`, `npm run build:desktop`, and `npm run check-types`.

## Close when

Both tasks pass unit and IPC contract tests and `check-types` succeeds across all workspaces.

## Description


## Comments
