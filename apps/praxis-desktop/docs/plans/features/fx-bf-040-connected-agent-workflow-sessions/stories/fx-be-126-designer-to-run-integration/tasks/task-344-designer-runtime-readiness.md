---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.731Z
**Type:** Task
**Priority:** Medium
id: TASK-344
title: Share runtime readiness and dependency contracts with Workflow Designer
status: Planned
story: FX-BE-126
updated: 2026-09-17
dependencies: [TASK-340]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Share runtime readiness and dependency contracts with Workflow Designer

## Goal

Make the designer's profile/host/skill/policy readiness preview use the same
preflight result that starts a run.

## Done when

- Node inspector shows selected binding, skill activation expectation,
  capability requirements, trust state, and effective gate/policy impact.
- Save and run use the same scoped catalog and report drift if a dependency
  changes between authoring and execution.
- The designer never marks a node ready when the stage preflight would block it.

## Notes

Keep workflow graph state separate from Task Designer canvas state and from
workflow-pack Markdown.

## Description


## Dependencies



## Comments
