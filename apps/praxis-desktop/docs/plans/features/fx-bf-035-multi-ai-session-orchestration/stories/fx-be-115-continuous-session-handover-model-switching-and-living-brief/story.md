---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-115
title: "Continuous session handover, model switching and living brief"
status: To Do
feature: FX-BF-035
updated: 2026-09-14
dependencies: [FX-BE-092, FX-BE-093, FX-BF-015, FX-BF-017]
---

# FX-BE-115: Continuous session handover, model switching and living brief

## Outcome

A user can see why an agent session exists, follow an accurate living summary of
the work, change models between turns, and hand the same Praxis session to another
provider without losing the ticket context, worktree, transcript or decisions.
Each provider/model segment remains visible and attributable, while
provider-native state that cannot safely transfer is reset rather than presented
as portable.

## Product decisions

- A handover remains one user-visible Praxis session. Provider and model changes
  create immutable runtime epochs inside it rather than separate successor
  sessions.
- The living brief refreshes automatically after every completed user-visible
  turn. It is editable, revision-safe, and clearly reports stale or failed refresh
  state.
- Model changes and provider handovers occur only between turns. Praxis never
  interrupts an executing model call or an unresolved approval/input request.
- The session purpose is a durable snapshot of the ticket or plan at session
  creation, with `taskDefinition` as the compatibility fallback for old records.

## Tasks

- **TASK-322 Add purpose, living-brief and runtime-epoch session contracts.**
- **TASK-323 Refresh a revision-safe living brief after every completed turn.**
- **TASK-324 Change models safely between turns across API and ACP providers.**
- **TASK-325 Hand a continuous session between providers using portable context.**
- **TASK-326 Add purpose, brief, runtime history and transition controls to the session UI.**
- **TASK-327 Integrate every session entry point and preserve attribution and recovery.**
- **TASK-328 Prove migration, handover and model-switch behavior end to end.**

## Acceptance

An existing persisted session still opens without migration failure. A new session
shows its ticket or plan purpose and a living brief in the right sidebar. After
each completed turn the brief advances to the new event revision without
overwriting a concurrent user edit. A model change affects the next turn and adds
an attributable runtime epoch. A provider handover keeps the same Praxis session,
worktree and portable conversation context, starts a fresh provider-native runtime
where required, and tells the receiving AI what has happened and what remains.
Failures are explicit and leave the previous runtime or brief intact.

## Evidence

Core persistence and migration tests; API and ACP host tests for model changes,
unsupported ACP reconfiguration and fresh-runtime fallback; deterministic
cross-provider fixtures; desktop e2e coverage for purpose, editing, freshness,
disabled transition states and handover; and visual inspection of the right
sidebar and themed dialogs.

## Description


## Dependencies


## Comments

