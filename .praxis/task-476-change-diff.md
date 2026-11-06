# change-diff — PRX-T111-476 / TASK-476

Implements the supplied plan for FX-BE-179. Existing schema-v2 identity contracts, originating/observing epochs, optional standalone ownership, public exports, and explicit test registrations already satisfy the model and are preserved. No dependencies or UI changes.

## Changes

- Reject sparse arrays, including nested holes, before hashing command payloads; valid JSON canonical encoding is unchanged.
- Strengthen replay, post-completion replay, conflict isolation, stale-write isolation, distinct queued-turn exclusion, duplicate completion, superseded-attempt fencing, and snapshot/accepted-plan isolation evidence.
- Verify every ownership identity survives persistence, provider session identity is optional, standalone records remain valid, and caller mutation cannot rewrite ownership.

## Verification

All commands executed from the worktree root:

| Command | Result |
| --- | --- |
| `npm run build:core` | Passed after correcting the two new-test errors below |
| `node --test packages/core/out/ai/assistant/teamChatTransitions.test.js packages/core/out/ai/aiSessionManager.test.js` | 48 passed, 0 failed, 0 skipped |
| `npm run check-types` | Passed across all configured workspaces |
| `npm run check-core-imports --workspace=@praxis/desktop-renderer` | Passed |
| `git diff --check` | Passed |

Initial failure evidence: core compilation reported TS2339 at aiSessionManager.test.ts:632 (assert.deepEqual narrowed ownership to the expected object without providerSessionId) and TS2353 at :640 (provider is not an updateAgentRuntime field). Moved the optional provider assertion before narrowing and used the supported agentId field to exercise standalone persistence. Rebuilt and reran all focused tests successfully. No product failure remained.

Local command outputs: `/tmp/task-476-build.log`, `/tmp/task-476-tests.log`, `/tmp/task-476-types.log`, `/tmp/task-476-imports.log`. These are temporary diagnostics; the durable result and assertion inventory are recorded here.

Full functional/theme suites, live API proofs, manual theme passes, and unchanged dependency test files were not run under the scheduled-run policy. No visual behavior changed, so manual UI inspection and screenshots were unnecessary. No tracker comments, ticket transitions, or workflow changes were made; this artifact is the workflow-managed task/story/issue handoff.

## Assertion inventory (both changed suites)

### `packages/core/src/ai/assistant/teamChatTransitions.test.ts`

- submit is atomic, isolated and idempotent after acknowledgement loss; conflicting reuse fails
- stale revisions, duplicate identities and a second running turn are rejected
- completion atomically records final reply and context; duplicate and fenced attempts cannot complete
- payload canonicalization rejects non-JSON values
- repeated startup retains originating attempt epoch and observation provenance
- recovered imports reject foreign identity and retain cancellation fences
- pre-dispatch recovery requires exact durable result and imports only once
- distinct queued turns cannot run simultaneously
- superseded attempts cannot complete even with the current epoch
- payload canonicalization rejects sparse arrays at any depth and preserves valid JSON digests

### `packages/core/src/ai/aiSessionManager.test.ts`

- an interrupted session is settled to aborted on load
- a terminal or idle session loads unchanged
- updateAgentRuntime persists Agent Hub attribution
- updateAgentRuntime persists governed workflow controller linkage
- token usage accumulates across a session\'s turns
- an ACP turn adds to the token total without disturbing the context occupancy
- a session with no reported usage keeps tokenUsage unset
- a provider reporting only some fields does not invent the others
- a priced API provider accumulates an estimated cost across turns
- an unpriced provider or model leaves cost unset rather than reading as free
- createAgentSession starts a purpose, brief and runtime epoch
- an interrupted updating brief loads as stale
- brief refresh preserves user notes and ignores a stale completion
- model change is rejected while executing and records an epoch when idle
- provider handover clears native ACP state
- provider handover marks unsettled outgoing provider background tasks as stopped
- a provider handover clears a stale limit flag from the old provider
- changing model on the same provider also clears a stale limit flag
- a conversation attributes assistant messages and caps sequential turns
- pair mode grants tools only to the selected owner between turns
- a human conversation message queues for its chosen participant without duplicating transcript events
- a queued conversation message carries its staged images through to the turn
- an image-only conversation message queues without a text body
- an image-only queue attempt without any attachments is still rejected
- token usage is attributed to the open epoch
- setAgentSessionArchived toggles and clears, leaving the record otherwise untouched
- setAgentSessionArchived throws for an unknown session
- setAgentSessionArchived fires the session-changed event
- updateAgentSessionToolAccess updates workingDirectory and toolMode
- startup recovery is explicit, excludes workflow stages, and dismissal persists
- starting an approved turn clears the restart recovery marker
- lazy session transcripts migrate on load and hydrate on demand
- lazy session metadata retains unnamed subagent completions and excludes ordinary commands mentioning subagents
- tool calls that load a skill are recorded on the session as detected skills
- durable ownership and negotiated context delivery persist without aliasing the caller
- standalone sessions persist without team-chat ownership
- provider session identity survives ownership persistence

