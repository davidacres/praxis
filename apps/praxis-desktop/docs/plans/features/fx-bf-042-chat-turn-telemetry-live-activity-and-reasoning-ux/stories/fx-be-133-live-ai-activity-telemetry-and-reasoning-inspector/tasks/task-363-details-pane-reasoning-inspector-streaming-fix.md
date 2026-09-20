---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-363
title: Fix Details pane reasoning display truncation, stream layout, and anti-bloat streamlining
status: Complete
story: FX-BE-133
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-363: Fix Details pane reasoning display truncation, stream layout, and anti-bloat streamlining

## Outcome

The Details pane (`SessionInspector`) displays the complete, untruncated stream
of model thoughts and reasoning during and after execution. The previous artificial
limit of 140 characters in `sessionNav.ts` is eliminated, the reasoning box
provides a scrollable, monospace/markdown-friendly viewer that stays accessible
even after turn settlement, and the "Summary" tab layout is streamlined to
prioritize live operations over empty boilerplate blocks.

## Scope

- Remove the `truncate(text, 140)` call in
  `apps/praxis-desktop/renderer/src/ai/sessionNav.ts` / `SessionInspector.tsx`
  that capped reasoning display.
- Design the inspector's Thought/Reasoning block with an expandable disclosure,
  auto-scrolling behavior during active streaming, and full text retention.
- Restructure the "Summary" tab layout:
  - Top: Live Operations (`activity` status, timer, `SessionTasks` checklist, and
    live unclipped reasoning stream).
  - Middle: Compact `SessionPurposeBlock` (concise goal and issue key).
  - Bottom: De-clutter `SessionHandoverBrief`: collapse or hide the 7 empty
    sub-fields unless the brief has been edited or a handover is in progress.
- Ensure that when a turn completes, the reasoning text remains viewable in the
  inspector rather than disappearing immediately upon entering a terminal state.
- Ensure large reasoning text blocks (e.g. 5k+ characters from deep thinking
  models) render with virtual or smooth scrolling without degrading UI
  responsiveness.

## Acceptance criteria

- As the model outputs reasoning chunks, the Details pane updates continuously in
  real time.
- The full reasoning content is visible and scrollable rather than cut off at
  140 characters.
- Live operations (current tool, ticking timer, tasks, and thoughts) appear at the
  top of the pane without needing to scroll past empty handover fields.
- The 7 empty handover brief sections no longer dominate the pane during ordinary
  chat sessions.
- Completed session records retain reasoning inspectability in the Details pane.
- A "Copy thoughts" action is available on the thought block in the Details pane.
- Theme tokens (`--bg-surface-elevated`, `--text-muted`, `--border`) are used
  consistently.

## Validation

- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
