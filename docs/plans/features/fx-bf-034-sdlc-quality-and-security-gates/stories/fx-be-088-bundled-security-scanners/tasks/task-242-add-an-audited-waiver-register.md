---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-242
title: "Add an audited, expiring waiver register"
status: planned
story: FX-BE-088
updated: 2026-09-09
dependencies: [TASK-241]
---

# TASK-242: Add an audited, expiring waiver register

**Priority:** High
**Created:** 2026-09-09

## Goal

A project-scoped waiver register: entries of `{ fingerprint, reason, actor, createdAt, expiresAt }` that remove a matching finding from gate evaluation until `expiresAt`. Composed strictest-wins with the org (a project may shorten a lifetime, never extend past the org cap). Every add and remove is recorded on the run event log. A waiver only matches a finding computed on the same source snapshot the waiver was created against — a re-implemented snapshot re-exposes it.

## Implementation entry points

packages/core/src/workflows/waiverRegister.ts (new: types, match, expiry, compose); the gate evaluation path in workflowGates.ts (apply un-expired matching waivers before counting findings against a threshold); apps/praxis-desktop/main/src/main (persist in `<name>.praxis.<ext>` form using the shared constants); renderer waiver dialog collecting reason + expiry.

## Dependencies

- TASK-241
## Acceptance criteria

- A waiver for a seeded high finding's fingerprint clears the security block; the add is on the run event log with actor and reason.
- Past `expiresAt` the same finding re-blocks; a project waiver whose lifetime exceeds the org cap is refused with a stated reason.
- A waiver created against snapshot A does not match the same rule/location on snapshot B.
- Reason and expiry are required; a blank reason is refused by the dialog and the core API.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Core tests for match, expiry, snapshot binding and strictest-wins compose. Electron spec for the waiver dialog (required fields, keyboard focus) with inspected captures. Prove the expiry and lifetime-cap guards fail against a naive always-match. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


