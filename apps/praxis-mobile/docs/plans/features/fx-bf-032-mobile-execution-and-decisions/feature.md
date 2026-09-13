---
**Status:** 📋 Proposed
**Type:** Feature
type: Feature
id: FX-BF-032
title: "Mobile workflow execution and decisions"
status: in-progress
slug: mobile-execution-and-decisions
stories: [FX-BE-082, FX-BE-083]
updated: 2026-09-09
dependencies: [FX-BE-081]
---

# FX-BF-032: Mobile workflow execution and decisions

**Priority:** High
**Created:** 2026-09-09

## Outcome

Mobile workflow execution and decisions for a companion that continues existing Praxis work on a phone.

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-082](stories/fx-be-082-start-and-control-existing-work/story.md) | Start and control existing work |
| 2 | [FX-BE-083](stories/fx-be-083-attention-and-request-specific-approvals/story.md) | Attention and request-specific approvals |

## Implementation boundaries

The desktop remains the execution authority; mobile owns presentation and transport clients. GenericSystem authenticates and Roleover authorises internet access only after their capabilities are audited. Existing local workflows and agent hosts are reused. Follow the mobile architecture and ownership map.

## Close when

All child outcomes are implemented and verified. Dependencies are start prerequisites; feature/story containment is not a prerequisite on the parent. No implementation is claimed by this plan.

## Dependencies

- FX-BE-081

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


