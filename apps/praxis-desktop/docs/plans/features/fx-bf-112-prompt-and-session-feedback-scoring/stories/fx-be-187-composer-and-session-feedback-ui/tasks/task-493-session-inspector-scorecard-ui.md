---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-493
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-187
---

# TASK-493: Add post-session feedback form, deterministic scorecard, and one-click remediations

Parent: [FX-BE-187](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `apps/praxis-desktop/renderer/src/ai/SessionFeedbackPanel.tsx` and wire it into `SessionInspector.tsx` and completed assistant turn footers in `SessionChatThread.tsx`. Render the deterministic `0–100` score, 5 dimension progress bars, audited inventory (prompts, tools, MCPs, agent profile, attached/detected/recommended skills), ordered findings with "How it should have done better" guidance, and the human feedback form (`verdict`, `frictionTags`, `notes`).

## Dependencies

TASK-492

## Acceptance criteria

- Renders all 5 dimensions with earned vs max points (`20 / 25 / 20 / 15 / 20`) and expandable evidence rows.
- Shows the complete capability audit: tools called, MCP tools vs configured MCP servers, agent profile, attached skills, detected skills, and missed trigger-matched skills.
- Submitting user feedback (`helpful`, `needs-work`, `failed-goal`, friction tags, free-text notes) calls `window.praxis.ai.submitSessionFeedback` and updates the deterministic score and session badge live.
- Provides a "Apply improvements to follow-up" action that populates the session composer with the recommended skills, tool mode, and refined follow-up prompt.

## Validation

Build the renderer (`npm run build:renderer`) and verify via E2E in `TASK-495`.

## Done when

`SessionFeedbackPanel` is accessible from `SessionInspector` and transcript turns, and all acceptance criteria pass.

## Description


## Comments
