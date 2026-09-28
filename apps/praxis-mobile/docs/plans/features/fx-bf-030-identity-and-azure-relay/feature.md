---
**Status:** 📋 Proposed
**Type:** Feature
type: Feature
id: FX-BF-030
title: "Optional identity and Azure internet access"
status: backlog
slug: identity-and-azure-relay
stories: [FX-BE-078, FX-BE-079, FX-BE-086]
updated: 2026-09-09
dependencies: [FX-BE-075]
---

# FX-BF-030: Optional identity and Azure internet access

**Priority:** Low
**Created:** 2026-09-09

## Outcome

Optional identity and Azure internet access for a companion that continues existing Praxis work on a phone.

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-078](stories/fx-be-078-genericsystem-and-roleover-integration/story.md) | GenericSystem and Roleover integration |
| 2 | [FX-BE-079](stories/fx-be-079-azure-relay-and-host-registration-service/story.md) | Azure Relay and host registration service |

| 3 | [FX-BE-086](stories/fx-be-086-deferred-internet-notifications/story.md) | Deferred internet notifications |

## Implementation boundaries

The desktop remains the execution authority; mobile owns presentation and transport clients. GenericSystem authenticates and Roleover authorises internet access only after their capabilities are audited. Existing local workflows and agent hosts are reused. Follow the mobile architecture and ownership map.

## Delivery priority

Deferred until the local release is complete. GenericSystem and Roleover are not currently running. Their deployment and real integration are prerequisites only for internet access; fixture adapters can be used during development, never as production authentication bypasses.

## Close when

All child outcomes are implemented and verified. Dependencies are start prerequisites; feature/story containment is not a prerequisite on the parent. No implementation is claimed by this plan.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


