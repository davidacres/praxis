---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.264Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-287
title: "Connect gadgets to run monitor, changes and deployment decisions"
status: Done
story: FX-BE-100
feature: FX-BF-036
updated: 2026-09-21
dependencies: [TASK-286]
---

# TASK-287: Connect gadgets to run monitor, changes and deployment decisions

## Objective

Expose progress, test results, diffs, merge readiness and deployment approvals through scoped gadget actions without bypassing existing services.

## Implementation notes

- Preserve the versioned browser-safe contract and existing host/session adapter boundary.
- Keep the local-first path usable without GenericSystem, Roleover, Azure or cloud connectivity.
- Record decisions and mutations through existing durable stores and append-only evidence where applicable.
- Do not allow provider or gadget payloads to execute arbitrary code or bypass policy.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the focused package tests and the applicable desktop/mobile fixture or end-to-end journey. Capture visual or accessibility evidence for renderer changes.

## Description


## Dependencies



## Comments

**2026-09-21** — Gate approval is now wired end to end: when a run reaches an
awaiting-approval node with a controller session, `syncApprovalGadgets`
(`apps/praxis-desktop/main/src/main/workflowApprovalGadgetSync.ts`) publishes
an `approval` gadget into that chat carrying the node id, built by the pure
`planApprovalGadgetSync` (`packages/core/src/workflows/workflowApprovalGadgets.ts`).
Confirming the gadget's approval action now calls the same `approveStage` the
run monitor's own Approve button uses (`gadgetIpc.ts`'s `executeGadgetAction`),
not a second, weaker approval path — a stale or already-settled node is
refused exactly as `workflows:approveRun` would refuse it. The gadget is
withdrawn once its node is no longer awaiting a person, unless it already
carries the recorded answer.

Still outstanding: progress, test results and diffs are not yet exposed as
gadgets tied to a live run, and deployment approvals beyond a plain gate
(merge readiness, environment detail) are unaddressed. Those need their own
producers alongside `syncApprovalGadgets` — this task is not done.

