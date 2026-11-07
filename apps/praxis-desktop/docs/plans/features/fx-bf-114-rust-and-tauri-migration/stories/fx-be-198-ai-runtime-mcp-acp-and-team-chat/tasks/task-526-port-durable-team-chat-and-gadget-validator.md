---
**Created:** 2026-11-07T21:22:01.785Z
id: TASK-526
type: Task
status: To Do
---

# Port durable team chat coordinator and praxis-gadget validator

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port `assistantEngine.ts`, `teamChatCoordinator.ts`, `teamChatBindings.ts`, `teamChatTransitions.ts`, `teamChatRecovery.ts`, `sessionHandover.ts`, `ticketReview.ts`, `humanReview.ts`, `feedback/`, and `gadgets/` (`validation.ts`, `gadgetRepair.ts`, `gadgetLifecycle.ts`, `imageGadget.ts`) into `crates/praxis-ai`.

## Acceptance Criteria

- All `assistant/`, `gadgets/`, and `feedback/` unit tests pass in `cargo test -p praxis-ai`.
- `durableTeamChat.spec.ts` passes.

## Dependencies

- `TASK-521`
- `TASK-524`

## Comments


