# FX-BE-180 supplemental Praxis Test contracts

Frozen implementation: `c7199a3d40b2835ef8057b710e3b13cf36f2989a`, refreshed for TASK-478 at `6e296acb64d40d4e279f26d99f0df33339498655`. These ten Node contracts supplement the Playwright-only generated catalog. IDs follow SHA1(file + newline + exact title), truncated to ten uppercase hex digits. The generated validator does not validate supplemental contracts.

Runners: **node:test**. Core contracts are registered in `packages/core/package.json` under `test` (root `npm run test:core`); focused execution is `npm run build:core` followed by `node --test packages/core/out/ai/assistant/teamChatCoordinator.test.js`. Core fixtures use an in-memory repository (optionally `deferred`, which queues each mutation behind an await like the desktop file repository) and a stub execution adapter. The one main contract ([PT-E64E01B995](#pt-e64e01b995)) is registered in `apps/praxis-desktop/main/package.json` under `test:git` (root `npm run test:desktop:git`) and uses a temporary profile with the real file repository.

## PT-E6F300480C

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:98](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L98).
Title: **TASK-478 AC1: Two simultaneous sends produce distinct FIFO queued turns, repeated delivery produces one turn**.

**Given** a deferred in-memory repository, so concurrent submits race on the acceptance snapshot, and an adapter that returns Done.
**When** submit command A, command B and command A again concurrently, then redeliver A once more after they settle.
**Then** A and B get distinct turn IDs; both redeliveries return A's turn ID; exactly two turns and one receipt per command are stored; user messages carry sequences 1 and 2 and turns carry accepted sequences 1 and 2; `turn_accepted` is announced once for A; announcement order and dispatch order both match the stored FIFO turn order.

## PT-77195EEA97

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:150](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L150).
Title: **TASK-478 AC2: Selected members answer in dev, qa, security, product, lead order; mention selects only that member; empty roster resolves to lead**.

**Given** a conversation containing all five roles and an adapter that holds the first member until released.
**When** select all five roles in scrambled order (lead, product, security, qa, dev), then send `@qa` with dev/qa/lead selected, then send with an empty selection.
**Then** while the first member is held, the repository already holds the plan in dev, qa, security, product, lead order (plan committed before dispatch); members answer in that order; the mention turn's plan and replies are only qa; the empty-selection turn's plan and replies are only lead.

## PT-D5716B75D8

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:218](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L218).
Title: **TASK-478 AC3: Later members see earlier committed replies from their turn; no member sees queued future user messages**.

**Given** an adapter recording the messages each member receives and holding turn 1's dev reply.
**When** submit a dev/qa turn 1; while dev is held, submit a security turn 2; then release dev.
**Then** turn 2's receipt is durable and the turn is queued before turn 1 finishes; dev and qa (qa prepared after turn 2 was accepted) see turn 1's question but not turn 2's; qa sees dev's reply; turn 2's security member sees both turn 1 replies and its own question.

## PT-C77A052502

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:282](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L282).
Title: **TASK-478 AC4: Changing roster affects subsequent accepted turns only; failures pause the current turn and leave later turns queued**.

**Given** a `captureRuntimeOptions` hook that stamps the current default model (`model-v1`) and an adapter holding turn 1's dev reply.
**When** accept dev/qa turns 1 and 2, then change the default model to `model-v2` and edit the stored qa participant's instructions, accept a lead-only turn 3, and release.
**Then** turns 1 and 2 keep `model-v1` and the original qa instructions in their stored plans and at execution; turn 3's plan carries `model-v2` and only lead; execution order is 1:dev, 1:qa, 2:dev, 2:qa, 3:lead. The failure half of this title is covered by [PT-5F483231F9](#pt-5f483231f9), not by this test.

## PT-5F483231F9

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:347](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L347).
Title: **TASK-478 AC4: A failure pauses the current turn and leaves later turns queued until retried**.

**Given** an adapter whose dev member throws until allowed.
**When** submit a dev turn and a lead turn, wait for the failure plus a short settle, then allow dev and retry the dev participant.
**Then** the dev turn is failed, the lead turn stays queued and was never dispatched; after retry both complete, with dispatch order failing turn, failing turn (retry), queued turn.

## PT-126F6268D2

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:395](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L395).
Title: **TASK-479 AC1: IPC timeout after durable acceptance followed by resubmission returns the original turn ID**.

**Given** an in-memory conversation with a successful adapter.
**When** await submit and submit the identical command again.
**Then** both results contain the same turn ID.

## PT-1A2365951E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:420](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L420).
Title: **TASK-479 AC2: Subscription emits revision updates**.

**Given** a subscriber registered on one in-memory conversation.
**When** submit one lead turn and wait for updates.
**Then** at least three updates arrive; the first is turn_accepted and one is attempt_completed.

## PT-F4C7E562E3

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:447](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L447).
Title: **TASK-479 AC3: Invalid participant, attachment reference, and permission choice are rejected before provider invocation**.

**Given** an adapter that records whether execution was invoked.
**When** submit an unknown participant, an attachment with empty digest/media type, and permissionMode invalid.
**Then** each submission rejects with its matching error and the adapter is never invoked.

## PT-91F0C03FD3

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:500](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L500).
Title: **TASK-479 AC4: cancellation preserves unresolved execution as unknown**.

Replaces the retired **PT-C8CB367EC7** ("TASK-479 AC4: Closing/cancelling turn does not corrupt conversation state"); the test was renamed before TASK-478, so the old id no longer matches any source.

**Given** an adapter delaying its reply for 200 milliseconds.
**When** submit a lead turn, cancel it, and wait 250 milliseconds.
**Then** the stored turn state is either `cancelled` or `outcome_unknown`. The test accepts both, so it does not pin which one an in-flight cancellation produces.

## PT-E64E01B995

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts:235](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L235).
Title: **simultaneous sends to one chat on the file repository produce distinct FIFO turns and one turn per repeated command**.

TASK-478 regression for the real desktop file repository: on the previous code, the second concurrent send took the same sequence and was rejected as "Invalid accepted turn."

**Given** durable main services over chat `x` in a temporary profile, backed by the real file repository.
**When** submit commands `x1`, `x2` and `x1` again concurrently at the same expected revision, and wait for both turns to complete.
**Then** `x1` and `x2` get distinct turn IDs and the repeat returns `x1`'s; the file holds receipts `[x1, x2]` and turns in that order; message sequences are contiguous from 1; provider calls follow acceptance order; `turn_accepted` is emitted once for `x1`.
