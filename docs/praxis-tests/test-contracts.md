# test-contracts

Ticket: PRX-S111-180 / FX-BE-180. Stage: WF-C2BF498E-test-contracts.
Frozen implementation: `c7199a3d40b2835ef8057b710e3b13cf36f2989a`.

## Result and inventory

The working tree was clean before this catalog stage. Analysis inspected the generator, existing catalog and contracts, supplied change-diff, all eight coordinator test bodies, current renderer/main call sites and repair commit `2be4ebe2`. No code-intelligence tools are exposed in this session, so current checkout text is authoritative.

The deterministic validator passes with **782 generated Playwright contracts across 171 source files**, zero duplicate IDs or source/title links, and no stale identities or moved-line warnings. This iteration clarifies the session-details scroll contract without changing its ID. The coordinator suite contributes **8 node:test registrations**, explicitly registered in the core test script, with eight supplemental contracts. The scoped union is **790 entries: 782 generated Playwright + 8 coordinator Node contracts**. This is not the complete monorepo suite or expanded runtime count; other Node suites and supplemental documents are excluded.
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

- Renderer handoff is not established: [AssistantProvider.tsx:181](../../apps/praxis-desktop/renderer/src/assistant/AssistantProvider.tsx#L181) still saves whole transcripts and lines 246/258 invoke the legacy turn API. The current renderer repair changes session-detail scrolling only; it does not migrate AssistantProvider. Thus these tests do not prove UI sends reach the main coordinator or work continues after window closure.
- The [main execution adapter](../../apps/praxis-desktop/main/src/main/assistantIpc.ts#L56) reads current settings at execution and builds its prompt from the latest user text. It does not forward the tested messages array as full history or use the accepted plan's runtime options and participant instructions. Stub-level context/default guarantees cannot be claimed for that integration.
- No new automated assertion covers the [durable whole-transcript save guard](../../packages/core/src/ai/assistant/teamChatStore.ts#L60), main singleton ownership, preload routing/filtering, durable chat CRUD/list integration, or resolveAttempt branches. Their source presence is not coverage.
- Fixed sleeps of 50–250 ms underpin these tests. Passing this run does not establish deterministic completion under slower environments. File repository behavior has predecessor tests, but this new coordinator suite does not integrate that adapter.

## Catalog findings

The prior report pointed at `e5efa785` and is stale for this snapshot; the supplemental snapshot reference is refreshed as well. Generated identities and source locations already match the current checkout. No duplicate IDs, duplicate source/title links or stale generated links were found.

The generator inventories direct static `test(...)` calls in desktop e2e only. Dynamic template titles and modified calls such as `test.only(...)` are omitted, and all entries are labelled functional regardless of actual project. Generic generated Then prose is shape-checked, not semantically validated. Supplemental Node contracts are outside its validator; their exact titles, locations and IDs were independently checked. No claim is made that all 782 generated contracts were semantically reviewed or that 790 represents the complete automated suite. IDs use file and title hashes: line changes preserve identity, but file/title changes generate new IDs.

## Iteration 3 QA disposition

The supplied latest QA result is **59 passed, 1 failed out of 60**: [session details, line 980](../../apps/praxis-desktop/main/e2e/easymode.spec.ts#L980), with an Object.is equality failure. The full failure log is not available among the supplied local artifacts, so the exact failing assertion cannot be confirmed from the summary alone.

Commit `2be4ebe2`, included in this snapshot, sets the session body scrollTop to scrollHeight on mount in AgentDetailsPage.tsx:132 and extends the bottom-boundary poll from 20 to 40 seconds at easymode.spec.ts:1116. This targets the suspected scroll timing failure. The curated contract now states the actual bound checked: the last reply bottom is at or above the body bottom plus one pixel within 40 seconds. This does not prove the whole reply is visible, that it is above the body's top, or that mount scrolling alone fixes the failure. Runtime resolution remains unverified; increasing a timeout is not passing evidence.

Historical iteration 1 reported 57/60 with three failures; iteration 2 reported 59/60. The earlier report named automation row actions, session details and long-list divider focus. Divider focus was repaired in `e5efa785`/`8f9d1248`; no fresh runtime claim is made for it or the unchanged row-actions test. The only latest named failure is session details. This catalog stage documents the existing repair and assertion boundary; it makes no product or test-source changes.

## Current changes and verification

Updated this required test-contracts report, the supplemental snapshot reference and the curated session-details flow. Stable IDs, test sources, runtime code and workflow definitions are unchanged.

- npm run test:praxis-contracts before and after editing: exit 0; 782 linked Playwright tests, no warnings.
- Independent inventory: 782 entries across 171 files, 782 unique IDs and source/title links; eight supplemental coordinator titles, source lines and hash IDs checked.
- git diff --check: passed.

No desktop e2e, broad runtime suite or visual verification was performed in this documentation-only stage. No screenshot was captured. Catalog validation does not establish runtime QA or release readiness. No other workflow stage was advanced or approved.
