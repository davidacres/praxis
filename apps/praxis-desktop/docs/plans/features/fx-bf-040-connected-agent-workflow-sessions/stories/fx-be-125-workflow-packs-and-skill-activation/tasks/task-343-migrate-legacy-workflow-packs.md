---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.731Z
**Type:** Task
**Priority:** Medium
id: TASK-343
title: Migrate legacy issue workflow-pack assignments safely
status: Planned
story: FX-BE-125
updated: 2026-09-17
dependencies: [TASK-341]
validation: [npm run test:core, npm run test:desktop]
---

# Migrate legacy issue workflow-pack assignments safely

## Goal

Give existing issue-level workflow assignments an explicit compatibility path
without turning a prompt pack into an implicit governed run.

## Done when

- Existing assignments remain readable and continue prompt-only behavior.
- Users can explicitly map a pack to a workflow template/definition or keep it
  as session guidance, with the choice recorded.
- No legacy session acquires gates, approvals, or orchestrator ownership during
  migration unless the user starts a governed workflow.

## Notes

Document the distinction in the composer and migration diagnostics so the
product does not appear to ignore an assigned pack.

## Description


## Dependencies



## Comments
