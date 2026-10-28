---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Story
**Priority:** High
id: FX-BE-185
type: Story
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
issue: docs/issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/issue.md
---

# FX-BE-185: Deterministic prompt, tool, skill, agent, and MCP evaluation engine

Parent: [FX-BF-112](../../feature.md). Issue mirror: [FX-BE-185](../../../../../issues/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/issue.md).

## User or operational impact

Prompts and completed sessions are evaluated by a pure, deterministic rubric in `@praxis/core` that produces reproducible `0–100` scores, 5-dimension breakdowns, and specific evidence-backed recommendations without relying on non-deterministic LLM grading.

## Scope

- Define typed contracts in `packages/core/src/ai/feedback/feedbackTypes.ts` and export them from `@praxis/core` (`agentTypes.ts` / `index.ts`) for prompt readiness and session execution evaluations, user feedback inputs, findings, and remediations.
- Implement pure signal analyzers (`promptSignals.ts`, `executionSignals.ts`, `capabilityAlignment.ts`) and the deterministic rubric aggregator (`sessionFeedbackScorer.ts`) covering prompt clarity, tool efficiency, skill/agent alignment, MCP leverage, and outcome/verification integrity.

## Dependencies

None

## Acceptance criteria

- 488: `feedbackTypes.ts` defines versioned contracts (`SCORING_RUBRIC_VERSION = 1`), deterministic `inputDigest` hashing over canonical evaluation inputs, and grade mapping (`A`/`B`/`C`/`D`/`F`), while keeping `@praxis/desktop-renderer` imports type-only.
- 489: Given identical prompt, session events, skill/agent catalog, MCP server list, and user feedback, `evaluateSessionOrPrompt` returns byte-identical scores, dimension breakdowns, and ordered findings.
- 489: Analyzers detect and deduct points for: vague/unscoped prompts, edit requests in `read-only` tool mode, repeated failed tool calls, raw `shell` search/file reads when structured or `code_intelligence` MCP tools are available, unattached trigger-matching skills (such as `plan-authoring` when touching `docs/plans/**`), and file writes with no subsequent verification command.

## Tasks

- [TASK-488: Define feedback, signal extraction, and deterministic rubric contracts](tasks/task-488-feedback-and-rubric-contracts.md)
- [TASK-489: Implement deterministic prompt, tool, skill, agent, and MCP analyzers](tasks/task-489-deterministic-signal-analyzers.md)

## Validation

Run `npm run build:core`, `npm run test:core`, and `npm run check-types`.

## Close when

Both tasks satisfy all acceptance criteria and unit tests in `packages/core` pass.

## Description


## Comments
