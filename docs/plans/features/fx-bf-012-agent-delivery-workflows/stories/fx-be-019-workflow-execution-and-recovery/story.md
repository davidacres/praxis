---
id: FX-BE-019
title: Workflow execution, persistence, and recovery
status: complete
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-019-workflow-execution-and-recovery/issue.md
updated: 2026-09-02
tasks: [TASK-095, TASK-096, TASK-097]
dependencies: [FX-BE-018, FX-BF-011]
validation: [npm run build:core, npm run test:core, npm run check-types]
---

# Workflow execution, persistence, and recovery

## User or operational impact

Long-running delivery workflows remain observable and resumable across failures or app restarts.

## Scope

- Add a durable WorkflowRun state machine with node attempts, events, artifacts, and audit records.
- Schedule ready nodes, support read-only fan-out and joins, and enforce retry/timeout/cancellation rules.
- Resume from the last completed boundary without duplicating completed side effects.

## Acceptance criteria

- A run persists after every meaningful transition and can be recovered after process restart.
- Failed required nodes block downstream approval; retries are bounded and visible.
- Completed nodes are not rerun during recovery unless explicitly retried by the user.

## Task list

- `TASK-095` — Implement WorkflowRun state, event log, and persistence.
- `TASK-096` — Implement deterministic scheduler, fan-out/join, and artifact handoff sequencing.
- `TASK-097` — Add timeout, retry, cancellation, and restart recovery behavior.

## Close when

Core and Electron tests demonstrate deterministic execution, failure isolation, and restart recovery.
