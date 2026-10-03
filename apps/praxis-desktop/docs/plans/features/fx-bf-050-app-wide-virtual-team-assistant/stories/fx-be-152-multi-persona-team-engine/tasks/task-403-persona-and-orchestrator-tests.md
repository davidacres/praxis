---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-403
type: Task
status: Backlog
created: 2026-10-03
priority: Medium
---

# Unit tests for persona dispatch, team review orchestration, and context serialization

## Files and integration points

- `packages/core/src/ai/assistant/assistantPersonas.test.ts` (new): Core unit tests for persona configurations, validation, and mention matching.
- `apps/praxis-desktop/main/src/main/assistantIpc.test.ts` (new): Main-process unit tests for IPC turn handling, team review pipeline, and choice extraction.

## Implementation details

- Verify that `@dev`, `@qa`, `@security`, `@product`, and `@lead` regex tokenizers reliably match leading or embedded mentions in user messages.
- Test context truncation: ensure large page contexts (e.g. huge git diffs or dense boards) are cleanly truncated to fit token limits without throwing.
- Test fallback behavior when no AI provider is configured or when a provider call errors, confirming user-friendly error banners are returned.

## Testing and verification criteria

- `npm run test:core` passes with all persona tests green.
- Node test runner executes main assistant tests cleanly.
