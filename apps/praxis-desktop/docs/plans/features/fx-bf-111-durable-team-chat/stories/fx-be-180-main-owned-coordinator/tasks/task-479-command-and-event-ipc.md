---
**Status:** ✅ Complete
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-479
type: Task
status: Done
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-180
---

# TASK-479: Expose validated commands and revisioned conversation updates

Parent: [FX-BE-180](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Replace renderer-owned turn/save sequencing with submitTurn, getConversation, listChats, subscribe, cancelTurn, retryParticipant and resolveAttempt commands through AssistantIpc/preload. Keep CRUD routed through the same repository; reject legacy whole-transcript saves for migrated chats.

## Dependencies

TASK-478

## Acceptance criteria

- An IPC timeout after durable acceptance followed by resubmission of the same command ID returns the original turn ID.
- A new window loads a snapshot and applies newer revisions; duplicate events are ignored and a revision gap triggers a fresh snapshot without replaying work.
- Invalid participant, project, attachment reference, permission choice and stale retry target are rejected before provider invocation.
- Closing the initiating renderer does not cancel accepted work; another window can observe the same turn and pending approval.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments


**PRX-T111-479** — 2026-11-05T18:14:45.026Z
**Workflow run failed: Governed delivery — TASK-479: Expose validated commands and revisioned conversation updates**

Status: Failed · Duration: 17m 38s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T111-479** — 2026-11-05T18:39:47.153Z
**Workflow run succeeded: Governed delivery — TASK-479: Expose validated commands and revisioned conversation updates**

Status: Succeeded · Duration: 42m 41s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded
## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.

## Validation evidence (2026-11-05)

**Gaps closed.** Stale controls were silent no-ops; they now answer `conflict` (`stale-revision`, `stale-target`, `not-actionable`) with the fresh conversation (`controlWithOutcome`). `cancelTurn`, `retryParticipant` and `resolveAttempt` are typed, revision-fenced IPC commands. A pure adapter (`teamChatCommands.ts`) rejects an unknown participant, project, mismatched page context, unknown or tampered attachment and invalid runtime before any provider call. `createChat` rejects an unknown project. `assistant.spec.ts` now creates its legacy-fence chat with `''` on purpose.

| Criterion | Test | Runner |
| --- | --- | --- |
| AC1 | `TASK-479 AC1` (core and `teamChatCommands.test.ts`): lost acknowledgement after durable acceptance, same command ID returns the original turn; one turn, one provider call; changed payload conflicts | core, main |
| AC2 | `TASK-479 AC2 new window / duplicates / gap` (`conversationSubscription.test.ts`): newer revisions publish, duplicate and older revisions are ignored, a gap causes one snapshot read and no command replay | renderer |
| AC3 | `TASK-479 AC3` (core and main): participant, project, foreign context, attachment, tampered attachment, permission, stale retry target; zero provider calls. `durableTeamChat.spec.ts` asserts `cancelTurn` with a stale revision returns `conflict` | core, main, e2e |
| AC4 | `TASK-479 AC4` (main): initiating listener unsubscribes, turn completes, the other listener sees it. e2e `closing the initiating window keeps its accepted turn and pending approval observable from another window`: one provider prompt, approval allowed from the other window | main, e2e |

**Commands run (all passed):** `npm run build:core`; `node --test` on `teamChat{Coordinator,CrashBoundaries,Transitions,Recovery,Bindings}.test.js`; `npm run test:git --workspace=@praxis/desktop-main` (153); `npm run test:renderer` (37); `npm run check-types`; renderer build, `desktop:copy-renderer`, `build:desktop`; `playwright test durableTeamChat.spec.ts assistant.spec.ts sessionTeam.spec.ts --project=functional` (42 tests; the new closed-initiator test was fixed to use a project chat and re-run, 1 passed).

**Screenshot:** `.praxis/session-artifacts/durable-team-chat-closed-initiator.png` shows the pending approval in the surviving window.

**Not run:** full `test:desktop`, themes, `durableTeamChat.live.spec.ts` (needs credentials). Deferred to TASK-483: stop also cancelling queued turns, aligning coordinator cancel/retry with `control`, an `accept` resolution. Deferred to TASK-484: the provider snapshot-client refactor.
