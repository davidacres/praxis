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


**PRAXIS-T40-335** — 2026-09-19T13:05:16.280Z
## AI Review by Codex CLI (local)

## Review

The ticket has a useful architectural goal, but it is not yet implementation-ready. It identifies the concepts to separate without defining the contract engineers must implement or test.

### Clarity

- Define the exact distinction between:
  - ordinary session
  - controller session
  - stage session
  - selected workflow
  - `WorkflowRun`
- Specify whether “selection” means choosing a workflow in the UI, persisting the choice, or starting execution.
- Clarify whether a controller session is unique per run, reusable across runs, or merely a session role.
- Resolve the status inconsistency: the ticket is marked `To Do` and the embedded metadata says both `Proposed` and `Planned`.

### Missing technical context

Add the proposed record shapes and field ownership, including names and types for:

- workflow reference and definition version
- immutable snapshot contents and schema/version
- `runId`, `nodeId`, session origin/type, and lifecycle status
- workflow stage identity versus stage execution attempt
- timestamps, parent/preceding session links, and failure/cancellation metadata

Also specify:

- When a run is created: on workflow selection, controller start, first stage execution, or another event.
- Whether selecting a different workflow replaces an unstarted run or creates a new run.
- How a controller attaches to an existing run, including duplicate-controller and stale-controller behavior.
- Whether stage sessions may be retried, resumed, or run concurrently.
- Which state survives restart and how active runs are recovered.
- How immutable snapshots are stored and validated when the source workflow is later edited or deleted.
- Ownership and concurrency rules for advancing a run and updating lifecycle state.

### Completeness

The acceptance criteria should explicitly cover:

- migration of representative legacy session records
- migration of records with missing, malformed, or partially populated workflow fields
- round-trip serialization for every new record shape
- preservation of unknown fields, if required
- restart/reload recovery for an active controller and stage session
- duplicate attachment, retry, cancellation, and failed-stage scenarios
- proof that legacy issue workflow references and `AgentTaskDefinition.workflow` are not used as execution authority

### Validation

`npm run test:core` is too broad and does not identify the required evidence. Name focused tests or test files covering migration, serialization, run creation, controller attachment, restart recovery, and snapshot immutability. If renderer or IPC contracts are affected, include the relevant main/preload/renderer validation as well.

### Recommended refinement

Add a contract section containing:

1. Type/interface definitions.
2. A lifecycle/state-transition table.
3. Run-creation and controller-attachment rules.
4. Persistence and restart guarantees.
5. Migration compatibility rules.
6. Explicit test cases and expected outcomes.

The empty `Description`, `Dependencies`, and `Comments` sections should either be populated or removed. Also reconcile the embedded `story: FX-BE-123` with the parent `PRAXIS-F40` so traceability is unambiguous.