import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ConversationAttempt, ConversationMessage, ConversationTurn, DurableConversation } from './assistantTypes';
import { beginConversationEpoch, conversationPayloadDigest, submitConversationTurn, startConversationTurn, reserveConversationAttempt, completeConversationAttempt, advanceConversationAttempt } from './teamChatTransitions';

function fixture() {
  const chat: DurableConversation = { schemaVersion: 2, id: 'c', title: 'chat', createdAt: 'now', updatedAt: 'now', revision: 0, coordinatorEpoch: 'epoch', participants: [], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] };
  const payload = { text: 'hello', selectedParticipantIds: ['p'] };
  const turn: ConversationTurn = { id: 't', commandId: 'cmd', payloadDigest: conversationPayloadDigest(payload), userMessageId: 'u', acceptedSequence: 1, plan: { participants: [{ id: 'p', role: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} }], runtimeOptions: {} }, state: 'queued', completedParticipantIds: [], attempts: [] };
  const message: ConversationMessage = { id: 'u', role: 'user', text: 'hello', createdAt: 'now', sequence: 1, turnId: 't', attachments: [] };
  const attempt: ConversationAttempt = { id: 'a', turnId: 't', participantId: 'p', ordinal: 1, coordinatorEpoch: 'epoch', state: 'prepared', contextReceipt: { digest: 'digest', messageIds: ['u'] }, createdAt: 'now', usageReferences: [], toolEvidenceReferences: [] };
  const reply: ConversationMessage = { ...message, id: 'r', role: 'lead', participantId: 'p', sequence: 2, text: 'reply' };
  return { chat, payload, turn, message, attempt, reply };
}
test('submit is atomic, isolated and idempotent after acknowledgement loss; conflicting reuse fails', () => {
  const { chat, payload, turn, message } = fixture();
  const accepted = submitConversationTurn(chat, 0, payload, turn, message);
  assert.equal(chat.messages.length, 0);
  assert.equal(accepted.messages.length, 1);
  assert.equal(accepted.turns.length, 1);
  assert.equal(accepted.commandReceipts[0].revision, 1);
  assert.deepEqual(submitConversationTurn(accepted, 0, { selectedParticipantIds: ['p'], text: 'hello' }, turn, message), accepted);
  const beforeConflict = structuredClone(accepted);
  assert.throws(() => submitConversationTurn(accepted, 1, { text: 'other' }, turn, message), /payload conflict/);
  assert.deepEqual(accepted, beforeConflict);
  const replay = submitConversationTurn(accepted, 0, payload, turn, message);
  replay.turns[0].plan.participants[0].instructions = 'replay mutation';
  replay.messages[0].text = 'replay mutation';
  replay.commandReceipts[0].turnId = 'replay mutation';
  assert.deepEqual(accepted, beforeConflict);
  turn.plan.participants[0].instructions = 'changed';
  assert.equal(accepted.turns[0].plan.participants[0].instructions, 'help');
});
test('stale revisions, duplicate identities and a second running turn are rejected', () => {
  const { chat, payload, turn, message } = fixture();
  const accepted = submitConversationTurn(chat, 0, payload, turn, message);
  const beforeStale = structuredClone(accepted);
  assert.throws(() => startConversationTurn(accepted, 0, 't'), /revision conflict/);
  assert.deepEqual(accepted, beforeStale);
  const running = startConversationTurn(accepted, 1, 't');
  assert.throws(() => startConversationTurn(running, 2, 't'), /active/);
  assert.throws(() => submitConversationTurn(accepted, 1, payload, { ...turn, commandId: 'other' }, message), /Invalid/);
});
test('completion atomically records final reply and context; duplicate and fenced attempts cannot complete', () => {
  const { chat, payload, turn, message, attempt, reply } = fixture();
  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
  const prepared = reserveConversationAttempt(running, 2, attempt);
  assert.throws(() => completeConversationAttempt(prepared, 3, 't', 'a', 'epoch', reply, attempt.contextReceipt), /Invalid/);
  const reserved = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
  assert.throws(() => reserveConversationAttempt(reserved, 4, { ...attempt, id: 'b', ordinal: 2 }), /Invalid/);
  assert.throws(() => completeConversationAttempt(reserved, 4, 't', 'a', 'old', reply, attempt.contextReceipt), /fenced/);
  const fenced = structuredClone(reserved); fenced.coordinatorEpoch = 'new';
  assert.throws(() => completeConversationAttempt(fenced, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
  assert.throws(() => completeConversationAttempt(reserved, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt, {}, 'missing-result'), /fenced/);
  const done = completeConversationAttempt(reserved, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt);
  assert.equal(done.turns[0].state, 'completed');
  assert.equal(done.turns[0].attempts[0].resultMessageId, 'r');
  assert.equal(done.messages.length, 2);
  assert.equal(reserved.messages.length, 1);
  const beforeDuplicate = structuredClone(done);
  assert.throws(() => completeConversationAttempt(done, 5, 't', 'a', 'epoch', { ...reply, id: 'r2', sequence: 3 }, attempt.contextReceipt), /duplicate/);
  assert.deepEqual(done, beforeDuplicate);
  const replay = submitConversationTurn(done, 0, payload, turn, message);
  assert.deepEqual(replay, done);
  assert.equal(replay.turns.length, 1);
  assert.equal(replay.commandReceipts.length, 1);
  assert.equal(replay.revision, 5);
});
test('payload canonicalization rejects non-JSON values', () => {
  assert.throws(() => conversationPayloadDigest({ value: undefined }), /JSON/);
  assert.throws(() => conversationPayloadDigest(NaN), /JSON/);
});

test('repeated startup retains originating attempt epoch and observation provenance', () => {
  const { chat, payload, turn, message, attempt } = fixture();
  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
  const prepared = reserveConversationAttempt(running, 2, attempt);
  const dispatched = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
  const first = beginConversationEpoch(dispatched, 4, 'next', 'now');
  const second = beginConversationEpoch(first, 5, 'again', 'later');
  assert.equal(second.turns[0].attempts[0].coordinatorEpoch, 'epoch');
  assert.equal(second.turns[0].attempts[0].recoveryEvidence![0].coordinatorEpoch, 'epoch');
  assert.equal(second.turns[0].attempts[0].recoveryEvidence![0].observingEpoch, 'next');
  assert.equal(second.turns[0].state, 'outcome_unknown');
});

test('recovered imports reject foreign identity and retain cancellation fences', () => {
  const { chat, payload, turn, message, attempt, reply } = fixture();
  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
  const prepared = reserveConversationAttempt(running, 2, attempt);
  const dispatched = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
  const recovered = beginConversationEpoch(dispatched, 4, 'new', 'later');
  const a = recovered.turns[0].attempts[0];
  a.recoveryEvidence!.push({ id: 'result', conversationId: 'foreign', turnId: 't', participantId: 'p',
    attemptId: 'a', coordinatorEpoch: 'epoch', kind: 'final_result', observedAt: 'now', provenance: 'adapter',
    result: { text: reply.text } });
  assert.throws(() => completeConversationAttempt(recovered, 5, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /fenced/);
  a.recoveryEvidence!.at(-1)!.conversationId = 'c';
  recovered.turns[0].state = 'cancelled';
  assert.throws(() => completeConversationAttempt(recovered, 5, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /fenced/);
});

test('pre-dispatch recovery requires exact durable result and imports only once', () => {
  const { chat, payload, turn, message, attempt, reply } = fixture();
  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
  const prepared = reserveConversationAttempt(running, 2, attempt);
  assert.throws(() => completeConversationAttempt(prepared, 3, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
  const recovered = beginConversationEpoch(prepared, 3, 'observer', 'later');
  const a = recovered.turns[0].attempts[0];
  a.recoveryEvidence!.push({ id: 'result', conversationId: 'c', turnId: 't', participantId: 'p',
    attemptId: 'a', coordinatorEpoch: 'epoch', kind: 'final_result', observedAt: 'now', provenance: 'adapter',
    result: { text: reply.text } });
  for (const field of ['conversationId', 'turnId', 'participantId', 'attemptId', 'coordinatorEpoch'] as const) {
    const foreign = structuredClone(recovered);
    foreign.turns[0].attempts[0].recoveryEvidence!.at(-1)![field] = 'foreign';
    assert.throws(() => completeConversationAttempt(foreign, 4, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /fenced/);
  }
  assert.throws(() => completeConversationAttempt(recovered, 4, 't', 'a', 'observer', reply, a.contextReceipt, {}, 'result'), /fenced/);
  const completed = completeConversationAttempt(recovered, 4, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result');
  assert.equal(completed.turns[0].attempts[0].state, 'completed');
  assert.throws(() => completeConversationAttempt(completed, 5, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /duplicate|fenced/);
});

test('distinct queued turns cannot run simultaneously', () => {
  const { chat, payload, turn, message } = fixture();
  const first = submitConversationTurn(chat, 0, payload, turn, message);
  const queued = submitConversationTurn(first, 1, payload,
    { ...turn, id: 't2', commandId: 'cmd2', userMessageId: 'u2', acceptedSequence: 2 },
    { ...message, id: 'u2', turnId: 't2', sequence: 2 });
  const running = startConversationTurn(queued, 2, 't');
  const before = structuredClone(running);
  assert.throws(() => startConversationTurn(running, 3, 't2'), /active/);
  assert.deepEqual(running, before);
});

test('superseded attempts cannot complete even with the current epoch', () => {
  const { chat, payload, turn, message, attempt, reply } = fixture();
  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
  const prepared = reserveConversationAttempt(running, 2, attempt);
  const dispatched = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
  dispatched.turns[0].attempts[0].state = 'failed';
  const retried = reserveConversationAttempt(dispatched, 4, { ...attempt, id: 'a2', ordinal: 2 });
  const active = advanceConversationAttempt(retried, 5, 't', 'a2', 'epoch', 'dispatching', 'later');
  const before = structuredClone(active);
  assert.throws(() => completeConversationAttempt(active, 6, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
  assert.deepEqual(active, before);
});

test('payload canonicalization rejects sparse arrays at any depth and preserves valid JSON digests', () => {
  for (const value of [Array(1), [1, , 3], { nested: [Array(2)] }]) {
    assert.throws(() => conversationPayloadDigest(value), /JSON.*sparse/);
  }
  assert.equal(conversationPayloadDigest({ b: [null, true, 2], a: 'text' }),
    conversationPayloadDigest({ a: 'text', b: [null, true, 2] }));
  assert.equal(conversationPayloadDigest([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  assert.notEqual(conversationPayloadDigest([null]), conversationPayloadDigest([]));
});
