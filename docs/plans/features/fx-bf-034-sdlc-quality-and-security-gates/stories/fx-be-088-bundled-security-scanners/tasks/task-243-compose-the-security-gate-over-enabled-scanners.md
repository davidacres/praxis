---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-243
title: "Compose the security gate over the union of enabled scanners"
status: To Do
story: FX-BE-088
updated: 2026-09-09
dependencies: [TASK-242]
---

# TASK-243: Compose the security gate over the union of enabled scanners

**Priority:** High
**Created:** 2026-09-09

## Goal

Let the `security` gate be satisfied by a join over several scanner check nodes rather than one. The gate passes only when every enabled scanner node succeeded (ran to completion, parsed) and the combined un-waived findings meet the policy threshold from TASK-239. The gate detail reports which scanners ran, which are disabled, and the combined count against the bar.

## Implementation entry points

packages/core/src/workflows/workflowGates.ts (multi-owner gate resolution: a gate kind may be owned by a set of nodes converging on a join), workflowValidation.ts (a multi-owner `security` gate needs each owner producing `findings` and a threshold), workflowTemplates.ts (the security branch becomes Secrets ∥ SAST ∥ SCA → join).

## Dependencies

- TASK-242
## Acceptance criteria

- With three scanners enabled and all clean, `security` passes; with one scanner node failed to parse, it fails naming that scanner; with a high finding above the bar, it fails naming the count.
- A disabled scanner is reported as disabled in the gate detail, not silently omitted.
- Existing single-node `security` gates (one `npm audit` check) still evaluate exactly as before.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Core tests for multi-owner gate pass/fail/pending and the disabled-scanner detail; a template-validation test for the multi-owner security branch. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Prove the "one scanner failed → gate fails" guard fails against a naive any-owner-passed check. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


