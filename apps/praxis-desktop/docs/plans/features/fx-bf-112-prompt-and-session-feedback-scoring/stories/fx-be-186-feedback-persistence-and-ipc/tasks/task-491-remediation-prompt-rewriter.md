---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** Medium
id: TASK-491
type: Task
status: To Do
priority: Medium
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-186
---

# TASK-491: Add optional remediation prompt rewriter grounded in deterministic findings

Parent: [FX-BE-186](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `packages/core/src/ai/feedback/promptRewriteHelper.ts` and wire `ai:rewritePromptFromFeedback` in `aiIpc.ts`. Construct a deterministic template upgrade when no AI provider is requested and an optional bounded single-turn provider completion when requested, embedding explicit scope, verification criteria, and recommended skill/tool hints from `DeterministicFeedbackReport.findings`.

## Dependencies

TASK-490

## Acceptance criteria

- Deterministic fallback rewriter produces a structured, copy-ready prompt incorporating missing scope, verification steps, and skill/tool hints even offline or without an active model call.
- Optional AI rewrite attaches `aiRewrite: { rewrittenPrompt, rationale, modelId }` to the report without mutating `overallScore`, `grade`, or `dimensions`.

## Validation

Add unit tests in `packages/core/src/ai/feedback/promptRewriteHelper.test.ts` and register in `packages/core/package.json`.

## Done when

Unit tests pass and `npm run check-types` succeeds.

## Description


## Comments
