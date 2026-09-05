# FX-BE-034 — Signed auto-update

**Type:** Story  **Status:** Blocked  **Priority:** P2  **Depends on:** —

## Business or operational impact
Build-from-source is the single biggest adoption blocker: "start using it" currently means "maintain a local build."

## Scope
- Update-check and publish wiring — done (`30ead0b`).
- Code signing and notarization — needs the project owner's Apple/Windows developer credentials. Not something an agent can supply or start.

## Acceptance criteria
- A packaged build is signed and notarized.
- A running install applies an update from the publish feed without a manual reinstall.

## Validation
- `npm run build`

## Close when
A user installs a signed build once and it updates itself from then on.
