---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-488
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-185
---

# TASK-488: Define feedback, signal extraction, and deterministic rubric contracts

Parent: [FX-BE-185](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `packages/core/src/ai/feedback/feedbackTypes.ts` and wire lightweight summary fields onto `AgentSessionRecord` in `packages/core/src/ai/agentTypes.ts`. Define `UserFeedbackInput`, `FeedbackEvaluationInput`, `DeterministicFeedbackReport`, `FeedbackDimensionScore`, `FeedbackFinding`, `FeedbackRemediation`, canonical input digest computation, and `SCORING_RUBRIC_VERSION = 1`.

## Dependencies

None

## Acceptance criteria

- Contracts distinguish `prompt-readiness` (pre-send / standalone prompt) from `session-execution` (post-turn / historical session) evaluations.
- Canonical digest helper produces identical SHA-256 hex digests regardless of object key insertion order.
- Exporting the types from `@praxis/core` passes `npm run check-core-imports` and `npm run check-types`.

## Validation

Add unit tests in `packages/core/src/ai/feedback/feedbackTypes.test.ts` and register in `packages/core/package.json`.

## Done when

All acceptance criteria pass and `npm run test:core` succeeds.

## Description


## Comments
