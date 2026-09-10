---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-059
title: "Script-based direct deployment executor"
status: In Progress
feature: FX-BF-023
updated: 2026-09-07
dependencies: [FX-BE-058]
---

# FX-BE-059: Script-based direct deployment executor

**Priority:** High
**Created:** 2026-09-07

## Outcome

Execute explicit reviewed deployment scripts locally with typed inputs, artifact paths and bounded output, without requiring a CI service.

## Scope and implementation entry points

main/src/main; packages/core/src/deployments (new). Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-058
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-156](tasks/task-156-implement-direct-process-executor.md) | Implement direct process executor |
| 2 | [TASK-157](tasks/task-157-add-local-directory-target-and-health-verification.md) | Add local directory target and health verification |
| 3 | [TASK-158](tasks/task-158-expose-direct-deployment-actions.md) | Expose direct deployment actions |

## Acceptance criteria

- Paths with spaces and metacharacters are data; fixture scripts produce typed results; startup failure and timeout preserve logs and operation identity.
- A fixture web root updates from one immutable artifact, excludes configured user data, fails on bad health and can restore the previous version.
- A folder-backed project deploys to a temporary local server without GitHub; repeated click and reconnect cannot duplicate execution.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


