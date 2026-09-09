---
type: Story
id: FX-BE-083
title: "Attention and request-specific approvals"
status: planned
feature: FX-BF-032
updated: 2026-09-09
dependencies: [FX-BE-082, FX-BE-079]
---

# FX-BE-083: Attention and request-specific approvals

**Priority:** High
**Created:** 2026-09-09

## Outcome

Attention and request-specific approvals delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Mobile Attention UI, host permission/approval services and remote auth checks.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-228](tasks/task-228-build-actionable-attention-inbox.md) | Build actionable attention inbox |
| 2 | [TASK-229](tasks/task-229-implement-scoped-decision-commands.md) | Implement scoped decision commands |
| 3 | [TASK-230](tasks/task-230-verify-full-internet-execution-milestone.md) | Verify full internet execution milestone |

## Acceptance criteria

- Resolving on desktop removes or marks the phone item resolved. Expired or superseded items cannot target a later request; pagination does not hide active decisions.
- View/execute-only devices cannot approve. Wrong request, wrong stage, stale version and duplicate response produce explicit conflict/already-resolved results with no second side effect.
- One physical phone completes a fixture workflow via Azure; relay interruption never grants approval or repeats execution. Revocation meets the documented bound and local jobs continue.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

- FX-BE-082
- FX-BE-079

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
