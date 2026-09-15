---
**Status:** ✅ Complete
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-328
title: "Prove migration, handover and model-switch behavior end to end"
status: Done
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-15
dependencies: [TASK-326, TASK-327]
---

# TASK-328: Prove migration, handover and model-switch behavior end to end

## Objective

Provide deterministic regression evidence that continuous handover, model changes,
purpose display and the living brief work together without transcript, attribution,
accessibility or visual regressions.

## Implementation notes

- Extend the real scripted ACP fixture and add deterministic API provider stubs;
  no live-agent test belongs in the default suite. Opt-in proof of a real
  two-agent handover lives in `e2e/aiLiveHandover.live.spec.ts` (`PRAXIS_LIVE_AGENT=1`
  and `--project=live-agent` only).
- Cover old-record loading, automatic refresh after each completed turn, user edit
  preservation, stale/failed refresh display, API model change, ACP config-option
  change, ACP fresh-runtime fallback and cross-provider handover.
- Assert that handover preserves session/worktree identity and portable history,
  clears old provider-native state, and persists the receiver's response as a
  normal message used by the next follow-up.
- Cover disabled transitions during execution, approval and outstanding input,
  invalid/unavailable models, failed target startup and restart during refresh.
- Capture the Summary inspector, runtime history, model dialog and handover dialog.
  Inspect actual/diff images before accepting any snapshot updates.
- Update directly related user and maintainer documentation, including the fact
  that automatic brief refresh consumes an additional model operation.

## Acceptance criteria

- Tests fail against implementations that drop a handover response from the next
  transcript, overwrite user edits, reuse old ACP state or silently retain a
  rejected model.
- E2E proves the complete ticket → work → brief → model change → provider handover
  → follow-up journey in one Praxis session.
- Keyboard focus, responsive layout, light/dark themes and active surface packs
  remain usable and visually coherent.
- No snapshots are updated without inspection and no live provider spend occurs in
  the default suite.

## Verification

Run `npm run check-types`, `npm run test:core`, `npm run build`,
`npm run desktop:copy-renderer`, and `npm run test:desktop`. Launch the app and
manually complete the model-change and handover journey while inspecting the right
sidebar after each turn.

## Description


## Dependencies


## Comments

