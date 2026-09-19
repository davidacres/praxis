# FX-BE-130 — Provider extensions and session allowance correctness

**Type:** Story  
**Status:** Complete  
**Priority:** High  
**Depends on:** FX-BE-093, FX-BE-115, FX-BF-041

## Impact

Z.ai is available as a first-class API provider, known model usage contributes
to cost and budget visibility, and runtime changes no longer leave stale limit
messages or unusable provider choices in the session UI.

## Delivered tickets

- TASK-354 — Z.ai provider support and pricing-aware usage estimates.
- TASK-355 — Z.ai cost and budget reporting boundary proof.
- TASK-356 — Runtime limit-state and provider-picker fixes.

## Acceptance and validation

Provider routing, pricing, runtime-switch regressions, and provider picker
behavior were covered by the verified core, renderer, main, and desktop checks
recorded in the linked plan.
