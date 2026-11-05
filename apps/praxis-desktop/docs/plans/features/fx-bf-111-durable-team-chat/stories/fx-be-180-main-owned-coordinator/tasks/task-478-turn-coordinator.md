---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-478
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-180
---

# TASK-478: Implement the durable sequential turn coordinator

Parent: [FX-BE-180](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Create a core TeamChatCoordinator hosted by a main singleton. Inject repository, execution adapter, clock and ID source. Resolve mentions and roster in main; commit the response plan before dispatch. Enforce one active turn per conversation.

## Dependencies

TASK-477

## Acceptance criteria

- Two simultaneous sends produce distinct FIFO queued turns, while repeated delivery of one command produces one turn.
- Selected members answer in dev, qa, security, product, lead order; an explicit mention selects only that member; an empty roster resolves to lead.
- Later members see earlier committed replies from their turn; no member sees queued future user messages.
- Changing roster or runtime defaults affects subsequent accepted turns only; failures pause the current turn and leave later turns queued.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Validation evidence (2026-11-05)

**Defect found and fixed.** `submitTurn` resolved the roster and computed the user message `sequence` from a snapshot read *before* its transaction. On the desktop file repository, which queues mutations, two simultaneous sends to one chat both computed sequence `N+1`; the second was rejected with `Invalid accepted turn.` A concurrent repeated command could also emit `turn_accepted` twice. The roster, response plan and sequence are now resolved against the transaction draft (`teamChatCoordinator.ts`, `resolvePlanParticipants` / `assertKnownParticipants`). Only the call whose turn won the receipt announces and dispatches it. ID generation and `captureRuntimeOptions` stay outside the mutation, so it remains synchronous.

| Criterion | Test (assertion names) | Runner |
| --- | --- | --- |
| AC1 | `TASK-478 AC1: Two simultaneous sends produce distinct FIFO queued turns, repeated delivery produces one turn`: "Concurrent repeated delivery of one command produces one turn", "Accepted user messages carry contiguous, increasing sequences", "The duplicate is announced once", "Turns dispatch in FIFO acceptance order". Uses a deferred repository that queues like the file adapter. | core |
| AC1 (file-backed) | `simultaneous sends to one chat on the file repository produce distinct FIFO turns and one turn per repeated command` (`teamChatIpcRecovery.test.ts`, temp profile): "a repeated command converges on its original turn", "provider calls follow acceptance order" | main |
| AC2 | `TASK-478 AC2: …`: all five roles selected scrambled; "The response plan is committed in canonical order before the first member runs", "Must answer in dev, qa, security, product, lead order", "Mention plan holds exactly that member", "Empty roster must resolve to lead" | core |
| AC3 | `TASK-478 AC3: …`: turn 2 is durably accepted while turn 1's dev reply is held; "QA must see earlier committed reply from dev", "QA, prepared after turn 2 was accepted, must not see it", "Turn 2 sees both turn 1 replies" | core |
| AC4 (roster/defaults) | `TASK-478 AC4: Changing roster affects subsequent accepted turns only; …`: runtime default model and QA instructions change after two turns are accepted; "Accepted turn keeps its runtime defaults", "Accepted turn keeps its roster", "A later accepted turn takes the new default", "A later accepted turn takes the new roster" | core |
| AC4 (failure) | `TASK-478 AC4: A failure pauses the current turn and leaves later turns queued until retried`: "Current turn must be paused on failure", "The queued turn never dispatches while the failed turn is paused", "Turns complete in order after retry" | core |

Commands run, with results:

- `npm run build:core && node --test packages/core/out/ai/assistant/teamChat{Coordinator,CrashBoundaries,Transitions,Context,Recovery,Migration,Bindings}.test.js` (run from `packages/core`): 67 passed, 0 failed.
- `npm run test:core`: 1948 tests, 1946 passed, 0 failed.
- `npm run test:git` (in `apps/praxis-desktop/main`): 147 passed, 0 failed.
- `npm run check-types`: clean.
- **Proof that the tests catch the bug.** With the previous coordinator restored, the core AC1 test and the file-backed main test both fail with `Invalid accepted turn.` With the fix, both pass. No other failure artifacts.

Not run, and not claimed:

- the full desktop functional and theme e2e suites;
- `durableTeamChat.live.spec.ts` (real provider, needs credentials).

No suite was added, so the npm test lists are unchanged.

## Description


## Comments

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
