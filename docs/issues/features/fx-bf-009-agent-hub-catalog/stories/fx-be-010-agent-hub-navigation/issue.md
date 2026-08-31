# FX-BE-010 — Agent Hub navigation and scope-aware catalog

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BF-005

## Business or operational impact

Users need a trustworthy catalog instead of the Agents sidebar opening the New Session composer.

## Scope

- Render the Agent Hub route with Global and Current project groups.
- Refresh discovery and handle loading, empty, and error states.

## Acceptance criteria

- Selecting Agents opens the catalog.
- Global items remain visible without a project; project items are scope-limited.

## Validation

- `npm run check-types`
- Focused Agent Hub Playwright tests

## Close when

The catalog correctly reflects both discovery scopes and is keyboard accessible.
