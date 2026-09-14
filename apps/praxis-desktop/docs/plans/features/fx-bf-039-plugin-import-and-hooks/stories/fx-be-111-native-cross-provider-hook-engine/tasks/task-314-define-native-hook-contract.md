---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-314
title: "Define the native hook event/matcher/action contract"
status: Proposed
story: FX-BE-111
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-111]
---

# TASK-314: Define the native hook event/matcher/action contract

## Objective

Define Praxis's own `HookEvent` union, `HookMatcher`, and `HookAction` contracts —
provider-neutral, so the same definition means the same thing whether the session
underneath is ACP-hosted, Copilot-SDK-hosted, or a direct API call — and expressive
enough to represent the real hooks FX-BE-109's design walked through.

## Implementation notes

- Minimum event set: session start, session end, before tool call, after tool call,
  stage failure (workflow context), session failure. Each event's payload is built
  from Praxis's own `AgentEventSummary`/session record shapes already used across
  every host — not from any single provider's own event format — so a hook author
  never has to special-case a host. Where a tool name is needed, it's expressed
  against Praxis's own tool taxonomy, never a raw passthrough of one host's names.
- A matcher is a predicate over the event payload (event type + optional field
  conditions) — keep it declarative (no arbitrary code at match time) so matching
  itself can never be the security boundary that needs sandboxing; only the action
  that fires needs one (see TASK-315). The matcher's condition set must cover what
  FX-BE-109/TASK-311's design validated against `hookify`'s real hooks — treat a gap
  found there as a contract gap to close here, not a design compromise to accept.
- An action is one of: run a sandboxed script (see FX-BE-114 for the trust gate),
  append a note to the session's own event log, or block/allow a pending permission
  request the same way a user's own approval would.

## Acceptance criteria

- The contract is expressible without referencing any single provider's own hook
  vocabulary anywhere in its types.
- A hook's event payload is fully derivable from data every host already reports.
- The contract can represent every hook the design review validated it against.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the contract's own type/shape tests and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
