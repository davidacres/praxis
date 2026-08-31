# FX-BE-014 — Import and validate runtime items

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-011

## Business or operational impact

Existing runtime items can be added without silent copying or execution.

## Scope

- Import agent manifests/folders and skill folders.
- Detect invalid, duplicate, missing, unsupported, and unsafe inputs.

## Acceptance criteria

- Invalid imports remain blocked with actionable errors.
- Valid imports appear after refresh and never overwrite silently.

## Validation

- `npm run test:core`
- Malicious-path and invalid-input tests

## Close when

Import is safe, deterministic, and scope-aware.
