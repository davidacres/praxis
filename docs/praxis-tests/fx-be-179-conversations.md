# FX-BE-179 supplemental Praxis Test contracts

Frozen source: `00dd78a725701a2ff24e786e7b3ecb26dc0926d5`, refreshed for TASK-476 at `3edbca0772bdc589e42fff742423ee6c24caf1e5`. Nine added Node tests plus one existing store regression, then five TASK-476 contracts (see [TASK-476 additions](#task-476-additions-prx-t111-476)). These supplement the Playwright-only catalog; they are not validated by its generator. IDs use its SHA1(file + newline + title) convention.

Runners: core contracts use `npm run test:core`; adapter contracts use `npm run test:desktop:git`. Registration was verified in the respective package scripts. These commands were not executed in this contract-authoring stage.

## PT-8E485B3B5F

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:15](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L15).
Title: **submit is atomic, isolated and idempotent after acknowledgement loss; conflicting reuse fails**.

**Given** an empty revision-zero conversation and a queued turn with one participant.
**When** submit, replay with reordered payload keys, reuse the command with changed text, replay again and mutate the replay's plan, message and receipt, then mutate the input plan.
**Then** one message, turn and receipt are accepted without mutating the original; replay returns equal state; the conflicting payload throws and leaves accepted state deeply unchanged; mutating a replay result does not reach accepted state; and the accepted instructions remain isolated from the input.

## PT-F7F5BC2C12

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:34](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L34).
Title: **stale revisions, duplicate identities and a second running turn are rejected**.

**Given** an accepted queued turn.
**When** start at a stale revision, start correctly, retry that same running turn, and resubmit with a new command ID but duplicate identities.
**Then** stale revision (leaving accepted state deeply unchanged), active-turn retry and duplicate identity submission throw. Starting a *different* queued turn is covered by PT-13C1D24EAC.

## PT-23E865D1FD

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:44](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L44).
Title: **completion atomically records final reply and context; duplicate and fenced attempts cannot complete**.

**Given** a running turn and one prepared attempt.
**When** complete before dispatch, reserve another live attempt, complete with stale epochs, complete correctly, then complete again.
**Then** invalid and fenced operations throw; successful completion records the reply ID, completes the turn, adds one message and leaves the previous state unchanged; duplicate participant completion throws and leaves completed state deeply unchanged; replaying the original submit after completion returns the completed conversation with one turn, one receipt and revision 5.

## PT-C84E1A276D

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:69](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L69).
Title: **payload canonicalization rejects non-JSON values**.

**Given** payloads containing undefined or NaN.
**When** compute command payload digests.
**Then** both payloads throw a JSON validation error.

## PT-5D662AA252

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:14](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L14).
Title: **two windows and two chats retain concurrent accepted mutations and isolate returned objects**.

**Given** two repositories and stores sharing one temporary profile file.
**When** create two chats concurrently, rename both and save a message concurrently, then mutate a returned snapshot.
**Then** both names and the message survive; changing the returned array does not affect the other repository; snapshot revision is five.

## PT-F820CEA7FB

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:27](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L27).
Title: **pre-rename failure preserves committed bytes and rejects acknowledgement; next mutation uses old state**.

**Given** one committed chat and its original file bytes.
**When** inject rename failure, attempt a rename, restore rename and rename again.
**Then** failed write rejects, original bytes and title remain, temporary files are cleaned, and the later rename succeeds.

## PT-C7DEB31799

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:37](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L37).
Title: **post-rename failure halts writes until receipt reconciliation**.

**Given** one committed chat on a non-Windows platform.
**When** fail directory open after rename, attempt another write, reconcile the reloaded title and write again.
**Then** the first and next writes reject with commit-uncertain errors; reconciliation sees the renamed title and allows a later write.

## PT-C4174FDDA7

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:52](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L52).
Title: **corrupt and unsupported files fail visibly without replacing data; legacy data remains readable**.

