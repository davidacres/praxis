# FX-BE-188: End-to-end verification and deterministic scoring corpus proof

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-188](../../../../../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/story.md).

## Impact and scope

Deterministic scoring reproducibility, capability-audit accuracy, persistence, and UI workflows are locked down with golden fixture tests and Playwright E2E coverage.

## Dependencies

FX-BE-187

## Acceptance criteria

- 494: Golden corpus suite asserts exact integer scores, sub-scores, and finding IDs across at least 8 archetypes and proves 100-run determinism.
- 495: `sessionFeedback.spec.ts` passes in the built Electron app, proving pre-send composer scoring, one-click skill/mode remediation, post-session scorecard audit, feedback persistence, and visual inspection.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
