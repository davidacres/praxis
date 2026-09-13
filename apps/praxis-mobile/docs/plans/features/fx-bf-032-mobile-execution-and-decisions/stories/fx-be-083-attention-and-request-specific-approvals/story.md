---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-083
title: "Attention and request-specific approvals"
status: in-progress
feature: FX-BF-032
updated: 2026-09-09
dependencies: [FX-BE-082]
---

# FX-BE-083: Attention and request-specific approvals

**Priority:** High
**Created:** 2026-09-09

## Outcome

Attention and request-specific approvals delivers the following ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-228](tasks/task-228-build-actionable-attention-inbox.md) | Build actionable attention inbox |
| 2 | [TASK-229](tasks/task-229-implement-scoped-decision-commands.md) | Implement scoped decision commands |
| 3 | [TASK-230](tasks/task-230-verify-full-internet-execution-milestone.md) | Verify full local execution milestone |

## Acceptance criteria

- Resolving on desktop removes or marks the phone item resolved. Expired or superseded items cannot target a later request; pagination does not hide active decisions.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.
- View/execute-only devices cannot approve. Wrong request, wrong stage, stale version and duplicate response produce explicit conflict/already-resolved results with no second side effect.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.
- A physical phone completes a fixture workflow over LAN with GenericSystem, Roleover and Azure unavailable. Network interruption never grants approval or repeats execution; device revocation blocks access while local jobs continue.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-082

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.

## Description


## Comments


