---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.726Z
**Type:** Task
**Priority:** Medium
id: TASK-335
title: Define workflow-selection, controller-session, and run-link contracts
status: Planned
story: FX-BE-123
updated: 2026-09-17
dependencies: []
validation: [npm run test:core]
---

# Define workflow-selection, controller-session, and run-link contracts

## Goal

Define the durable contract that distinguishes an ordinary session, a
workflow-controller session, a workflow stage session, a selected workflow
definition, and an immutable `WorkflowRun` snapshot.

## Done when

- Session and run records can represent selection, origin, definition version,
  run id, node id, and lifecycle without overloading legacy fields.
- The contract specifies when selection creates a run, how a controller
  session attaches to an existing run, and what survives restart.
- Core migration and serialization tests cover old records and new records.

## Notes

Keep the workflow definition snapshot authoritative for a run. Do not make
`AgentTaskDefinition.workflow` or the legacy issue workflow reference the
execution source of truth.

## Description


## Dependencies



## Comments
