---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-240
title: "Enable request-scoped mobile decisions"
status: planned
story: FX-BE-083
updated: 2026-09-22
dependencies: [TASK-239]
---

# TASK-240: Enable request-scoped mobile decisions

**Priority:** High
**Created:** 2026-09-22

## Goal

Replace the pending permission-response host stub with request-specific, authorised decisions from the mobile Attention surface.

## Implementation entry points

Desktop mobile host dispatch for `permissions.respond`, the permission FIFO to request-id migration described in the mobile architecture, mobile Attention state, and access-scope enforcement.

## Acceptance criteria

- Every actionable item carries a stable request ID, session/run scope, version, expiry, and allowed actions supplied by the host.
- `permissions.respond` accepts one authorised response for the matching live request and returns explicit stale, resolved, forbidden, or conflict outcomes otherwise.
- View/execute-only devices cannot approve, and reconnect or duplicate submission cannot repeat a side effect or apply a decision to a later request.
- Decisions resolved on desktop update or disappear on mobile through the normal event stream.
- Raw commands, paths, arguments, and credentials are not exposed beyond the compact permission detail policy.

## Dependencies

- TASK-239

## Verification

- Add protocol, host dispatch, and mobile tests for allow, deny, stale ID, wrong session/stage, revoked device, duplicate response, desktop-first resolution, and disconnect during response.
- Run focused permission, protocol, host, and mobile suites.
- Record an approval and denial from mobile against a real desktop-hosted session.

## Done when

- Supported request-specific approvals can be safely resolved from mobile through the production connection.
- `permissions.respond` no longer throws `MobileHostPendingError` for supported requests.

## Notes

This task owns the concrete integration left after TASK-228 and TASK-229. Human workflow gates remain distinct from tool-permission auto-approval.

## Description


## Comments


