# FX-BE-129 — Session usage, cost, and provider allowance visibility

**Type:** Story
**Status:** Complete
**Priority:** Medium
**Depends on:** FX-BF-015, FX-BF-035

## Business or operational impact

Users can see token/cost consumption and warnings in the active session rather
than hunting through a separate provider dashboard. Missing provider balances
remain explicit instead of being inferred.

## Scope

- Provider-neutral usage snapshot and adapter boundary.
- Hourly/day/week/month session usage summary and model attribution.
- Praxis spend-limit warnings.
- Secure OpenAI Admin usage/cost retrieval.

## Acceptance criteria

- The session composer exposes session, windowed, and model usage.
- Warnings appear at configured allowance pressure without blocking sessions.
- OpenAI Admin credentials remain in the OS keychain/main process.
- Unsupported provider account fields are shown as unavailable and are
  extensible through adapters.

## Validation

- Core, renderer, and main-process typechecks.
- Renderer production build.
- Focused hourly usage aggregation tests.
- `git diff --check`.

## Close when

The completed session usage slice is visible, verified, and represented by the
provider-neutral contract described by the plan files.
