---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-058
title: "Durable deployment state and workflow operations"
status: In Progress
feature: FX-BF-023
updated: 2026-09-07
dependencies: [FX-BE-057]
---

# FX-BE-058: Durable deployment state and workflow operations

**Priority:** High
**Created:** 2026-09-07

## Outcome

Add explicit deployment operations with approval, health checks, environment locking and restart reconciliation.

## Scope and implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-057
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-153](tasks/task-153-add-deployment-transitions-and-policy.md) | Add deployment transitions and policy |
| 2 | [TASK-154](tasks/task-154-persist-side-effects-and-reconcile.md) | Persist side effects and reconcile |
| 3 | [TASK-155](tasks/task-155-integrate-workflow-designer-and-monitor.md) | Integrate workflow designer and monitor |

## Acceptance criteria

- Changing artifact or target invalidates approval; only verified health yields succeeded; concurrent deployment to a locked target is queued or refused explicitly.
- Crash after dispatch but before acknowledgement produces unknown and reconciliation, never an automatic second deployment; completed steps are not replayed.
- Existing workflow fixtures remain unchanged; deployment cannot bypass configured approval or QA; node editor and monitor states have visual/accessibility verification.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


