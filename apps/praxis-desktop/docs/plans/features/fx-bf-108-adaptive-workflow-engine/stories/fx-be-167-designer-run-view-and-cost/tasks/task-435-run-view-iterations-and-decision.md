---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-435
slug: run-view-iterations-and-decision
title: Run view: iteration state, history and needs-decision actions
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 167
---

# TASK-435: Run view: iteration state, history and needs-decision actions

## Description

Show iteration state in the pipeline and run panel, the predicate that fired and its findings, per-iteration scores where present, and the needs-decision actions in the run panel and the sidebar run node.

## Acceptance criteria

- The pipeline shows "iteration N of M" for a looping stage; step buttons keep the `Name (type): lane` aria-label.
- The history lists each iteration's trigger, outcome and score.
- Approve-anyway, grant-more and stop are reachable from the run panel and the sidebar node and require the reason where the core requires one.
- E2E: a seeded looping run reaches needs-decision and each action produces the expected run state. Screenshots inspected.

## Dependencies

- TASK-425
- TASK-424

## Comments
