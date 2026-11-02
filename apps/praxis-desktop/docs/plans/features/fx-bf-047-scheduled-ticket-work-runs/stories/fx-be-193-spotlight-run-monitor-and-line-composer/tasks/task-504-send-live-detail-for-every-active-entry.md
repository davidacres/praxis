---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-504
title: Send live detail for every active entry
status: To Do
story: FX-BE-193
updated: 2026-11-02
dependencies: []
validation: [npm run check-types, npm run build:core, npm run test:core, npm run test:desktop:git]
---

# Send live detail for every active entry

## Goal

Give the renderer one live record for each in-flight queue entry, with that
entry's full task list, so the Spotlight monitor can draw a card per lane.

## Done when

- `ScheduledRunView` carries `lives: ScheduledRunLive[]` keyed by `entryId`,
  one for each entry that is running, paused at a gate, or failed and waiting.
  `live` stays, as the entry the pause is about (else the first), until the old
  monitor is removed in `TASK-507`.
- Each `ScheduledRunLive` adds `stages: ScheduledStageDetail[]` from
  `summarizeWorkflowRun(...).stages`, in workflow order: `nodeId`, `name`,
  `type`, `lane`, `attempts`, `attemptsThisRevision`, `provider`,
  `durationMs`, `lastError`, `startedAt` of the in-flight attempt, and
  `tokens` for that node.
- `StageRow` gains `startedAt` for the latest attempt. Other `StageRow`
  consumers are unaffected.
- Per-node tokens come from the usage log's `workflowNodeId`, summed like
  `spendFor` does per run. A node with no usage events has no `tokens`, not 0.
- `headroom` is computed once per view, not once per entry.
- Unit tests: two lanes running, one entry at a gate, one failed stage, a loop
  that reopened Implement (attempts > 1, Review back to `ready`), and a stage
  with no usage.

## Notes

- Start from `describeLiveEntry` in `scheduledRunInstance.ts` and
  `stageProgressFor` in `scheduledRunLive.ts`. Keep `stageIndex`/`stageCount`;
  the old monitor reads them.
- The view is rebuilt on every `scheduledRuns.onChanged`. Check that reading
  the usage log once per view rebuild, rather than once per entry, keeps it cheap.

## Dependencies

- `FX-BE-149`

## Description


## Comments

