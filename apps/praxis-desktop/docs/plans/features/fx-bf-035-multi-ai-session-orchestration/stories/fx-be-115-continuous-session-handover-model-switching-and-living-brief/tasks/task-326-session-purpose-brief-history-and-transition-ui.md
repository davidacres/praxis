---
**Status:** ✅ Complete
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-326
title: "Add purpose, brief, runtime history and transition controls to the session UI"
status: Done
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-322, TASK-323, TASK-324, TASK-325, FX-BF-015]
---

# TASK-326: Add purpose, brief, runtime history and transition controls to the session UI

## Objective

Make the right sidebar explain why the session exists and what has happened, while
placing model/provider transition controls beside the composer where the user is
about to send the next turn.

## Implementation notes

- Add a Purpose section to `SessionInspector`'s summary surface showing the source
  ticket/plan key and title, goal, scope and definition of done, with a useful
  `taskDefinition` fallback for migrated sessions.
- Render the living brief as scannable progress, changes, decisions, blockers,
  questions and next-step sections. Show freshness and update time, and provide
  revision-safe editing with protected user notes.
- Add runtime history listing provider/model epochs and transition reasons without
  mixing ACP context occupancy with cumulative API token totals.
- Keep current provider, model, tool access, folder/worktree and the Change model /
  Hand over actions on the composer's existing controls row. Do not move those
  action-time facts into the inspector.
- Use themed in-app dialogs for model selection and handover review. The handover
  dialog previews the editable brief and explains which state transfers and which
  native state restarts.
- Disable transitions while executing or awaiting approval/input, retain the
  global `:focus-visible` treatment, and follow the active surface-pack recipe for
  every new dialog shell.

## Acceptance criteria

- Ticket-backed, plan-backed and migrated sessions all show a meaningful purpose.
- Brief editing handles stale revisions without losing either version.
- Runtime history clearly identifies every model/provider segment.
- Dialogs are keyboard accessible, themed and cannot submit unavailable models.
- Active-turn states explain why transition actions are disabled.

## Verification

Run `npm run build:renderer`, `npm run desktop:copy-renderer`,
`npm run test:desktop`, and `npm run check-types`. Re-run the capturing specs and
visually inspect the right sidebar and dialogs in light and dark themes.

## Description


## Dependencies


## Comments

