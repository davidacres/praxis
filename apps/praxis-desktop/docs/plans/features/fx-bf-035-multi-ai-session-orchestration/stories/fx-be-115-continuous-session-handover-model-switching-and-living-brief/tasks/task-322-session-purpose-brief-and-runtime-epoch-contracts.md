---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-322
title: "Add purpose, living-brief and runtime-epoch session contracts"
status: Proposed
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-14
dependencies: [FX-BE-115, FX-BE-092]
---

# TASK-322: Add purpose, living-brief and runtime-epoch session contracts

## Objective

Extend the persisted agent-session record with the portable, versioned state
needed to explain the session, maintain a handover brief and attribute each
provider/model segment without breaking existing records keyed by issue.

## Implementation notes

- Add a purpose snapshot containing the source issue/plan key and title, goal,
  scope and definition of done. Preserve `taskDefinition` as the fallback for old
  sessions and for entry points that cannot yet provide richer source metadata.
- Add a structured living brief with progress, material changes, decisions,
  risks/blockers, open questions, next steps and protected user notes. Record its
  schema version, revision, source-event position, updated time and freshness
  state.
- Add immutable runtime epochs recording provider, model, provider-native runtime
  ID, start/end time and transition reason (`started`, `model_change` or
  `provider_handover`). Keep top-level `provider` and `model` as current-value
  compatibility fields.
- Keep API token totals, ACP context occupancy and costs semantically distinct.
  Attribute only values a provider actually reports; do not derive or translate
  one usage shape into another.
- Add `AiSessionManager` helpers that update the brief and transition epochs
  atomically, persist before publishing change events, and reject stale expected
  revisions.

## Acceptance criteria

- Records written before this task load unchanged and derive a useful purpose
  from `taskDefinition`.
- A new session starts with one open epoch and a versioned purpose/brief shape.
- Epochs cannot overlap and a failed transition does not close the current epoch.
- A stale brief edit/update is rejected without overwriting the newer revision.
- Session-manager tests cover serialization, migration and invalid transitions.

## Verification

Run `npm run test:core` and `npm run check-types`.

## Description


## Dependencies


## Comments

