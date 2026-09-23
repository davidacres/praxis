---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-239
title: "Enable live workflow execution commands"
status: planned
story: FX-BE-082
updated: 2026-09-22
dependencies: [TASK-238]
---

# TASK-239: Enable live workflow execution commands

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace the pending mobile host stubs for starting and controlling work with authorised commands against the desktop's existing workflow and agent services.

## Implementation entry points

Desktop mobile host dispatch for `workflowRuns.start` and existing retry/cancel operations, mobile work controls, operation-id handling, and capability negotiation.

## Acceptance criteria

- `workflowRuns.start` invokes the existing desktop execution service after scope, capability, configuration, and access checks.
- Retry and cancellation target the existing durable run and obey orchestrator ordering and policy.
- Duplicate submissions or lost acknowledgements remain idempotent through stable operation IDs.
- Unsupported or unauthorised controls are disabled or rejected with a specific reason; mobile never creates an alternate execution path.
- Desktop and mobile display the same durable run and resulting session hierarchy.

## Dependencies

- TASK-238

## Verification

- Add host dispatch and mobile integration tests for start, duplicate start, cancellation, retry, denial, stale run, and reconnect-after-ack-loss.
- Run focused desktop host, protocol, workflow, and mobile tests against disposable data.
- Record one live start and control journey from mobile against a running desktop host.

## Done when

- A permitted mobile client can start, retry, and cancel existing desktop-owned work through the production protocol.
- `workflowRuns.start` no longer throws `MobileHostPendingError` for supported requests.

## Notes

This closes the concrete host-command gap left after TASK-225 through TASK-227; it does not add workflow editing or template administration to mobile.

## Description


## Comments


