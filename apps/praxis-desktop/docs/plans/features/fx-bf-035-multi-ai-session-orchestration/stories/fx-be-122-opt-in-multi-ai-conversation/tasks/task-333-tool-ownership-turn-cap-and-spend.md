---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-333
title: "Enforce tool ownership, turn cap and spend visibility"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-330, TASK-332]
---

# TASK-333: Enforce tool ownership, turn cap and spend visibility

## Objective

Make the conversation safe: one writer, a hard stop, and honest cost language.

## Implementation notes

- Consult and debate force `read-only` (or project-only) on both participants.
  Pair gives `full` only to the current tool owner; the guest cannot start
  shell/file writes. Host-enforce this, do not trust the model.
- Turn cap is inclusive of both AIs. Reaching it stops scheduling and records
  `capped`. User stop records `stopped`. Neither is a failed session.
- Spend: show that two models are in play. Use existing `summariseSpend` /
  `ai.spendLimit` warning. Never invent a combined credit balance. Do not block
  spend (Praxis still cannot stop a provider mid-call) but do not start the next
  turn once the cap is hit.
- File-claim / worktree rules from FX-BE-094 still apply: no concurrent writes.
- Redact conversation prompts with the same secret rules as handover envelopes.

## Acceptance criteria

- A guest in consult/pair-guest cannot persist a file change in tests.
- The (N+1)th AI turn is not started.
- The spend banner still speaks in reported currency, not "credits remaining".
- Handover and model-change paths are unchanged when no conversation is active.

## Verification

Core tests for tool-mode gating and cap; desktop assertion that Stop / cap copy
is visible. `npm run test:core`.

## Description


## Dependencies


## Comments
