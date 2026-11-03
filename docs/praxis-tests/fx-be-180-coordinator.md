# FX-BE-180 supplemental Praxis Test contracts

Frozen implementation: `e5efa78513beb5f7bc9b7754e44bf86e1c864193`. These eight Node contracts supplement the Playwright-only generated catalog. IDs follow SHA1(file + newline + exact title), truncated to ten uppercase hex digits. The generated validator does not validate supplemental contracts.

Runner: **node:test**. Registered in `packages/core/package.json` under `test` (root `npm run test:core`). Focused execution: `npm run build:core` followed by `node --test packages/core/out/ai/assistant/teamChatCoordinator.test.js`. All fixtures use an in-memory repository and stub execution adapter.

## PT-E6F300480C

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:65](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L65).
Title: **TASK-478 AC1: Two simultaneous sends produce distinct FIFO queued turns, repeated delivery produces one turn**.

**Given** an in-memory conversation and an adapter that returns Done.
**When** submit one command twice, then two different commands concurrently.
**Then** the replay returns the same turn ID; the concurrent results differ; exactly three turns are stored in submission order.

## PT-77195EEA97

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:124](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L124).
Title: **TASK-478 AC2: Selected members answer in dev, qa, security, product, lead order; mention selects only that member; empty roster resolves to lead**.

**Given** a conversation containing all five roles.
**When** select product, lead, dev and qa, then send @qa, then send with an empty selection.
**Then** the adapter records dev, qa, product, lead; the mention records only qa; the empty selection records only lead.

## PT-D5716B75D8

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:188](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L188).
Title: **TASK-478 AC3: Later members see earlier committed replies from their turn; no member sees queued future user messages**.

**Given** an in-memory conversation and an adapter recording supplied messages.
**When** submit a dev/qa turn and immediately queue a second user question.
**Then** dev and qa see the first question and exclude the future question; qa also sees the dev reply.

## PT-C77A052502

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:241](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L241).
Title: **TASK-478 AC4: Changing roster affects subsequent accepted turns only; failures pause the current turn and leave later turns queued**.

**Given** an adapter that initially fails dev.
**When** submit a dev turn and a lead turn, inspect failure, then allow dev and retry.
**Then** the first turn is failed and the second remains queued; after retry both become completed.

## PT-126F6268D2

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:300](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L300).
Title: **TASK-479 AC1: IPC timeout after durable acceptance followed by resubmission returns the original turn ID**.

**Given** an in-memory conversation with a successful adapter.
**When** await submit and submit the identical command again.
**Then** both results contain the same turn ID.

## PT-1A2365951E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:325](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L325).
Title: **TASK-479 AC2: Subscription emits revision updates**.

**Given** a subscriber registered on one in-memory conversation.
**When** submit one lead turn and wait for updates.
**Then** at least three updates arrive; the first is turn_accepted and one is attempt_completed.

## PT-F4C7E562E3

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:352](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L352).
Title: **TASK-479 AC3: Invalid participant, attachment reference, and permission choice are rejected before provider invocation**.

**Given** an adapter that records whether execution was invoked.
**When** submit an unknown participant, an attachment with empty digest/media type, and permissionMode invalid.
**Then** each submission rejects with its matching error and the adapter is never invoked.

## PT-C8CB367EC7

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:405](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L405).
Title: **TASK-479 AC4: Closing/cancelling turn does not corrupt conversation state**.

**Given** an adapter delaying its reply for 200 milliseconds.
**When** submit a lead turn, cancel it, and wait 250 milliseconds.
**Then** the stored turn state is cancelled.
