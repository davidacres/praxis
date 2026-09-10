---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-066
title: "IIS end-to-end proof and operational guidance"
status: planned
feature: FX-BF-025
updated: 2026-09-07
dependencies: [FX-BE-065]
---

# FX-BE-066: IIS end-to-end proof and operational guidance

**Priority:** High
**Created:** 2026-09-07

## Outcome

Prove local IIS deployment and pipeline-managed IIS deployment without assuming Praxis is itself a hosted CD service.

## Scope and implementation entry points

docs/user-guide.md; deployment integration fixtures. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-065
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-177](tasks/task-177-add-windows-iis-fixture-workflow.md) | Add Windows IIS fixture workflow |
| 2 | [TASK-178](tasks/task-178-exercise-direct-and-pipeline-target-journeys.md) | Exercise direct and pipeline target journeys |
| 3 | [TASK-179](tasks/task-179-document-supported-methods-and-recovery.md) | Document supported methods and recovery |

## Acceptance criteria

- Fixture target is uniquely identified, cleanup only removes owned resources, and unsupported runners skip with an explicit reason.
- Both paths install the same fixture artifact and support their declared rollback path; ordinary app E2E uses mocks and never touches real IIS.
- A reviewer can follow the guide against the disposable fixture; every advertised method has evidence and unsupported remote transport is named.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


