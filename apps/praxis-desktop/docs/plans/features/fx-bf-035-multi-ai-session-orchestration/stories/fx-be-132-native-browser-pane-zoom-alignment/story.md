---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-132
title: "Native browser pane geometry at app zoom"
status: Complete
feature: FX-BF-035
issue: docs/issues/features/fx-bf-035-multi-ai-session-orchestration/stories/fx-be-132-native-browser-pane-zoom-alignment/issue.md
updated: 2026-09-20
tasks: [TASK-360]
dependencies: [FX-BE-096]
validation: [npm run check-types --workspace=@praxis/desktop-main, npm run test:desktop, git diff --check]
---

# FX-BE-132: Native browser pane geometry at app zoom

## Outcome

The in-app native browser and project preview remain flush with their renderer
placeholders when the Praxis window is zoomed.

## Acceptance criteria

- Browser bounds convert renderer CSS coordinates into native view coordinates
  using the window zoom factor.
- The AI browser and project preview use the same correction.
- 100% and 150% zoom visual checks show no gap, drift, or overhang.

## Tasks

- `TASK-360` — Apply and verify zoom-aware native browser bounds.

## Close when

Both native browser surfaces are corrected and visually verified at default and
non-default app zoom. **Met.**

## Description


## Dependencies



## Comments


