---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-402
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Page context protocol and assistant IPC handlers in main

## Files and integration points

- `apps/praxis-desktop/main/src/main/assistantIpc.ts` (new): Implements `assistant:turn` and `assistant:teamReview` IPC handlers.
- `apps/praxis-desktop/main/src/main/aiReviewRuntime.ts`: Reused for low-latency provider streaming and turn completion.
- `apps/praxis-desktop/main/src/preload/index.ts`: Exposes `window.praxis.assistant` API to the renderer.

## Implementation details

- `assistant:turn`:
  - Receives `message`, `personaId`, `context?: PageAssistantContext`, and `history: AssistantMessage[]`.
  - Parses `@mention` tags in message (e.g., `@qa`, `@security`) to route to the targeted persona; defaults to `lead` if none specified.
  - Injects `PageAssistantContext` into the prompt under a clear demarcated boundary (`[Current Page Context: <title>]`).
  - Returns `AssistantTurnResult` including parsed text, extracted interactive choice buttons, and any suggested structured proposals.
- `assistant:teamReview`:
  - Receives `context: PageAssistantContext` and `prompt?: string`.
  - Executes a coordinated 4-pass pipeline:
    1. Dev evaluates technical feasibility and architecture.
    2. QA evaluates edge cases and missing test paths.
    3. Security evaluates threats, secrets, and auth.
    4. Lead synthesizes the inputs and provides a concise verdict with next steps.
  - Returns an array of persona messages ready to append to the chat stream.

## Testing and verification criteria

- Automated tests exercising `assistant:turn` with mock AI runtime, asserting correct persona prompt selection and context injection.
- Automated tests verifying `assistant:teamReview` execution order and output structure.
