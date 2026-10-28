---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-489
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-185
---

# TASK-489: Implement deterministic prompt, tool, skill, agent, and MCP analyzers

Parent: [FX-BE-185](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Implement `promptSignals.ts`, `executionSignals.ts`, `capabilityAlignment.ts`, and `sessionFeedbackScorer.ts` under `packages/core/src/ai/feedback/`. Extract deterministic signals from prompt text, `AgentSessionRecord.events` (`tool_start`, `tool_complete`, `permission_requested`, `error`), `activeSkills`, `detectedSkills` (`skillUsage.ts`), discovered skills/agents (`skillRegistry.ts`, `nativeSources.ts`), and MCP tool calls (`mcp__<server>__<tool>`, `tracker_*`, `browser_*`, `code_intelligence`).

## Dependencies

TASK-488

## Acceptance criteria

- Computes deterministic sub-scores across all 5 dimensions (Prompt Clarity 20, Tool Efficiency 25, Skill & Agent Alignment 20, MCP Leverage 15, Outcome & Verification 20) and normalizes pre-send prompt evaluations to `0–100`.
- Emits structured `FeedbackFinding` and `FeedbackRemediation` items naming the exact missed skill, better-suited agent profile, MCP tool alternative, or missing verification step.
- Incorporates explicit user feedback (`verdict` and `frictionTags`) deterministically into the Outcome & Verification dimension and finding severity ordering.

## Validation

Add unit tests in `packages/core/src/ai/feedback/sessionFeedbackScorer.test.ts` covering clean sessions, retry loops, shell-vs-MCP anti-patterns, missed skills, and read-only mode mismatches.

## Done when

All unit tests in `sessionFeedbackScorer.test.ts` pass and `npm run check-types` is clean.

## Description


## Comments
