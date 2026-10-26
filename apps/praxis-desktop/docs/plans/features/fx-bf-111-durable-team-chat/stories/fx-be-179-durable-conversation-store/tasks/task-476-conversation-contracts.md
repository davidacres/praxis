---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-476
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-179
---

# TASK-476: Define typed conversation, turn, attempt, and binding contracts

Parent: [FX-BE-179](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Extend assistantTypes.ts and agentTypes.ts with the versioned model in the feature design; introduce pure transition validation in core. Keep browser imports type-only. Define typed execution ownership without changing standalone session ownership.

## Dependencies

None

## Acceptance criteria

- A duplicate submit command with identical payload resolves to the original turn; the same command ID with a different payload is rejected.
- Transition tests reject a second running turn, stale revision writes, duplicate participant completion, and completion by a fenced attempt.
- Types distinguish conversation ID, turn ID, participant ID, attempt ID, and optional provider session ID; no association requires parsing a title or diagnostic event.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments
