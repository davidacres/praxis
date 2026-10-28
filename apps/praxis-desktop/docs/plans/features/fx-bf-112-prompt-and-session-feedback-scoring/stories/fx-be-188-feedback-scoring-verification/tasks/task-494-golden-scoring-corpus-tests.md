---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-494
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-188
---

# TASK-494: Add golden deterministic scoring corpus and IPC unit suites

Parent: [FX-BE-188](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `packages/core/src/ai/feedback/goldenCorpus.test.ts` and register it in `packages/core/package.json`. Test 8+ canonical prompt and session fixtures against `evaluateSessionOrPrompt`, asserting exact `overallScore`, `grade`, 5-dimension point breakdowns, `findings` order, and repeated-invocation byte identity.

## Dependencies

TASK-489, TASK-490, TASK-491

## Acceptance criteria

- Asserts exact deterministic scores and finding IDs for all 8 canonical archetypes.
- Confirms that shuffling unordered catalog inputs (discovered skills, MCP server list) produces the exact same `inputDigest` and `DeterministicFeedbackReport`.

## Validation

Run `npm run test:core` from the monorepo root.

## Done when

`goldenCorpus.test.ts` is registered in `packages/core/package.json` and passes in `npm run test:core`.

## Description


## Comments
