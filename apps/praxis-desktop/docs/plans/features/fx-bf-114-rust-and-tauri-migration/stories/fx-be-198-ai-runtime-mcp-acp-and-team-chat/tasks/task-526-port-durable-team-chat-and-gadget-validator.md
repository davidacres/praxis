---
**Created:** 2026-11-07T21:22:01.785Z
id: TASK-526
type: Task
status: In Progress
---

# Port durable team chat coordinator and praxis-gadget validator

**Status:** In Progress
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


- 2026-11-08: Status corrected to In Progress. A draft port exists in the working tree but is not committed, and the `praxis-ai` test target does not compile (duplicate `mod tests` in `team_chat/transitions.rs`, see `TASK-534`). Treat the draft as unverified until it is committed and its tests pass.
