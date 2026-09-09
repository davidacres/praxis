---
type: Story
id: FX-BE-075
title: "Host lifecycle and access enforcement"
status: complete
feature: FX-BF-028
updated: 2026-09-09
dependencies: [FX-BE-074]
---

# FX-BE-075: Host lifecycle and access enforcement

**Priority:** High
**Created:** 2026-09-09

## Outcome

Host lifecycle and access enforcement delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Desktop main services, settings and renderer Settings → Mobile access.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-204](tasks/task-204-implement-off-local-only-and-internet-access-policy.md) | Implement off local-only and internet access policy |
| 2 | [TASK-205](tasks/task-205-separate-client-connection-lifecycle-from-execution.md) | Separate client connection lifecycle from execution |
| 3 | [TASK-206](tasks/task-206-add-access-settings-device-administration-and-audit.md) | Add access settings device administration and audit |

## Acceptance criteria

- Off closes listeners and relay channels; local-only binds only allowed interfaces and rejects relay routes, spoofed forwarding headers and disallowed networks. State changes apply to established connections.
- Host offline is distinct from run failure; host restart uses existing recovery and never silently starts a second job. Closing the phone leaves the fixture agent running.
- Clean desktop use never requires sign-in. Revoking a device closes its sessions; mode transitions and denied operations have redacted audit evidence and inspected themed UI captures.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-074

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
