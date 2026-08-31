# FX-BE-011 — Agent and skill detail, trust, and capabilities

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-010

## Business or operational impact

Users must understand an item’s permissions and errors before allowing it to run.

## Scope

- Detail panes for manifests and skills.
- Trust, capabilities, fingerprints, validation errors, and safe actions.

## Acceptance criteria

- Invalid and untrusted items cannot start or activate.
- Everyday catalog actions are in Agents; policy and diagnostics remain in Settings.

## Validation

- `npm run test:core`
- Focused Agent Hub Playwright tests

## Close when

Trust and capability states are visible, understandable, and accessible.
