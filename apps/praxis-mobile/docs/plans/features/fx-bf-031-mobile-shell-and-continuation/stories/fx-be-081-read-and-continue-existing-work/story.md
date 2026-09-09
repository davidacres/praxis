---
type: Story
id: FX-BE-081
title: "Read and continue existing work"
status: planned
feature: FX-BF-031
updated: 2026-09-09
dependencies: [FX-BE-080, FX-BE-077]
---

# FX-BE-081: Read and continue existing work

**Priority:** High
**Created:** 2026-09-09

## Outcome

Read and continue existing work delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile renderer work/session/progress/changes features and client transport.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-222](tasks/task-222-implement-work-list-and-session-restoration.md) | Implement work list and session restoration |
| 2 | [TASK-223](tasks/task-223-implement-conversation-follow-ups-and-result-review.md) | Implement conversation follow-ups and result review |
| 3 | [TASK-224](tasks/task-224-verify-complete-lan-continuation-milestone.md) | Verify complete LAN continuation milestone |

## Acceptance criteria

- Duplicate issue keys across projects stay separate; host switching cannot expose stale data from another host. Empty, loading, denied and offline states are distinct.
- Desktop → phone → desktop keeps session/run IDs and provider context. Binary/oversized files and unsafe paths are refused or clearly truncated; unsupported continuation is explicit.
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
