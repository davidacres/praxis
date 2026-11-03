# FX-BE-179 supplemental Praxis Test contracts

Frozen source: `00dd78a725701a2ff24e786e7b3ecb26dc0926d5`. Nine added Node tests plus one existing store regression. These supplement the Playwright-only catalog; they are not validated by its generator. IDs use its SHA1(file + newline + title) convention.

Runners: core contracts use `npm run test:core`; adapter contracts use `npm run test:desktop:git`. Registration was verified in the respective package scripts. These commands were not executed in this contract-authoring stage.

## PT-8E485B3B5F

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:15](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L15).
Title: **submit is atomic, isolated and idempotent after acknowledgement loss; conflicting reuse fails**.

**Given** an empty revision-zero conversation and a queued turn with one participant.
**When** submit, replay with reordered payload keys, reuse the command with changed text, and mutate the input plan.
**Then** one message, turn and receipt are accepted without mutating the original; replay returns equal state, conflicting payload throws, and the accepted instructions remain isolated.

## PT-F7F5BC2C12

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:27](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L27).
Title: **stale revisions, duplicate identities and a second running turn are rejected**.

**Given** an accepted queued turn.
**When** start at a stale revision, start correctly, retry that same running turn, and resubmit with a new command ID but duplicate identities.
**Then** stale revision, active-turn retry and duplicate identity submission throw.

## PT-23E865D1FD

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:35](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L35).
Title: **completion atomically records final reply and context; duplicate and fenced attempts cannot complete**.

**Given** a running turn and one prepared attempt.
**When** complete before dispatch, reserve another live attempt, complete with stale epochs, complete correctly, then complete again.
**Then** invalid and fenced operations throw; successful completion records the reply ID, completes the turn, adds one message and leaves the previous state unchanged; duplicate completion throws.

## PT-C84E1A276D

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:52](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L52).
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
