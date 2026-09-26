---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-081
title: "Read and continue existing work"
status: in-progress
feature: FX-BF-031
updated: 2026-09-22
dependencies: [FX-BE-080, FX-BE-077]
---

# FX-BE-081: Read and continue existing work

**Priority:** High
**Created:** 2026-09-09

## Outcome

Read and continue existing work delivers the following ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile renderer work/session/progress/changes features and client transport.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-222](tasks/task-222-implement-work-list-and-session-restoration.md) | Implement work list and session restoration |
| 2 | [TASK-223](tasks/task-223-implement-conversation-follow-ups-and-result-review.md) | Implement conversation follow-ups and result review |
| 3 | [TASK-224](tasks/task-224-verify-complete-lan-continuation-milestone.md) | Verify complete LAN continuation milestone |
| 4 | [TASK-238](tasks/task-238-wire-mobile-sessions-to-live-host-data.md) | Wire mobile sessions to live host data |

## Acceptance criteria

- Duplicate issue keys across projects stay separate; host switching cannot expose stale data from another host. Empty, loading, denied and offline states are distinct.
- Session list/create/get/continue/cancel operations and their snapshots/events are versioned protocol contracts implemented by the desktop host and consumed by the production mobile repository; demo state is not a fallback.
- Desktop → phone → desktop keeps session/run IDs and provider context. Binary/oversized files and unsafe paths are refused or clearly truncated; unsupported continuation is explicit.
- Responses stream incrementally from the desktop-owned active turn to the phone, including tool/permission activity and terminal state. Reconnect resumes a partial response from the acknowledged cursor without gaps or duplicate transcript entries.
- Historical transcript truth comes from `AgentSessionRecord.events`; `responseText` is only the active-turn buffer. Snapshot, replay and live pushes are filtered by authenticated host/project/session scope and converge after restart.
- Work continues while phone is absent; replay has no missing/duplicate accepted messages. Record physical-device evidence for iOS/Android and retained desktop behaviour before declaring the milestone complete.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-080
- FX-BE-077

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments
