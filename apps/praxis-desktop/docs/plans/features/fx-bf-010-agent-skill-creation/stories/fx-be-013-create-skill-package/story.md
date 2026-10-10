---
**Status:** ✅ Complete
**Created:** 2026-08-31T20:04:21.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-013
title: Create complete Skill package
status: Done
feature: FX-BF-010
issue: docs/issues/features/fx-bf-010-agent-skill-creation/stories/fx-be-013-create-skill-package/issue.md
updated: 2026-10-10
tasks: [TASK-082, TASK-083]
dependencies: [FX-BE-010]
validation: [npm run test:core, npm run check-types, focused desktop tests]
---

# Create complete Skill package

## Impact

Users can create reusable, discoverable skills with the structure expected by Praxis rather than a single loose instruction file.

## Scope

- Metadata and instruction wizard.
- `SKILL.md`, `scripts/`, `references/`, `examples/`, and test starters.
- Front matter, name, trigger, duplicate, and safe-write validation.

## Acceptance criteria

- Generated front matter is valid and immediately indexable.
- Optional content folders are created consistently.
- No user-supplied path can escape the selected scope.

## Close when

A generated skill indexes, displays, and can be activated through the Agent Hub.

## Description


## Dependencies



## Comments

**2026-10-10:** Status rollup corrected during backlog review: every task under this story is already Complete, so the story is Done.
