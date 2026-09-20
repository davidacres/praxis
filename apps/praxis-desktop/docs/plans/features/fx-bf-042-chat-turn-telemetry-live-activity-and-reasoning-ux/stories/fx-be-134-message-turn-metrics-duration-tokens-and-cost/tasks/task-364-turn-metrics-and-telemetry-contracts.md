---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-364
title: Define turn duration and message-level token/cost telemetry contracts in core
status: Complete
story: FX-BE-134
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-364: Define turn duration and message-level token/cost telemetry contracts in core

## Outcome

`packages/core` defines robust, backward-compatible type extensions on
`AgentEventSummary`, tracking turn duration in milliseconds, token usage
breakdowns (prompt, completion, reasoning), calculated turn cost, model
attribution, and tool names executed during that turn.

## Scope

- Extend `AgentEventSummary` in `packages/core/src/ai/agentTypes.ts` to support
  optional telemetry properties: `durationMs?: number`,
  `tokenUsage?: AgentTokenUsage`, `cost?: { currency: string; amount: number }`,
  `modelId?: string`, and `toolNames?: string[]`.
- Ensure serialization, event appending, and schema migration functions preserve
  existing transcripts cleanly without data loss or undefined property crashes.
- Mirror necessary type declarations in the desktop renderer without importing
  core value bundles (adhering strictly to `checkCoreImports`).

## Acceptance criteria

- `AgentEventSummary` supports duration, token usage, cost, modelId, and toolNames.
- Older stored sessions without these properties load gracefully with default
  fallbacks.
- Types compile cleanly in core, desktop-main, and renderer workspaces.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-core-imports --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
