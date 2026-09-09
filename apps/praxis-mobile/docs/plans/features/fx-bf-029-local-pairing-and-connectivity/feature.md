---
type: Feature
id: FX-BF-029
title: "Local pairing and direct connectivity"
status: planned
slug: local-pairing-and-connectivity
stories: [FX-BE-076, FX-BE-077]
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# FX-BF-029: Local pairing and direct connectivity

**Priority:** High
**Created:** 2026-09-09

## Outcome

Local pairing and direct connectivity for a companion that continues existing Praxis work on a phone.

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-076](stories/fx-be-076-account-free-device-pairing/story.md) | Account-free device pairing |
| 2 | [FX-BE-077](stories/fx-be-077-discovery-and-resilient-local-transport/story.md) | Discovery and resilient local transport |

## Implementation boundaries

The desktop remains the execution authority; mobile owns presentation and transport clients. GenericSystem authenticates and Roleover authorises internet access only after their capabilities are audited. Existing local workflows and agent hosts are reused. Follow the mobile architecture and ownership map.

## Close when

All child outcomes are implemented and verified. Dependencies are start prerequisites; feature/story containment is not a prerequisite on the parent. No implementation is claimed by this plan.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
