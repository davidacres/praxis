# FX-BE-013 — Create complete Skill package

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-010

## Business or operational impact

Users can create reusable skills with the complete structure Praxis expects.

## Scope

- Generate `SKILL.md`, scripts, references, examples, and tests.
- Validate metadata, triggers, duplicates, and safe writes.

## Acceptance criteria

- Generated front matter is immediately indexable.
- User input cannot escape the selected scope.

## Validation

- `npm run test:core`
- Focused desktop creation tests

## Close when

A generated skill indexes, displays, and activates through Agent Hub.
