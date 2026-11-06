---
**Status:** ✅ Complete
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-477
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-179
---

# TASK-477: Implement serialized durable conversation transactions

Parent: [FX-BE-179](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Evolve TeamChatStore behind a transaction repository contract; add a chat-specific desktop file adapter with clone-before-commit state and explicit corruption errors. Keep the existing profile-local team-chats.json storage location and avoid changing unrelated JsonKeyValueStore callers.

## Dependencies

TASK-476

## Acceptance criteria

- Concurrent mutations across two chats and two windows retain every accepted change; one profile-wide writer serializes the shared snapshot.
- Failure before rename leaves the old committed snapshot readable and emits no accepted acknowledgement; ambiguous failures after rename stop dispatch and require reload/reconciliation.
- Submit commits user message, immutable response plan and command receipt together; completion commits final reply, attempt outcome and context boundary together.
- Malformed existing JSON is surfaced as a recoverable storage error and is never replaced with an empty chat list.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Validation evidence (2026-11-05)

Base `105d79b3` (all predecessors through TASK-476 present). Result: the commit that adds this section. Temporary profiles only (`mkdtemp` per test; e2e `launchTestApp` user-data dirs).

| Criterion | Assertion (file › test) | Result |
| --- | --- | --- |
| Two chats × two windows, one profile-wide writer | `teamChatRepository.test.ts` › *two windows and two chats retain concurrent accepted mutations…*, *two repository instances over one file are refused or serialized*; `teamChatIpcRecovery.test.ts` › *two windows over two chats retain every accepted submit* | pass |
| Pre-rename failure keeps old snapshot, no acknowledgement | `teamChatRepository.test.ts` › *pre-rename failure preserves committed bytes…*, *ENOSPC and EACCES on temp write or fsync…* (6 cases); `teamChatIpcRecovery.test.ts` › *a pre-rename submit failure emits no acceptance and invokes no provider; the same command then succeeds once* | pass |
| Ambiguous post-rename failure stops dispatch, requires reconciliation | `teamChatRepository.test.ts` › *post-rename failure halts writes until receipt reconciliation*; `teamChatIpcRecovery.test.ts` › *an uncertain submit commit is not acknowledged; reconciliation returns the original turn for the same command id*, *an uncertain commit while reserving an attempt halts dispatch and reports reload* | pass |
| Submit and completion commit atomically | `teamChatRepository.test.ts` › *durable submit and completion commit together and replay returns the original turn* (submit fault commits none of message/plan/receipt; completion fault commits none of reply/outcome/participant progress/binding coverage; success lands all in one revision) | pass |
| Malformed JSON is a recoverable error, never an empty list | `teamChatRepository.test.ts` › *corrupt and unsupported files fail visibly…*, *a truncated file, invalid JSON, wrong schemaVersion and a duplicate conversation id…*; `durableTeamChat.spec.ts` › *a malformed team-chat file is shown as a recoverable error and never replaced* | pass |

Fixes found while validating:

- `teamChatCoordinator.ts` swallowed every error from the attempt-reservation commit (`catch { break; }`), so a storage fault there stalled the turn at `running` with no report. Only a transition rejection now ends the pass quietly; storage faults halt the loop and report "Restart Praxis to recover this team chat." The reservation test fails against the old code (`Timed out waiting for halt report`).
- The sidebar read team chats with `listChats(...).catch(() => [])`, so a malformed file showed as no chats. `useProjectsTeamChatsState` now keeps the last list and shows `team-chat-storage-error` with Retry.

Commands executed:

```sh
npm run build:core && npm run test:core                      # 1945 pass, 0 fail
npm run check-types                                          # clean
npm run build:renderer && npm run desktop:copy-renderer && npm run build:desktop
npm run test:renderer                                        # 34 pass, 0 fail
npm run test:git --workspace=@praxis/desktop-main            # 146 pass, 0 fail
cd apps/praxis-desktop/main && npx playwright test durableTeamChat.spec.ts assistant.spec.ts --project=functional   # 40 passed
```

10,000-message size fixture: `team-chats.json` 4,335,274 bytes; large-chat commits 45, 100, 151, 199, 247 ms queued behind concurrent writes.

Artifact: `.praxis/session-artifacts/task-477-corrupt-storage.png` (Easy Mode sidebar alert plus the assistant refusal). The Classic `Sidebar` component is not mounted by `App.tsx`, so Easy Mode is the only live surface; the Classic recency feed carries the same alert for parity.

Not run (scheduled-run policy): full `test:desktop` and `test:desktop:themes` suites, real-provider checks, manual theme pass.

## Description


## Comments


**PRX-T111-477** — 2026-11-05T15:46:35.996Z
**Workflow run succeeded: Governed delivery — TASK-477: Implement serialized durable conversation transactions**

Status: Succeeded · Duration: 1h 25m

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
