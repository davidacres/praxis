---
type: Story
id: FX-BE-065
title: "IIS install health and explicit rollback"
status: planned
feature: FX-BF-025
updated: 2026-09-07
dependencies: [FX-BE-064]
---

# FX-BE-065: IIS install health and explicit rollback

**Priority:** High
**Created:** 2026-09-07

## Outcome

Stage the artifact, coordinate application availability, install content and restore on explicit rollback with preservation of mutable state.

## Scope and implementation entry points

deployment executor scripts/templates; packages/core/src/deployments. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-064
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-174](tasks/task-174-implement-staged-iis-installation.md) | Implement staged IIS installation |
| 2 | [TASK-175](tasks/task-175-verify-health-and-retain-recovery-evidence.md) | Verify health and retain recovery evidence |
| 3 | [TASK-176](tasks/task-176-implement-explicit-rollback-procedure.md) | Implement explicit rollback procedure |

## Acceptance criteria

- Windows fixture proves correct site only is changed, locked files fail safely, and partial copy does not report success; document expected downtime.
- A responding endpoint with the wrong version fails verification; startup failure records logs and a usable recovery reference.
- Disposable IIS fixture rolls back a failed release without losing excluded data; failed rollback remains visible and includes manual recovery steps.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
