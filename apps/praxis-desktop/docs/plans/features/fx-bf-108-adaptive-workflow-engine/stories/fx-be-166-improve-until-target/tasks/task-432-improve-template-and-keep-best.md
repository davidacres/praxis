---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-432
slug: improve-template-and-keep-best
title: Improve-until-target template with keep-best and score history
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 166
---

# TASK-432: Improve-until-target template with keep-best and score history

## Description

Add the built-in "Improve until target" template, define the scoring contract, store `iterationScores`, and revert to the best commit when an iteration scores worse.

## Acceptance criteria

- Graph: Baseline → Evaluate → Improve (one focus) → Verify → Evaluate, with a loop edge bounded by `maxIterations` and early exit on target met, no findings above threshold, or no improvement.
- The evaluator runs `independentOf` the improver and returns a score (a metric or rubric value) plus findings; a goal with neither a target nor a rubric refuses to start.
- Each iteration is a commit; a worse score reverts to the best commit, records the revert and tells the next iteration what failed.
- The run ends at the best commit with a final approval that shows the score curve and per-iteration summary; hitting the ceiling below target reads "target not reached", never "success".
- A real run against a repository with a measurable goal (type-error count) converges in an e2e test with fixture agents.

## Dependencies

- TASK-426
- TASK-428
- TASK-431

## Comments
