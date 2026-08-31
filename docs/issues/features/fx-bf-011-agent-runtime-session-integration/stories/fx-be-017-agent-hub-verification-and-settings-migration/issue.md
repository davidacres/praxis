# FX-BE-017 — Advanced Settings boundary and verification

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-015, FX-BE-016

## Business or operational impact

Runtime configuration has one clear home and the visible desktop workflow is regression-protected.

## Scope

- Keep paths, policy, trust, and diagnostics in Settings.
- Verify catalog, creation, lifecycle, activation, accessibility, and visual states.

## Acceptance criteria

- Settings no longer duplicates everyday catalog management.
- E2E tests use the rebuilt and copied renderer and cover keyboard/error states.

## Validation

- `npm run build:core`
- `npm run build:renderer && npm run desktop:copy-renderer`
- Focused Playwright tests

## Close when

Agent Hub and Settings responsibilities are coherent and affected checks pass.