**Given** a temporary profile containing each malformed or unsupported fixture, followed by an empty legacy snapshot.
**When** construct repositories and attempt a transaction inserting an invalid legacy chat.
**Then** bad files throw storage errors without byte changes; the empty legacy file loads, the invalid transaction rejects and legacy bytes remain unchanged.

## PT-A2B09A999F

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:65](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L65).
Title: **durable submit and completion commit together and replay returns the original turn**.

**Given** an empty durable conversation in a temporary repository.
**When** submit concurrently twice, start and dispatch one attempt, fail completion rename, then retry completion and read from a new repository.
**Then** one user message and the original turn receipt remain; failed completion preserves prior bytes; retry reloads two messages, a completed attempt and its context digest.

## PT-BC77C20B69

Automation: **node:test**, [packages/core/src/ai/assistant/assistantEngine.test.ts:93](../../packages/core/src/ai/assistant/assistantEngine.test.ts#L93).
Title: **team chat store persists, titles from the first message, renames and deletes**.

**Given** an in-memory transactional repository and chats for two projects.
**When** save user and QA messages, list one project, rename and remove its chat.
**Then** the title derives from the user message, QA is listed as a persona, project filtering holds, rename is visible and removal empties the project list.

## TASK-476 additions (PRX-T111-476)

Frozen source: `3edbca0772bdc589e42fff742423ee6c24caf1e5`. Runner: `npm run test:core` (core build then `node --test` over `packages/core/out`). The ownership-persistence contract PT-CCDCE2367D, strengthened by this task, lives in [FX-BE-181 contracts](fx-be-181-provider-context.md#pt-ccdce2367d).

## PT-13C1D24EAC

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:124](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L124).
Title: **distinct queued turns cannot run simultaneously**.

**Given** two accepted queued turns (`t`, `t2`) with distinct command, message and sequence identities, and `t` started.
**When** start `t2` at the current revision.
**Then** the start throws an active-turn error and the running conversation is deeply unchanged.

## PT-3685D04B40

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:136](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L136).
Title: **superseded attempts cannot complete even with the current epoch**.

**Given** a running turn whose first attempt `a` was dispatched, then marked failed, and a retry attempt `a2` reserved and dispatched in the same coordinator epoch.
**When** complete superseded attempt `a` with the current epoch and a valid reply.
**Then** completion throws a fenced error and the conversation is deeply unchanged. The fixture sets `a` to failed by direct mutation rather than through a transition.

## PT-0C9BBBAC15

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:149](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L149).
Title: **payload canonicalization rejects sparse arrays at any depth and preserves valid JSON digests**.

**Given** a top-level hole-only array, an array with an interior hole, and an object holding a nested sparse array.
**When** compute command payload digests for each, then for key-reordered equal objects, `[]` and `[null]`.
**Then** every sparse payload throws a JSON/sparse error; key order does not change the digest; `[]` hashes to the pinned SHA-256 of `[]`; `[null]` differs from `[]`.

## PT-9C176941C7

Automation: **node:test**, [packages/core/src/ai/aiSessionManager.test.ts:636](../../packages/core/src/ai/aiSessionManager.test.ts#L636).
Title: **standalone sessions persist without team-chat ownership**.

**Given** a completed session with no team-chat ownership in in-memory storage.
**When** record a standalone runtime update (`agentId`) and reload a fresh manager.
**Then** the session loads and `teamChatExecution` is absent before and after reload.

## PT-9CFDECE31C

Automation: **node:test**, [packages/core/src/ai/aiSessionManager.test.ts:647](../../packages/core/src/ai/aiSessionManager.test.ts#L647).
Title: **provider session identity survives ownership persistence**.

**Given** ownership carrying conversation, turn, participant, attempt, epoch and an optional provider session ID.
**When** store it, mutate the caller's provider session ID and reload a fresh manager.
**Then** the restored ownership deeply equals the original, including `providerSessionId: 'provider-session'`.
