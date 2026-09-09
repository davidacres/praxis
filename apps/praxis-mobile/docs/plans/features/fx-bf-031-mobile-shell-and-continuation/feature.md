---
type: Feature
id: FX-BF-031
title: "Mobile shell and work continuation"
status: planned
slug: mobile-shell-and-continuation
stories: [FX-BE-080, FX-BE-081]
updated: 2026-09-09
dependencies: [FX-BE-074]
---

# FX-BF-031: Mobile shell and work continuation

**Priority:** High
**Created:** 2026-09-09

## Outcome

Mobile shell and work continuation for a companion that continues existing Praxis work on a phone.

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-080](stories/fx-be-080-portable-mobile-application-foundation/story.md) | Portable mobile application foundation |
| 2 | [FX-BE-081](stories/fx-be-081-read-and-continue-existing-work/story.md) | Read and continue existing work |

## Implementation boundaries

The desktop remains the execution authority; mobile owns presentation and transport clients. GenericSystem authenticates and Roleover authorises internet access only after their capabilities are audited. Existing local workflows and agent hosts are reused. Follow the mobile architecture and ownership map.

## Close when

All child outcomes are implemented and verified. Dependencies are start prerequisites; feature/story containment is not a prerequisite on the parent. No implementation is claimed by this plan.

## Dependencies

- FX-BE-074

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
