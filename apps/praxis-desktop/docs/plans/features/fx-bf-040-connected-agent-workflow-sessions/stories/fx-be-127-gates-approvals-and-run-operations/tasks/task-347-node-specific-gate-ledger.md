---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.732Z
**Type:** Task
**Priority:** Medium
id: TASK-347
title: Make gate outcomes and evidence node-specific and durable
status: Planned
story: FX-BE-127
updated: 2026-09-17
dependencies: [TASK-341]
validation: [npm run test:core, npm run test:desktop]
---

# Make gate outcomes and evidence node-specific and durable

## Goal

Ensure each gate is satisfied only by the exact node outcome, required
artifacts, or deterministic check contract that owns it.

## Done when

- Gate ledger entries identify gate type, owning node, evidence, status, and
  policy source.
- Missing, stale, failed, and superseded evidence produce the correct blocked
  state and cannot be replaced by agent prose.
- Run summary, scheduler, and monitor read the same durable ledger.

## Notes

Retain audit history while presenting a concise normal-user digest in the
monitor and session inspector.

## Description


## Dependencies



## Comments
