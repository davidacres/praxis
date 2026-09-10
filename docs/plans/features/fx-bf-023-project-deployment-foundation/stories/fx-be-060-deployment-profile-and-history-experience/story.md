---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-060
title: "Deployment profile and history experience"
status: In Progress
feature: FX-BF-023
updated: 2026-09-07
dependencies: [FX-BE-059]
---

# FX-BE-060: Deployment profile and history experience

**Priority:** High
**Created:** 2026-09-07

## Outcome

Provide a coherent Deployments surface with target-independent profiles, artifact promotion, live run evidence and source links.

## Scope and implementation entry points

renderer/src/deployments (new); renderer/src/app; docs/user-guide.md. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-059
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-159](tasks/task-159-build-profile-selection-and-review.md) | Build profile selection and review |
| 2 | [TASK-160](tasks/task-160-add-deployment-history-and-promotion.md) | Add deployment history and promotion |
| 3 | [TASK-161](tasks/task-161-verify-complete-direct-delivery-journey.md) | Verify complete direct delivery journey |

## Acceptance criteria

- Switching issue backend never rewrites deployment target; profile editor supports missing credentials and machine-local bindings.
- Test and production records share artifact digest but retain separate approval and health evidence; unknown and rolled-back runs are distinguishable.
- Mock/scripted journeys run without production credentials; inspect light/dark and narrow viewport captures, keyboard flow and failure states.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


