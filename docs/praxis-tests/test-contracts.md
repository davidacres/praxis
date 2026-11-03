# test-contracts

Ticket: PRX-S111-179 / FX-BE-179. Stage: WF-F71C404F-test-contracts.
Frozen implementation: `00dd78a725701a2ff24e786e7b3ecb26dc0926d5`.

## Result and inventory

The checkout HEAD equals the frozen implementation. Before edits, tracked source and catalog files matched that snapshot; the supplied `.praxis/change-diff.md` was already modified and was left untouched. No live-main-checkout index or code-intelligence tools were available, so analysis used local frozen source, its references, and the supplied diff.

The deterministic validator passes: **782 Playwright contracts across 171 source files**. Independent inventory inspection found **zero duplicate generated IDs**. No stale identities, missing generated entries or moved-line warnings were reported. The implementation had already refreshed `catalog.json` and `index.md`; neither required another edit.

This story adds **9 node:test registrations**: four pure-transition tests and five file-repository tests. It also updates the fixture of one existing store regression. This stage authored **10 supplemental contracts**, each with stable generated ID, runner, exact file, line, title and Given/When/Then prose. Thus the documented union here is **792 entries: 782 generated Playwright + 10 supplemental Node contracts**. This is not a complete monorepo runtime test count: other Node suites and dynamic Playwright cases are outside this count. On Windows one of the five repository tests skips.

Coverage: [generated contracts](catalog.json), [automation index](index.md), [ten supplemental contracts](fx-be-179-conversations.md), [deterministic validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs).

## Acceptance evidence

| Requirement | Exact automation coverage | Limits |
| --- | --- | --- |
| Identical submit replay and conflicting payload rejection | [transition tests, line 15](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L15); [repository integration, line 65](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L65) | Lost acknowledgement is simulated by calling submit again, not by interrupting IPC. Integration checks message count and original receipt turn ID. |
| Stale revision and active-turn rejection | [transition tests, line 27](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L27) | Active-turn assertion starts the same running turn again; no distinct second queued turn is constructed. |
| Duplicate completion and epoch fencing | [transition tests, line 35](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L35) | One participant and one attempt; duplicate completion also encounters completed turn state. Does not isolate every rejection predicate. |
| Explicit execution ownership | [ownership type](../../packages/core/src/ai/agentTypes.ts#L468), [conversation types](../../packages/core/src/ai/assistant/assistantTypes.ts#L96) | Separate named fields are present, all typed as strings; no ownership-specific automated assertion or negative compile test. No proof that runtime associations avoid title/event parsing. |
| Concurrent changes across chats/windows | [repository tests, line 14](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L14) | Two adapter/store instances in one Node process, two chats; no Electron windows or IPC exercised. Writer coordination is process-local. |
| Failure before rename preserves commit | [repository tests, line 27](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L27), [completion rollback, line 65](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L65) | Injected rename exceptions, not process-kill or power-loss experiments. |
| Uncertain commit blocks until reconciliation | [repository tests, line 37](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L37) | Non-Windows only; callback checks title rather than command receipts. Final rename is awaited but not independently reloaded/asserted. |
| Corruption errors and legacy compatibility | [repository tests, line 52](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L52) | Four bad fixtures and empty legacy snapshot; populated legacy migration and broad malformed nested records are not tested here. |
| Existing store behavior | [existing regression, line 93](../../packages/core/src/ai/assistant/assistantEngine.test.ts#L93) | In-memory repository verifies naming, filtering, personas, rename and delete; title's “persists” does not prove disk/restart persistence. |

## Stale and ambiguous contracts

1. The previous `test-contracts.md` described TASK-502 at snapshot `202bb056` and 766 generated entries. This report replaces that stale stage result; historical ticket-specific note files remain untouched.
2. Generated inventory is Playwright-only, despite the broader catalog goal. Nine new tests would have no structured contract without the supplemental document. The existing validator checks generated inventory shape and identity, not supplemental prose or actual assertion strength.
3. The generator skips dynamic template titles and recognizes only direct `test(...)` calls; modified calls such as `test.only(...)` are not inventoried. It assigns every entry `project: functional`, including tests run by other projects. Therefore 782 is the exact supported static inventory count, not the full suite's expanded runtime count.
4. Generic generated Then prose says assertions pass rather than naming observable results. Validation cannot establish that this prose accurately explains each journey. No claim of complete semantic review of all 782 contracts is made.
5. Story test titles overstate some proof: “two windows” means stores in one process; “second running turn” retries the same turn; “context” completion checks a digest and result identity rather than every context field. Supplemental prose deliberately states only exercised assertions.
6. No new UI, actual process restart, provider/session association, cross-process writer coordination, or standalone-session ownership regression is established by these nine tests. These are coverage boundaries, not claimed implementation failures; migration and runtime activation are separate stories per source comments.

## Changes and verification

Only `docs/praxis-tests/fx-be-179-conversations.md` (new structured contracts) and this report were authored. No runtime code, workflow definitions, generated IDs or automation files changed.

- `npm run test:praxis-contracts` before editing: exit 0, `Praxis Tests: 782 Playwright tests catalogued and linked.` No warnings.
- Catalog inspection: 782 entries, 171 files, zero duplicate IDs.
- Supplemental source/title/line/hash/link checks: ten contracts match frozen automation; nine new and one existing registration. All IDs are unique and do not collide with the generated inventory.
- `npm run test:praxis-contracts` after editing: exit 0, same 782 count, no warnings.
- `git diff --check -- docs/praxis-tests/test-contracts.md`: passed. Whole-tree `git diff --check` reports pre-existing trailing whitespace only in the supplied `.praxis/change-diff.md`; that input was not edited.

Runtime suites were not executed in this documentation-only stage; inventory validation is not runtime QA. No UI was changed, no visual verification was performed, and no screenshot was captured. No other workflow stage was advanced or approved.
