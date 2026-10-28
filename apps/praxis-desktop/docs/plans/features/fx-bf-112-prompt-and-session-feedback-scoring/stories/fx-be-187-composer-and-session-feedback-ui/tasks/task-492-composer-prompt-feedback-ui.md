---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-492
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-187
---

# TASK-492: Add pre-send prompt analyzer and score preview to the session composer

Parent: [FX-BE-187](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `apps/praxis-desktop/renderer/src/ai/PromptFeedbackPopover.tsx` and integrate a composer action button (`data-testid="composer-score-prompt-btn"`) into `NewSession.tsx` and `SessionsPage.tsx`. Pass the current draft text, `toolMode`, `sessionMode`, `profileId`, `activeSkills`, and project/ticket context to `window.praxis.ai.evaluatePrompt`.

## Dependencies

TASK-490, TASK-491

## Acceptance criteria

- Displays overall `prompt-readiness` score (`0–100`) and grade badge (`A`–`F`), dimension breakdown, and findings list.
- Clicking a remediation action (`attach-skill`, `select-agent`, `change-tool-mode`, `refine-prompt`) updates the composer state directly and re-evaluates the prompt score deterministically.
- Passes `npm run check-core-imports` with zero value imports from `@praxis/core`.

## Validation

Build the renderer (`npm run build:renderer`) and verify via E2E in `TASK-495`.

## Done when

`PromptFeedbackPopover` renders in both `NewSession` and `SessionsPage` composers and all acceptance criteria pass.

## Description


## Comments
