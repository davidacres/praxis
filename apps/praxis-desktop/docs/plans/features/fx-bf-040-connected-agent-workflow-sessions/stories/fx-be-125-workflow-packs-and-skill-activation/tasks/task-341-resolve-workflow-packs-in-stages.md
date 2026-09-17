---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.730Z
**Type:** Task
**Priority:** Medium
id: TASK-341
title: Resolve workflow packs into stage task context and provenance
status: Planned
story: FX-BE-125
updated: 2026-09-17
dependencies: [TASK-335]
validation: [npm run test:core, npm run test:desktop]
---

# Resolve workflow packs into stage task context and provenance

## Goal

Make `WorkflowAgentTaskNode.workflowPackId` operational for governed stages,
with bounded content resolution and immutable provenance.

## Done when

- Stage task construction resolves the declared pack from the correct project
  root and includes its instructions or a safe reference.
- Missing, ambiguous, or out-of-scope packs fail readiness with a clear reason.
- Run/node records retain pack id, source, version/hash, and resolution mode.

## Notes

The pack supplies stage guidance only. It must not create hidden graph edges,
skip checks, or grant approval.

## Description


## Dependencies



## Comments
