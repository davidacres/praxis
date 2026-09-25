---
**Status:** 🔄 In Progress
**Created:** 2026-09-10T10:48:08.259Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-092
title: "Shared session context and handoff contracts"
status: In Progress
feature: FX-BF-035
updated: 2026-09-25
dependencies: [FX-BF-011, FX-BF-019]
---

# FX-BE-092: Shared session context and handoff contracts

## Outcome

Every provider receives deterministic task context and produces a machine-readable handoff another provider can consume.

## Tasks

- **TASK-253 Define versioned Task, Session, ContextSnapshot, Handoff and ChangeSet contracts.**
- **TASK-254 Generate bounded snapshots from the task graph, Git state, decisions and relevant files.**
- **TASK-255 Generate provider-specific prompts from the common session envelope.**
- **TASK-256 Validate handoffs, redact secrets and persist snapshot manifests and evidence links.**

## Acceptance

A fixture task started with one provider can be resumed by another using only repository artifacts and the snapshot. Snapshot content records source commit, included and excluded files, dependencies and generation version. Malformed handoffs block progression with a useful reason.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments



## Review 2026-09-25 — status corrected from To Do to In Progress

Partly delivered by FX-BE-115, which shipped the handover path this story
specified. Found during the board review; the ticket was stale at To Do
(updated 2026-09-10).

Delivered:

- `packages/core/src/ai/sessionHandover.ts` defines a versioned handover
  contract (`HANDOVER_BRIEF_SCHEMA_VERSION`) and `buildHandoverEnvelope`,
  which emits a machine-readable envelope — purpose, living brief, touched
  files, worktree path and branch, compacted transcript — that a second
  provider consumes verbatim to resume the same session (TASK-253, TASK-255).
- `redactHandoverSecrets` strips secrets from both the brief and the
  transcript before handover (part of TASK-256).
- Covered by `sessionHandover.test.ts` and exercised in the desktop surface
  via `SessionHandover.tsx` and `SessionInspector.tsx`.

Not yet delivered, which is why this is In Progress rather than Done:

- TASK-254's bounded `ContextSnapshot` is not implemented as a distinct
  contract. The envelope carries touched files, but not the acceptance
  criterion's source commit, explicit included/excluded file sets, or task
  dependencies.
- TASK-256's validation half is missing: there is no malformed-handoff check
  that blocks progression with a reason, and no persisted snapshot manifest
  or evidence links.

Remaining scope is TASK-254 and the validation/manifest half of TASK-256.
