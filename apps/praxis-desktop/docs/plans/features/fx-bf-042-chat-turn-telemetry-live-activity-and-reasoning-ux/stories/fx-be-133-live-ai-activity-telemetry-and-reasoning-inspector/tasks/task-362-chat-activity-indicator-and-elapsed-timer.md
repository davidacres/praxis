---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-362
title: Implement live chat activity indicator with elapsed turn timer and active action telemetry
status: Complete
story: FX-BE-133
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-362: Implement live chat activity indicator with elapsed turn timer and active action telemetry

## Outcome

When a turn is active, a dedicated, theme-compliant activity indicator is
displayed at the foot of the chat thread. It reports the current model phase
("Thinking…", "Running tool: <tool_name>…", or "Generating response…") alongside
a live elapsed duration timer isolated in a leaf component to avoid parent
chat re-renders.

## Scope

- Create a `LiveTurnActivityIndicator` leaf component in the renderer.
- Track turn start timestamp and drive an elapsed timer (`0.1s`, `1.2s`, etc.)
  locally using a sub-second interval or `requestAnimationFrame` to ensure zero
  re-renders of the surrounding message list.
- Derive active phase dynamically from incoming streaming events (e.g. active
  tool call vs reasoning chunks vs response text).
- Position the indicator pinned at the base of the transcript stream with
  smooth auto-scroll adherence.
- Apply subtle pulse animations adhering to Praxis theme tokens and respecting
  reduced motion.

## Acceptance criteria

- Sending a prompt immediately activates the activity indicator.
- The indicator clearly shows the elapsed time in seconds (`e.g. ✦ Thinking… 3.4s`).
- During tool execution, the indicator reflects the running tool name (e.g.
  `✦ Running tool: view_file… 5.1s`).
- The indicator is clean, non-blocking, and unmounts promptly when generation
  completes or fails.
- Timer intervals do not leak or run when the session is idle or paused.
- The isolated leaf timer causes no re-renders in parent transcript components.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
