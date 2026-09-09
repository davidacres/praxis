---
type: Story
id: FX-BE-076
title: "Account-free device pairing"
status: complete
feature: FX-BF-029
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# FX-BE-076: Account-free device pairing

**Priority:** High
**Created:** 2026-09-09

## Outcome

Account-free device pairing delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Desktop pairing service and mobile main platform adapter; renderer pairing screens.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-207](tasks/task-207-specify-and-implement-authenticated-pairing-handshake.md) | Specify and implement authenticated pairing handshake |
| 2 | [TASK-208](tasks/task-208-persist-and-revoke-device-trust-securely.md) | Persist and revoke device trust securely |
| 3 | [TASK-209](tasks/task-209-verify-local-pairing-user-journey.md) | Verify local pairing user journey |

## Acceptance criteria

- Expired, replayed and concurrently consumed QR tokens fail; substituted host identity and unconfirmed devices are rejected. Pairing succeeds with internet/DNS access blocked.
- No private keys enter logs, QR history or portable project files. Revoked devices fail both reconnect and existing channels; host identity change requires deliberate re-pairing.
- A real iOS and Android device can pair with the supported desktop host; denied camera/local-network permission, token expiry and cloud outage have verified recovery paths.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
