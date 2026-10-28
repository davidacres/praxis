# FX-BE-185: Deterministic prompt, tool, skill, agent, and MCP evaluation engine

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-185](../../../../../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/story.md).

## Impact and scope

Prompts and completed sessions are evaluated by a pure, deterministic rubric in `@praxis/core` that produces reproducible `0–100` scores, 5-dimension breakdowns, and specific evidence-backed recommendations without relying on non-deterministic LLM grading.

## Dependencies

None

## Acceptance criteria

- 488: `feedbackTypes.ts` defines versioned contracts (`SCORING_RUBRIC_VERSION = 1`), deterministic `inputDigest` hashing over canonical evaluation inputs, and grade mapping (`A`/`B`/`C`/`D`/`F`), while keeping `@praxis/desktop-renderer` imports type-only.
- 489: Given identical prompt, session events, skill/agent catalog, MCP server list, and user feedback, `evaluateSessionOrPrompt` returns byte-identical scores, dimension breakdowns, and ordered findings.
- 489: Analyzers detect and deduct points for: vague/unscoped prompts, edit requests in `read-only` tool mode, repeated failed tool calls, raw `shell` search/file reads when structured or `code_intelligence` MCP tools are available, unattached trigger-matching skills, and file writes with no subsequent verification command.

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
