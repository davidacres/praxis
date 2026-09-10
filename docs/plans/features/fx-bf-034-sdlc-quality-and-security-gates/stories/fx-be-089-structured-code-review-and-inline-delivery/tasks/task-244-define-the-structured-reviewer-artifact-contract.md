---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-244
title: "Define the structured reviewer artifact contract"
status: To Do
story: FX-BE-089
updated: 2026-09-09
dependencies: [FX-BE-087]
---

# TASK-244: Define the structured reviewer artifact contract

**Priority:** High
**Created:** 2026-09-09

## Goal

The reviewer stage declares a `findings` output and must return it: findings with `{ file, line, severity, category, message, suggestion? }`. Parsing is tolerant of a fenced JSON block in the agent's reply (as `aiReviewService.ts`'s clarification/task-designer prompts already do) plus an optional prose summary. A reviewer reply with no parseable findings block fails the artifact contract with a stated reason; the `review` gate then rests on the finding severities, evaluated by the engine.

## Implementation entry points

packages/core/src/ai/aiReviewService.ts (a structured reviewer prompt built from `CODE_REVIEW_SYSTEM_PROMPT`, plus a `parseReviewFindings`), packages/core/src/workflows/workflowRun.ts and workflowStageSession.ts (enforce the `findings` artifact on the review node the way other required artifacts are enforced), workflowGates.ts (the `review` gate reads severities like a threshold gate).

## Dependencies

- FX-BE-087
## Acceptance criteria

- A scripted reviewer returning a valid JSON findings block satisfies the contract; one returning only prose fails with a stated reason.
- The `review` gate is `failed` while an un-addressed finding at/above the blocking severity stands and `passed` only when none do; no path lets the agent mark it passed by claiming success.
- Prose summary, when present, is stored but is not the gate evidence.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows (the ticket-context AI review panel is unchanged).

## Verification

Unit tests for `parseReviewFindings` (valid block, prose-only, malformed) and for review-gate severity evaluation. Scripted-ACP reviewer fixture returning canned findings. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Prove the "prose-only fails" guard fails against the pre-change free-text `report`. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


