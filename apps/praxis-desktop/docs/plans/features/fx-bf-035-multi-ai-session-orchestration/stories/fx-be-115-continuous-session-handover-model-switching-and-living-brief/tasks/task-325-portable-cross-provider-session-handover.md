---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-325
title: "Hand a continuous session between providers using portable context"
status: Proposed
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-14
dependencies: [TASK-322, TASK-323, FX-BE-092, FX-BE-093]
---

# TASK-325: Hand a continuous session between providers using portable context

## Objective

Move responsibility for the same Praxis session to another provider/model while
preserving durable work and explicitly resetting state that belongs only to the
old provider runtime.

## Implementation notes

- Add typed handover IPC requiring a target provider/model and expected brief
  revision. Complete or await the final brief refresh before committing the
  transition.
- Preserve purpose, Praxis message/event history, living brief, working directory
  and worktree metadata, workflow attribution, durable tasks and bounded Git/change
  evidence.
- Close and retain the old epoch, then clear provider-native runtime IDs, ACP
  commands/modes, live context occupancy and other capability state that cannot be
  transferred. Start a fresh native runtime where the target requires one.
- Seed the receiver with a versioned handover envelope containing the purpose,
  brief, compacted relevant transcript, workspace/worktree identity and an
  instruction to verify the current files rather than trust prose as ground truth.
- Persist a visible `provider_handover` event naming source and destination. The
  receiving agent's answer remains a normal `message` event so later follow-ups do
  not lose it.
- If preflight, final refresh or target startup fails, retain the source epoch and
  report the exact blocked stage. Never return a success-shaped partial handover.

## Acceptance criteria

- The issue key, session ID and worktree remain stable across handover.
- Provider-native IDs and capabilities do not leak into the receiving epoch.
- The receiver can state the task, completed work and next step from the portable
  envelope and can inspect the existing changes in the same worktree.
- A failed handover leaves the source provider usable and records no false epoch.
- Redaction and size bounds from FX-BE-092 apply to every handover envelope.

## Verification

Run deterministic cross-provider host tests, `npm run test:core`, and
`npm run check-types`.

## Description


## Dependencies


## Comments

