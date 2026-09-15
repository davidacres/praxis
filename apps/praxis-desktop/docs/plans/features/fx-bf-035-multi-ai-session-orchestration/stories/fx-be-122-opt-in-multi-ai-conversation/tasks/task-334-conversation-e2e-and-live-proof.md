---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-334
title: "Prove conversation, identity and safety end to end"
status: Complete
story: FX-BE-122
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-331, TASK-332, TASK-333]
---

# TASK-334: Prove conversation, identity and safety end to end

## Objective

Prove the conversation is visible, attributable and bounded without putting live
spend in the default suite, and keep a small opt-in live relay for two real CLIs.

## Implementation notes

- Deterministic e2e with two scripted ACP (or API) stubs: start conversation,
  assert two distinct assistant identities in chat, assert Hand over still does
  relay only, assert Stop and cap, assert guest cannot write in consult.
- Opt-in live spec `*.live.spec.ts`, `PRAXIS_LIVE_AGENT=1` and
  `--project=live-agent` only. Small task: host outlines one step, guest answers,
  host finishes; success is `node --test` plus visible alternating speakers.
  Never add it to `npm run test:desktop`.
- Keyboard, light/dark and surface-pack checks on the dialog and transcript.
  Inspect actual/diff images before accepting snapshots.
- Update PLAN_MAP, feature-parity and AGENTS.md so Hand over and Bring in another
  AI are described as different actions.

## Acceptance criteria

- Default desktop suite has no live provider spend.
- Tests fail if an AI turn is rendered as the user, if Hand over starts a
  conversation, or if the guest writes in consult mode.
- Live proof is skippable without `PRAXIS_LIVE_AGENT=1`.

## Verification

`npm run check-types`, `npm run test:core`, `npm run desktop:copy-renderer`,
`npm run test:desktop`. Live file only on request.

## Description


## Dependencies


## Comments
