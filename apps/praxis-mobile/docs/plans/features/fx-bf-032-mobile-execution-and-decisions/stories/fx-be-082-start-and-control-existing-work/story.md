---
type: Story
id: FX-BE-082
title: "Start and control existing work"
status: complete
feature: FX-BF-032
updated: 2026-09-09
dependencies: [FX-BE-081]
---

# FX-BE-082: Start and control existing work

**Priority:** High
**Created:** 2026-09-09

## Outcome

Start and control existing work delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile Work start form; host execution services and existing agent/workflow catalog.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-225](tasks/task-225-expose-runnable-existing-workflow-and-agent-choices.md) | Expose runnable existing workflow and agent choices |
| 2 | [TASK-226](tasks/task-226-implement-start-retry-and-cancellation-actions.md) | Implement start retry and cancellation actions |
| 3 | [TASK-227](tasks/task-227-verify-desktop-and-mobile-execution-parity.md) | Verify desktop and mobile execution parity |

## Acceptance criteria

- Untrusted/unconfigured agents and invalid workflows cannot start; no workflow template instantiation or editing is required on mobile. Folder, GitHub and other backends retain their actual capability limits.
- Double tap, lost acknowledgement and reconnection create one run. Cancellation reaches active host execution; retry follows existing policy and never silently starts a new unrelated conversation.
- Both clients see the same durable run; unsupported provider controls are disabled with reasons. Concurrent clients cannot mutate a stage outside orchestrator ordering.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-081

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
