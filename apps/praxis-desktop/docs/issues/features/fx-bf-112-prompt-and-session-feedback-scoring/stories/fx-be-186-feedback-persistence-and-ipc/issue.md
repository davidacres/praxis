# FX-BE-186: Feedback persistence, IPC commands, and optional AI prompt rewrite

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-186](../../../../../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/story.md).

## Impact and scope

Evaluations and human feedback for prompts and sessions persist across restarts, are accessible over typed IPC, and can optionally generate an AI-assisted prompt rewrite grounded in the deterministic findings without altering the deterministic score.

## Dependencies

FX-BE-185

## Acceptance criteria

- 490: Submitting feedback or evaluating a session persists the `DeterministicFeedbackReport` in `session-feedback.json`, updates `AgentSessionRecord.feedbackSummary`, and survives an app restart.
- 490: `ai:evaluatePrompt` resolves the current workspace skill/agent catalog and configured MCP servers in main before invoking `evaluateSessionOrPrompt`.
- 491: `ai:rewritePromptFromFeedback` returns a suggested prompt rewrite and rationale grounded in the report's `findings`, without modifying `overallScore`, `grade`, or `dimensions`.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
