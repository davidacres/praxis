# FX-BE-187: Composer prompt check and session feedback scorecard UI

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-187](../../../../../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/story.md).

## Impact and scope

Users can check a prompt's readiness score directly in the session composer before sending, or inspect a completed session's 5-dimension deterministic scorecard, audit the tools/skills/agents/MCPs used, submit structured feedback, and apply one-click remediation actions.

## Dependencies

FX-BE-186

## Acceptance criteria

- 492: Clicking "Score Prompt" in the composer displays the `prompt-readiness` score (`0–100`), dimension bars, and one-click buttons that attach a recommended skill, switch `toolMode`, select a recommended agent profile, or apply the improved prompt text.
- 493: `SessionInspector` and completed transcript turns provide a "Feedback & Score" surface showing the deterministic `session-execution` score (`0–100`), the 5 dimension sub-scores, the inventory of prompts/tools/MCPs/skills/agent used, and each finding's remediation.
- 493: Submitting user feedback (`verdict`, `frictionTags`, `notes`) updates the scorecard immediately and persists the badge on the session row.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
