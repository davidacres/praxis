---
type: Story
id: FX-BE-074
title: "Versioned execution boundary"
status: complete
feature: FX-BF-028
updated: 2026-09-09
dependencies: []
---

# FX-BE-074: Versioned execution boundary

**Priority:** High
**Created:** 2026-09-09

## Outcome

Versioned execution boundary delivers the following three ordered, independently verifiable steps.

## Scope and implementation entry points

Desktop main and packages/core; publishable browser-safe protocol contracts.

## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-201](tasks/task-201-audit-execution-ownership-and-freeze-protocol-v1.md) | Audit execution ownership and freeze protocol v1 |
| 2 | [TASK-202](tasks/task-202-extract-shared-host-application-services.md) | Extract shared host application services |
| 3 | [TASK-203](tasks/task-203-add-durable-commands-events-and-request-specific-decisions.md) | Add durable commands events and request-specific decisions |

## Acceptance criteria

- A contract fixture maps every mobile operation to its existing implementation; identical issue keys in different projects or hosts cannot collide. Older/newer clients get explicit compatibility results.
- Existing desktop session continuation, workflow start, cancellation and policy tests pass through the extracted services; mobile contract consumers build without Node/native bindings.
- Lost acknowledgement and repeated command IDs cause no duplicate run; conflicting payloads are rejected. Crash between dispatch and acknowledgement reconciles as unknown/interrupted without blind replay. A stale permission response cannot approve the next FIFO request.

## Exclusions

No board, workflow or agent administration on mobile. No on-phone agent execution, VPN dependency or mandatory account for desktop/LAN use.

## Dependencies

None.

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