## Implementation diff

```diff
diff --git a/packages/core/src/ai/aiSessionManager.test.ts b/packages/core/src/ai/aiSessionManager.test.ts
index 7e7f473d..037827ea 100644
--- a/packages/core/src/ai/aiSessionManager.test.ts
+++ b/packages/core/src/ai/aiSessionManager.test.ts
@@ -623,10 +623,34 @@ test('durable ownership and negotiated context delivery persist without aliasing
   const manager = new AiSessionManager(storage);
   const ownership = { conversationId: 'conversation', turnId: 'turn', participantId: 'member', attemptId: 'attempt', bindingId: 'binding', coordinatorEpoch: 'epoch' };
   manager.updateAgentRuntime('SESSION-abc', { teamChatExecution: ownership, teamChatContextDelivery: 'native' });
+  const expected = structuredClone(ownership);
   ownership.attemptId = 'mutated';
   assert.equal(manager.getAgentSession('SESSION-abc')?.teamChatExecution?.attemptId, 'attempt');
   await new Promise(resolve => setTimeout(resolve, 0));
   const restored = new AiSessionManager(storage).getAgentSession('SESSION-abc');
-  assert.equal(restored?.teamChatExecution?.bindingId, 'binding');
+  assert.equal(restored?.teamChatExecution?.providerSessionId, undefined);
+  assert.deepEqual(restored?.teamChatExecution, expected);
   assert.equal(restored?.teamChatContextDelivery, 'native');
 });
+
+test('standalone sessions persist without team-chat ownership', async () => {
+  const storage = storeWith({ 'SESSION-abc': baseRecord('completed') });
+  const manager = new AiSessionManager(storage);
+  assert.equal(manager.getAgentSession('SESSION-abc')?.teamChatExecution, undefined);
+  manager.updateAgentRuntime('SESSION-abc', { agentId: 'standalone-agent' });
+  await new Promise(resolve => setTimeout(resolve, 0));
+  const restored = new AiSessionManager(storage).getAgentSession('SESSION-abc');
+  assert.ok(restored);
+  assert.equal(restored.teamChatExecution, undefined);
+});
+
+test('provider session identity survives ownership persistence', async () => {
+  const storage = storeWith({ 'SESSION-abc': baseRecord('completed') });
+  const manager = new AiSessionManager(storage);
+  const ownership = { conversationId: 'c', turnId: 't', participantId: 'p', attemptId: 'a', coordinatorEpoch: 'epoch', providerSessionId: 'provider-session' };
+  const expected = structuredClone(ownership);
+  manager.updateAgentRuntime('SESSION-abc', { teamChatExecution: ownership });
+  ownership.providerSessionId = 'mutated';
+  await new Promise(resolve => setTimeout(resolve, 0));
+  assert.deepEqual(new AiSessionManager(storage).getAgentSession('SESSION-abc')?.teamChatExecution, expected);
+});
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.test.ts b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
index 3678406e..868b9db6 100644
--- a/packages/core/src/ai/assistant/teamChatTransitions.test.ts
+++ b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
@@ -20,14 +20,23 @@ test('submit is atomic, isolated and idempotent after acknowledgement loss; conf
   assert.equal(accepted.turns.length, 1);
   assert.equal(accepted.commandReceipts[0].revision, 1);
   assert.deepEqual(submitConversationTurn(accepted, 0, { selectedParticipantIds: ['p'], text: 'hello' }, turn, message), accepted);
+  const beforeConflict = structuredClone(accepted);
   assert.throws(() => submitConversationTurn(accepted, 1, { text: 'other' }, turn, message), /payload conflict/);
+  assert.deepEqual(accepted, beforeConflict);
+  const replay = submitConversationTurn(accepted, 0, payload, turn, message);
+  replay.turns[0].plan.participants[0].instructions = 'replay mutation';
+  replay.messages[0].text = 'replay mutation';
+  replay.commandReceipts[0].turnId = 'replay mutation';
+  assert.deepEqual(accepted, beforeConflict);
   turn.plan.participants[0].instructions = 'changed';
   assert.equal(accepted.turns[0].plan.participants[0].instructions, 'help');
 });
 test('stale revisions, duplicate identities and a second running turn are rejected', () => {
   const { chat, payload, turn, message } = fixture();
   const accepted = submitConversationTurn(chat, 0, payload, turn, message);
+  const beforeStale = structuredClone(accepted);
   assert.throws(() => startConversationTurn(accepted, 0, 't'), /revision conflict/);
+  assert.deepEqual(accepted, beforeStale);
   const running = startConversationTurn(accepted, 1, 't');
   assert.throws(() => startConversationTurn(running, 2, 't'), /active/);
   assert.throws(() => submitConversationTurn(accepted, 1, payload, { ...turn, commandId: 'other' }, message), /Invalid/);
@@ -48,7 +57,14 @@ test('completion atomically records final reply and context; duplicate and fence
   assert.equal(done.turns[0].attempts[0].resultMessageId, 'r');
   assert.equal(done.messages.length, 2);
   assert.equal(reserved.messages.length, 1);
+  const beforeDuplicate = structuredClone(done);
   assert.throws(() => completeConversationAttempt(done, 5, 't', 'a', 'epoch', { ...reply, id: 'r2', sequence: 3 }, attempt.contextReceipt), /duplicate/);
+  assert.deepEqual(done, beforeDuplicate);
+  const replay = submitConversationTurn(done, 0, payload, turn, message);
+  assert.deepEqual(replay, done);
+  assert.equal(replay.turns.length, 1);
+  assert.equal(replay.commandReceipts.length, 1);
+  assert.equal(replay.revision, 5);
 });
 test('payload canonicalization rejects non-JSON values', () => {
   assert.throws(() => conversationPayloadDigest({ value: undefined }), /JSON/);
@@ -104,3 +120,38 @@ test('pre-dispatch recovery requires exact durable result and imports only once'
   assert.equal(completed.turns[0].attempts[0].state, 'completed');
   assert.throws(() => completeConversationAttempt(completed, 5, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /duplicate|fenced/);
 });
+
+test('distinct queued turns cannot run simultaneously', () => {
+  const { chat, payload, turn, message } = fixture();
+  const first = submitConversationTurn(chat, 0, payload, turn, message);
+  const queued = submitConversationTurn(first, 1, payload,
+    { ...turn, id: 't2', commandId: 'cmd2', userMessageId: 'u2', acceptedSequence: 2 },
+    { ...message, id: 'u2', turnId: 't2', sequence: 2 });
+  const running = startConversationTurn(queued, 2, 't');
+  const before = structuredClone(running);
+  assert.throws(() => startConversationTurn(running, 3, 't2'), /active/);
+  assert.deepEqual(running, before);
+});
+
+test('superseded attempts cannot complete even with the current epoch', () => {
+  const { chat, payload, turn, message, attempt, reply } = fixture();
+  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
+  const prepared = reserveConversationAttempt(running, 2, attempt);
+  const dispatched = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
+  dispatched.turns[0].attempts[0].state = 'failed';
+  const retried = reserveConversationAttempt(dispatched, 4, { ...attempt, id: 'a2', ordinal: 2 });
+  const active = advanceConversationAttempt(retried, 5, 't', 'a2', 'epoch', 'dispatching', 'later');
+  const before = structuredClone(active);
+  assert.throws(() => completeConversationAttempt(active, 6, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
+  assert.deepEqual(active, before);
+});
+
+test('payload canonicalization rejects sparse arrays at any depth and preserves valid JSON digests', () => {
+  for (const value of [Array(1), [1, , 3], { nested: [Array(2)] }]) {
+    assert.throws(() => conversationPayloadDigest(value), /JSON.*sparse/);
+  }
+  assert.equal(conversationPayloadDigest({ b: [null, true, 2], a: 'text' }),
+    conversationPayloadDigest({ a: 'text', b: [null, true, 2] }));
+  assert.equal(conversationPayloadDigest([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
+  assert.notEqual(conversationPayloadDigest([null]), conversationPayloadDigest([]));
+});
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.ts b/packages/core/src/ai/assistant/teamChatTransitions.ts
index 1333c002..9b7a9881 100644
--- a/packages/core/src/ai/assistant/teamChatTransitions.ts
+++ b/packages/core/src/ai/assistant/teamChatTransitions.ts
@@ -6,7 +6,12 @@ export function conversationPayloadDigest(payload: unknown): string {
   const canonical = (value: unknown): string => {
     if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
     if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
-    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
+    if (Array.isArray(value)) {
+      for (let index = 0; index < value.length; index++) {
+        if (!Object.hasOwn(value, index)) throw new Error('Command payload must contain only JSON values; sparse arrays are invalid.');
+      }
+      return `[${value.map(canonical).join(',')}]`;
+    }
     if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
       return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
     }
```
