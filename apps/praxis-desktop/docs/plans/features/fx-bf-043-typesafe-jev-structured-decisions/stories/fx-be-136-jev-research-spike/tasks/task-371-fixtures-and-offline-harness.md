---
**Status:** 📋 To Do
**Created:** 2026-09-21T09:00:00.000Z
**Type:** Task
**Priority:** Low
id: TASK-371
title: Assemble scrubbed fixtures and an offline comparison harness
status: To Do
story: FX-BE-136
feature: FX-BF-043
updated: 2026-09-21
---

# TASK-371: Assemble scrubbed fixtures and an offline comparison harness

## Outcome

A repeatable way to run the same inputs through the current rules and Jev.

## Scope

- Collect real freeform plan-status strings and failed-run logs from this repo, scrubbed of secrets and paths.
- Reuse existing fixtures (`checkEnvironmentFailure.test.ts`, plan-status cases).
- Harness lives outside shipped code (scratchpad or unshipped script) and reads the API key from the environment.

## Acceptance criteria

- Fixtures carry a ground-truth label each.
- Harness prints per-site accuracy, confusion, and confidence for both approaches.

## Description


## Comments
