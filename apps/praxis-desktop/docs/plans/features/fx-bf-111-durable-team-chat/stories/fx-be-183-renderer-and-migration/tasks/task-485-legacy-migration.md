---
**Status:** ✅ Complete
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-485
type: Task
status: Done
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-183
---

# TASK-485: Migrate existing chats and stage the durable-writer cutover

Parent: [FX-BE-183](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Implement the migration and activation protocol in the feature design. Preserve legacy transcripts and session records, convert only provable associations and retain narrow legacy navigation classification. Update renderer area notes and desktop feature parity documentation.

## Dependencies

TASK-484

## Acceptance criteria

- A copied legacy fixture preserves chat/message IDs, titles, order, timestamps, roles, actions, choices, errors and project ownership; migration rerun changes nothing.
- Provable session associations import typed links only after validation; ambiguous instruction-title matches never merge conversations or delete records.
- Migration failure leaves the original store and backup intact, with durable dispatch disabled; activation blocks legacy transcript writes.
- An active legacy execution causes cutover to wait for quiescence; no chat is written by old and new coordinators at once.
- A fixture with an expired legacy session continues using reconstructed context and still appears exactly once in navigation.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Evidence (2026-11-06, implementation stage)

Typed legacy runtime links: `LegacyRuntimeLink` / `LegacyRuntimeSessionEvidence` (core `assistantTypes.ts`), `classifyLegacyRuntimeSession` + `migrateTeamChats(source, evidence)` (`teamChatMigration.ts`), decode validation and `activate(evidence)` (`teamChatRepository.ts`), evidence read after quiescence (`teamChatServices.ts` `legacyRuntimeEvidence`, `assistantIpc.ts` `collectLegacyRuntimeEvidence`). An earlier report that called a provable legacy association untestable was wrong: pre-durable keys were `ASSISTANT-<chatId>-<persona>-<digest>`, and a transcript checkpoint named the persona's reply. **TASK-487** must correct the G5/AC7 wording in `docs/praxis-tests/fx-be-184-verification-report.md`.

| AC | Assertions | Command | Result |
| --- | --- | --- | --- |
| 1 | `a copied legacy fixture survives activation field-for-field and a rerun changes no byte` (`teamChatActivation.test.ts`, fixture `teamChatLegacyFixture.ts`) | `npm run test:desktop:git` | pass |
| 2 | `a provable legacy runtime session imports one typed link and no binding`; `an instruction or title match without a chat-id key is a diagnostic, never a link or merge`; `a checkpoint that names another chat's message, a wrong-role message, or none, is not proof`; `evidence never changes an already-activated snapshot` (`teamChatMigration.test.ts`); `legacy runtime links and diagnostics are validated on load` (`teamChatRepository.test.ts`) | `npm run test:core`, `npm run test:desktop:git` | pass |
| 3 | `a migration validation failure (identity collision) leaves source and an existing valid backup byte-identical and refuses submitTurn`; `saveChat is rejected after activation even from a stale caller` (`teamChatIpcRecovery.test.ts`), plus existing `activation failure leaves durable dispatch disabled` | `npm run test:desktop:git` | pass |
| 4 | `an in-flight legacy save and turn hold cutover; their writes land in the backup source and submitTurn accepts only afterwards` (`teamChatIpcRecovery.test.ts`) | `npm run test:desktop:git` | pass |
| 5 | `an expired legacy runtime session is linked, reconstructed and listed once` (`e2e/durableTeamChat.spec.ts`) | `npx playwright test e2e/durableTeamChat.spec.ts e2e/assistant.spec.ts --project=functional` | 42 passed |

Totals: `npm run test:core` 1973 passed, 0 failed (2 skipped); `npm run test:desktop:git` 167/167; `npm run test:renderer` 93/93; `npm run check-types` clean. Visual check: `.praxis/session-artifacts/task-485-migrated-chat.png` shows one migrated team-chat row in the Easy Mode sidebar, no `ASSISTANT-` session row, and the reconstructed transcript in the panel. The classic project tree was removed in f977690f, so Easy Mode is the only sidebar to check. Not run (scheduled-run policy): the full functional and theme e2e suites, and the live-provider and real-CLI proofs.

## Description


## Comments


**PRX-T111-485** — 2026-11-06T10:44:22.549Z
**Workflow run succeeded: Governed delivery — TASK-485: Migrate existing chats and stage the durable-writer cutover**

Status: Succeeded · Duration: 19m 28s

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
