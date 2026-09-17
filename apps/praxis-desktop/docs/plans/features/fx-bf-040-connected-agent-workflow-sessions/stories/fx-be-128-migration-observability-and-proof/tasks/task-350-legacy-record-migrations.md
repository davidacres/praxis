---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.733Z
**Type:** Task
**Priority:** Medium
id: TASK-350
title: Define migrations and compatibility behavior for legacy records
status: Planned
story: FX-BE-128
updated: 2026-09-17
dependencies: [TASK-335, TASK-343]
validation: [npm run test:core, npm run test:desktop]
---

# Define migrations and compatibility behavior for legacy records

## Goal

Version and migrate session, workflow, binding, pack, and run records without
rewriting historical meaning or breaking old projects.

## Done when

- Old records load through explicit migrations with fixture coverage and no
  destructive rewrite on read.
- Legacy provider-only sessions and prompt-only packs remain supported.
- New records identify the connected model and report migration diagnostics
  when an old binding cannot be made ready.

## Notes

Do not mark the feature complete based only on a type migration; reopen and
execute representative old records.

## Description


## Dependencies



## Comments
