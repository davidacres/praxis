---
**Status:** ✅ Done
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-505
title: Derive a recorded "now" line per running stage
status: Done
story: FX-BE-193
updated: 2026-11-02
dependencies: [TASK-504]
validation: [npm run check-types, npm run build:core, npm run test:core]
---

# Derive a recorded "now" line per running stage

## Goal

Each in-flight card shows one short line saying what its running task is doing,
built only from things Praxis has recorded.

## Done when

- A core function `stageActivityLine(stage, runEvents, sessionEvents)` returns
  `{ text, at, source }` or nothing.
- Sources, in order:
  1. a **check** stage: its command and args, e.g. `npm run test:desktop:smoke`;
  2. the stage's latest `node-progress` event, e.g. "Installing dependencies in
     this run's worktree first";
  3. an **agent** stage: the session's latest tool call as verb + target (for
     example "Editing packages/core/src/conversations/turnCoordinator.ts",
     "Running npm test"), else nothing;
  4. a paused stage: the pause or gate reason, as the schedule already words it.
- Text is one line, trimmed to 120 characters, with no model output quoted
  verbatim beyond a path or command.
- `ScheduledRunLive.stages[]` carries `activity` for the running stage only.
- Unit tests cover each source, the trimming, and a stage with nothing recorded
  (no line rather than a placeholder).

## Notes

- The canvas types the line out character by character. Keep that only as a
  one-time reveal of real text, and show it whole under reduced motion.
- Session events come from the agent session manager. Look at what the session
  view already summarises for a tool call before writing a new formatter.

## Dependencies

- `TASK-504`

## Description


## Comments

## Delivery status (2026-11-02)

`stageActivityLine` and `describeToolEvent` in `scheduledRunDetail.ts`: a check's command or its own progress message; otherwise the newer of the stage's progress message and the session's latest tool call for this attempt; a paused stage's reason. One line, at most 120 characters, nothing when nothing was recorded. Unit-tested; the monitor reveals it once and shows it whole under reduced motion.
