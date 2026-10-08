---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-427
slug: independent-of-stage-selection
title: independentOf: pick a different provider or model than the author
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 164
---

# TASK-427: independentOf: pick a different provider or model than the author

## Description

Add an optional `independentOf` node field and resolve it in `runWorkflowAgentStage`: prefer a different configured provider, else a different model via the tier map, else run and record that independence was not possible. Add the field to `normalizeWorkflow` and the designer inspector data.

## Acceptance criteria

- Resolution is a pure function in core (beside `chooseStageModel`) with a table-driven test: two providers, one provider with tiers, one provider without tiers.
- The decision and reason appear on the session record and run timeline.
- A provider-limit switch that would break independence pauses for a decision.
- Validation requires the referenced node to exist, be an agent stage and be upstream.
- Governed delivery's Review uses `independentOf: implement`.

## Dependencies

- TASK-422

## Comments
