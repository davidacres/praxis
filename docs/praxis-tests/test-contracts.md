# test-contracts

Ticket: PRX-S111-180 / FX-BE-180. Stage: WF-C2BF498E-test-contracts.
Frozen implementation: `bc1fff5e6f6429c9a1b6e9f10522951e108fceba`.

## Result and inventory

HEAD equals the frozen implementation; the working tree was clean before this stage. Analysis inspected the supplied `.praxis/change-diff.md`, frozen coordinator, test fixtures/assertions, core test registration, store guard, main singleton/IPC, preload and renderer call sites. Code intelligence returned no coordinator symbol from its partial index, so current text was read from this frozen checkout.

The deterministic validator passes with **782 generated Playwright contracts across 171 source files**, zero duplicate IDs, and no stale identities or moved-line warnings. Generated files already match the snapshot and remain unchanged. This implementation adds **8 node:test registrations** in one coordinator test file, registered in the core test script. This stage adds eight exact source-linked structured English contracts. The scoped inventory union is **790 entries: 782 generated Playwright + 8 coordinator Node contracts**. This is not the complete monorepo suite count or expanded runtime count; existing supplemental documents and other Node suites are excluded from this scoped union.

Coverage links: [generated catalog](catalog.json), [automation index](index.md), [eight coordinator contracts](fx-be-180-coordinator.md), [predecessor storage/transition contracts](fx-be-179-conversations.md), [validator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs).

## Acceptance coverage and ambiguities

All eight new tests use a cloned in-memory repository and stub execution adapter, not file storage, Electron IPC or real providers.

| Requirement | Automation | Assertion boundary / finding |
| --- | --- | --- |
| FIFO and command replay | [TASK-478 AC1, line 65](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L65) | Checks stored turn order, distinct concurrent IDs and sequential replay identity. The recorded executedTurns array is never asserted; simultaneous duplicate delivery and maximum active execution are not proved. |
| Role order, mention, fallback | [TASK-478 AC2, line 124](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L124) | Asserts dev, qa, product, lead; security exists in the fixture but is not selected. Tests @qa only and empty selection on a populated conversation, not a truly empty participant roster. |
| Context visibility | [TASK-478 AC3, line 188](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L188) | Checks messages supplied to the stub: first question visible, future question excluded, earlier dev reply visible to qa. Does not establish actual provider prompt content. |
| Frozen roster/defaults; failure pauses queue | [TASK-478 AC4, line 241](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L241) | Asserts failed/queued states and both completed after retry. Despite its title, it never mutates roster or runtime defaults and does not verify plan immutability. |
| Timeout and resubmission | [TASK-479 AC1, line 300](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L300) | Calls submit twice after awaiting success; no IPC timeout, lost acknowledgement, restart or disk durability is induced. |
| Snapshot and newer revisions | [TASK-479 AC2, line 325](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L325) | Checks update count and event types only. No revision values/order, snapshot hydration, stale-event rejection, unsubscribe or new window is exercised. The supplied ticket's final acceptance bullet ends at “newer rev”; no further requirement is inferred. |
| Invalid commands | [TASK-479 AC3, line 352](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L352) | Checks one unknown participant, one empty attachment reference and literal permissionMode invalid; no provider invocation. Does not prove a complete permission allowlist or attachment existence validation. |
| Cancellation/window closure | [TASK-479 AC4, line 405](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L405) | Checks cancelled turn state after waiting beyond a delayed reply. No window closes; no assertions on message/attempt integrity or queued successor progress. |

## Uncovered integration contracts

- Renderer handoff is not established: [AssistantProvider.tsx:181](../../apps/praxis-desktop/renderer/src/assistant/AssistantProvider.tsx#L181) still saves whole transcripts and lines 246/258 invoke the legacy turn API. No renderer source changed in the frozen implementation. Thus these tests do not prove UI sends reach the main coordinator or work continues after window closure.
- The [main execution adapter](../../apps/praxis-desktop/main/src/main/assistantIpc.ts#L56) reads current settings at execution and builds its prompt from the latest user text. It does not forward the tested messages array as full history or use the accepted plan's runtime options and participant instructions. Stub-level context/default guarantees cannot be claimed for that integration.
- No new automated assertion covers the [durable whole-transcript save guard](../../packages/core/src/ai/assistant/teamChatStore.ts#L60), main singleton ownership, preload routing/filtering, durable chat CRUD/list integration, or resolveAttempt branches. Their source presence is not coverage.
- Fixed sleeps of 50–250 ms underpin these tests. Passing this run does not establish deterministic completion under slower environments. File repository behavior has predecessor tests, but this new coordinator suite does not integrate that adapter.

## Catalog findings

The previous report described FX-BE-179 at a different frozen revision; this report replaces that stale stage result. Historical ticket-specific contracts remain untouched. No duplicate or stale generated links were found.

The generator inventories direct static `test(...)` calls in desktop e2e only. Dynamic template titles and modified calls such as `test.only(...)` are omitted, and all entries are labelled functional regardless of actual project. Generic generated Then prose is shape-checked, not semantically validated. Supplemental Node contracts are outside its validator; their exact titles, locations and IDs were independently checked. No claim is made that all 782 generated contracts were semantically reviewed or that 790 represents the complete automated suite.

## Changes and verification

Only this report and `fx-be-180-coordinator.md` were authored. Runtime source, test source, generated identities and workflow definitions remain unchanged.

- `npm run test:praxis-contracts` before and after authoring: exit 0; 782 linked Playwright tests, no warnings.
- `npm run build:core`: exit 0.
- `node --test packages/core/out/ai/assistant/teamChatCoordinator.test.js`: exit 0; **8 passed, 0 failed, 0 skipped**.
- Independent supplemental source/title/line/SHA1 and duplicate-ID checks: passed for all eight contracts.
- `git diff --check`: passed.

No broad runtime suite or desktop e2e was run in this documentation-only stage. No UI changed, no visual verification was performed, and no screenshot was captured. Catalog validation and focused Node proof do not establish release readiness. No other workflow stage was advanced or approved.
