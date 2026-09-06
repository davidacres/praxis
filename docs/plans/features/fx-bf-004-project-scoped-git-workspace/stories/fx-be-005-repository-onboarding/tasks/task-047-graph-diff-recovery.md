---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:32.002Z
**Type:** Task
**Priority:** Medium
id: TASK-047
title: Integrate onboarding with Graph/diff loading and friendly error recovery
status: complete
story: FX-BE-005
updated: 2026-08-27
dependencies: [TASK-045, TASK-046]
validation: ["npm run frontend:build", "npm run electron:check-types"]
---

# TASK-047: Integrate onboarding with Graph/diff loading and friendly error recovery

## Integrate onboarding with Graph/diff loading and friendly error recovery

## Goal

Ensure Git Graph and diff loading only run after successful preflight and that retry, refresh, and changed-folder flows recover cleanly.

## Done when

- `git:open` is not called for an invalid project context.
- Valid repositories enter the existing graph/diff workspace directly.
- Errors provide a clear explanation, target folder, and safe next action.
- Repository changes made outside Praxis can be refreshed without stale context.

## Notes

Preserve the existing clean diff workspace; onboarding should be a gateway, not a competing editor.

## Description


## Dependencies



## Comments


