---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-431
slug: run-parameters
title: Run parameters: goal, iteration count and target in the start-run dialog
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 166
---

# TASK-431: Run parameters: goal, iteration count and target in the start-run dialog

## Description

Let a workflow declare run parameters and render them in `StartRunDialog.tsx`. Values are validated, fixed for the life of the run and stored on it; `maxIterations` overrides a loop edge's budget up to the ceiling.

## Acceptance criteria

- Parameters (text, integer with bounds, number) are declared on the definition, copied by `normalizeWorkflow`, and recorded on the run through `normalizeWorkflowRun`.
- The dialog uses existing form primitives; invalid values block start with a message naming the field.
- Parameter values are available to stage briefs as plain text, never interpolated into commands or paths.
- A run started before the change, and a workflow with no parameters, behave exactly as today.

## Dependencies

- TASK-422

## Comments
