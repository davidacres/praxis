---
**Status:** 📋 Proposed
**Created:** 2026-08-31T20:04:21.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-014
title: Import and validate runtime items
status: complete
feature: FX-BF-010
issue: docs/issues/features/fx-bf-010-agent-skill-creation/stories/fx-be-014-import-and-validate-runtime-items/issue.md
updated: 2026-08-31
tasks: [TASK-084, TASK-085]
dependencies: [FX-BE-011]
validation: [npm run test:core, npm run check-types, focused desktop tests]
---

# Import and validate runtime items

## Impact

Existing agents and skills can be brought into Praxis with visible validation rather than silently copied or executed.

## Scope

- Import existing agent folders/manifests and skill folders.
- Duplicate, missing-file, unsupported-transport, and traversal checks.
- Metadata-only discovery with no execution during import.

## Acceptance criteria

- Invalid imports remain blocked and explain the error.
- Valid imports appear in the selected scope after refresh.
- Duplicate ids/names require an explicit resolution and never overwrite silently.

## Close when

Import is safe, deterministic, scope-aware, and covered by malicious-path and invalid-input tests.

## Description


## Dependencies



## Comments


