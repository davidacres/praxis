---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Story
**Priority:** High
id: FX-BE-188
type: Story
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
issue: docs/issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/issue.md
---

# FX-BE-188: End-to-end verification and deterministic scoring corpus proof

Parent: [FX-BF-112](../../feature.md). Issue mirror: [FX-BE-188](../../../../../issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/issue.md).

## User or operational impact

Deterministic scoring reproducibility, capability-audit accuracy, persistence, and UI workflows are locked down with golden fixture tests and Playwright E2E coverage.

## Scope

- Create a golden deterministic scoring corpus test suite (`packages/core/src/ai/feedback/goldenCorpus.test.ts`) verifying exact scores, dimension points, and `inputDigest` reproducibility across representative prompt and session archetypes.
- Create `apps/praxis-desktop/main/e2e/sessionFeedback.spec.ts` exercising pre-send prompt scoring, one-click composer remediation, post-session scorecard inspection, human feedback submission, persistence across reload, and visual verification.

## Dependencies

FX-BE-187

## Acceptance criteria

- 494: Golden corpus suite asserts exact integer scores, sub-scores, and finding IDs across at least 8 archetypes (exemplary session, retry-loop session, missed-skill session, shell-instead-of-MCP session, unverified-write session, read-only mismatch prompt, vague prompt, well-scoped prompt) and proves 100-run determinism.
- 495: `sessionFeedback.spec.ts` passes in the built Electron app, proving pre-send composer scoring, one-click skill/mode remediation, post-session scorecard audit, feedback persistence, and visual inspection.

## Tasks

- [TASK-494: Add golden deterministic scoring corpus and IPC unit suites](tasks/task-494-golden-scoring-corpus-tests.md)
- [TASK-495: Verify composer and session feedback journeys in Playwright E2E](tasks/task-495-feedback-ui-e2e-verification.md)

## Validation

Run `npm run test:core`, `npm run test:e2e --workspace=@praxis/desktop-main -- sessionFeedback.spec.ts --project=functional`, and `npm run test:desktop:smoke`.

## Close when

Both tasks pass all assertions and visual verification screenshots are retained.

## Description


## Comments
