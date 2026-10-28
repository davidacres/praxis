---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Story
**Priority:** High
id: FX-BE-187
type: Story
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
issue: docs/issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/issue.md
---

# FX-BE-187: Composer prompt check and session feedback scorecard UI

Parent: [FX-BF-112](../../feature.md). Issue mirror: [FX-BE-187](../../../../../issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/issue.md).

## User or operational impact

Users can check a prompt's readiness score directly in the session composer before sending, or inspect a completed session's 5-dimension deterministic scorecard, audit the tools/skills/agents/MCPs used, submit structured feedback, and apply one-click remediation actions.

## Scope

- Add `PromptFeedbackPopover.tsx` to `NewSession.tsx` and `SessionsPage.tsx` composer controls so users can score a draft prompt, see missed skills/agent/tool-mode mismatches, and apply remediations in one click.
- Add `SessionFeedbackPanel.tsx` to `SessionInspector.tsx` (and a turn-level trigger in `SessionChatThread.tsx`) displaying the deterministic `0–100` score badge, 5-dimension progress bars, tool/skill/agent/MCP inventory, ordered findings ("How it should have done better"), and human feedback controls (`helpful` / `needs-work` / `failed-goal`, friction tags, and notes).

## Dependencies

FX-BE-186

## Acceptance criteria

- 492: Clicking "Score Prompt" in the composer displays the `prompt-readiness` score (`0–100`), dimension bars, and one-click buttons that attach a recommended skill, switch `toolMode`, select a recommended agent profile, or apply the improved prompt text.
- 493: `SessionInspector` and completed transcript turns provide a "Feedback & Score" surface showing the deterministic `session-execution` score (`0–100`), the 5 dimension sub-scores, the inventory of prompts/tools/MCPs/skills/agent used, and each finding's remediation.
- 493: Submitting user feedback (`verdict`, `frictionTags`, `notes`) updates the scorecard immediately and persists the badge on the session row.

## Tasks

- [TASK-492: Add pre-send prompt analyzer and score preview to the session composer](tasks/task-492-composer-prompt-feedback-ui.md)
- [TASK-493: Add post-session feedback form, deterministic scorecard, and one-click remediations](tasks/task-493-session-inspector-scorecard-ui.md)

## Validation

Run `npm run check-core-imports`, `npm run check-types`, `npm run build:renderer`, and `npm run desktop:copy-renderer`.

## Close when

Both tasks meet all acceptance criteria, keep `@praxis/core` imports type-only, and build cleanly into the desktop renderer.

## Description


## Comments
