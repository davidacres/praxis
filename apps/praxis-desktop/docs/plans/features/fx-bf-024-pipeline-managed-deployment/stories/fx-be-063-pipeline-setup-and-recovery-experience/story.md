---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-063
title: "Pipeline setup and recovery experience"
status: To Do
feature: FX-BF-024
updated: 2026-09-07
dependencies: [FX-BE-062]
---

# FX-BE-063: Pipeline setup and recovery experience

**Priority:** High
**Created:** 2026-09-07

## Outcome

Make trigger versus observe explicit and show what continues remotely while Praxis is closed.

## Scope and implementation entry points

renderer/src/deployments; packages/core/src/workflows. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-062
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-168](tasks/task-168-build-provider-configuration-forms.md) | Build provider configuration forms |
| 2 | [TASK-169](tasks/task-169-reconcile-external-runs-on-reopen.md) | Reconcile external runs on reopen |
| 3 | [TASK-170](tasks/task-170-verify-cd-and-deployment-journeys.md) | Verify CD and deployment journeys |

## Acceptance criteria

- Jira plus Actions and folder plus GitLab fixtures configure successfully; changing suggestion never silently changes saved execution mode.
- Closing Praxis does not cancel a remote pipeline; reopening observes the same run; cancel requested is separate from confirmed cancellation.
- No duplicate deployment after refresh, timeout or restart; provider links and degraded states render correctly and documentation explains continuous delivery ownership.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


