---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-055
title: "Managed service lifecycle and scoped preview access"
status: Done
feature: FX-BF-022
updated: 2026-09-25
dependencies: [FX-BE-054]
---

# FX-BE-055: Managed service lifecycle and scoped preview access

**Priority:** High
**Created:** 2026-09-07

## Outcome

Start and stop configured services with readiness and logs; allow browser access only to the selected managed preview origins.

## Scope and implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-054
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-144](tasks/task-144-implement-process-lifecycle-manager.md) | Implement process lifecycle manager |
| 2 | [TASK-145](tasks/task-145-add-explicit-preview-origin-grants.md) | Add explicit preview origin grants |
| 3 | [TASK-146](tasks/task-146-integrate-run-controls-and-recovery.md) | Integrate Run controls and recovery |

## Acceptance criteria

- Fixtures cover port collision, early exit, failed dependency, timeout and repeated stop on supported desktop platforms; never kill unrelated processes.
- A granted localhost port opens; another project or port, redirected private host and unapproved private subresource remain blocked; revoke on run closure.
- Electron fixtures exercise multi-service startup, crash and recovery; closing a preview tab does not silently terminate a persistent deployment.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments



## Review 2026-09-25

Status corrected from In Progress → Done. Verified in the current tree:

- `runServiceManager.ts` implements managed service lifecycle (start/stop/
  status) over run profiles; `runReconciliation.ts` reconciles drifted state.
- Scoped preview access: `packages/core/src/projects/previewAccess.ts`
  (+ `previewAccess.test.ts`).
- Desktop wiring: `apps/praxis-desktop/main/src/main/previewVerificationSession.ts`
  (verification sessions against preview).

Validation commands: `npm run check-types`, `npm run test:core`
(not rerun as part of this review).
