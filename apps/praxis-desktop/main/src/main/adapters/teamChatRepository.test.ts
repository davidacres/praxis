import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamChatStore } from '@praxis/core';
import { FileTeamChatRepository, TeamChatCommitUncertainError, TeamChatStorageError } from './teamChatRepository';

function profile(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'team-chats.json');
}
test('two windows and two chats retain concurrent accepted mutations and isolate returned objects', async t => {
  const file = profile(t);
  const first = new FileTeamChatRepository(file);
  const second = new FileTeamChatRepository(file);
  const a = new TeamChatStore(first); const b = new TeamChatStore(second);
  const [one, two] = await Promise.all([a.create('p'), b.create('p')]);
  await Promise.all([a.rename(one.id, 'one'), b.rename(two.id, 'two'), b.saveMessages(one.id, [{ id: 'm', role: 'user', text: 'hello', createdAt: 'now' }])]);
  assert.equal(a.get(one.id)?.title, 'one'); assert.equal(b.get(two.id)?.title, 'two');
  assert.equal(a.get(one.id)?.messages.length, 1);
  const snapshot = first.read(); snapshot.teamChats.length = 0;
  assert.equal(second.read().teamChats.length, 2);
  assert.equal(second.read().revision, 5);
});
test('pre-rename failure preserves committed bytes and rejects acknowledgement; next mutation uses old state', async t => {
  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
  const chat = await store.create('p'); const old = fs.readFileSync(file, 'utf8');
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('injected before rename'); });
  await assert.rejects(store.rename(chat.id, 'lost'), /injected before rename/);
  assert.equal(fs.readFileSync(file, 'utf8'), old); assert.equal(store.get(chat.id)?.title, 'New team chat');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['team-chats.json']);
  rename.mock.restore();
  await store.rename(chat.id, 'kept'); assert.equal(store.get(chat.id)?.title, 'kept');
});
test('post-rename failure halts writes until receipt reconciliation', async t => {
  if (process.platform === 'win32') { t.skip('Windows does not flush directories'); return; }
  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
  const chat = await store.create('p');
  const originalOpen = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === path.dirname(file)) throw new Error('directory flush unavailable');
    return originalOpen(...args);
  });
  await assert.rejects(store.rename(chat.id, 'committed'), TeamChatCommitUncertainError);
  open.mock.restore();
  await assert.rejects(store.rename(chat.id, 'blocked'), TeamChatCommitUncertainError);
  await repository.reconcile(snapshot => { assert.equal(snapshot.teamChats[0].title, 'committed'); });
  await store.rename(chat.id, 'reconciled');
});
test('corrupt and unsupported files fail visibly without replacing data; legacy data remains readable', async t => {
  const file = profile(t);
  for (const raw of ['{broken', '{}', '{"schemaVersion":99,"teamChats":[]}', '{"teamChats":[{}]}']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => new FileTeamChatRepository(file), TeamChatStorageError);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.writeFileSync(file, '{"teamChats":[]}');
  const repository = new FileTeamChatRepository(file);
  await assert.rejects(repository.transaction(draft => { draft.teamChats.push({} as never); }), /Invalid chat/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"teamChats":[]}');
});

test('durable submit and completion commit together and replay returns the original turn', async t => {
  const { conversationPayloadDigest, submitConversationTurn, startConversationTurn, reserveConversationAttempt, completeConversationAttempt, advanceConversationAttempt } = await import('@praxis/core');
  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
  await repository.transaction(draft => { draft.conversations.push({ schemaVersion: 2, id: 'c', title: 'chat', createdAt: 'now', updatedAt: 'now', revision: 0, coordinatorEpoch: 'epoch', participants: [], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] }); });
  const payload = { text: 'hello' };
  const turn: import('@praxis/core').ConversationTurn = { id: 't', commandId: 'cmd', payloadDigest: conversationPayloadDigest(payload), userMessageId: 'u', acceptedSequence: 1, plan: { participants: [{ id: 'p', role: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} }], runtimeOptions: {} }, state: 'queued', completedParticipantIds: [], attempts: [] };
  const message: import('@praxis/core').ConversationMessage = { id: 'u', role: 'user', text: 'hello', createdAt: 'now', sequence: 1, turnId: 't', attachments: [] };
  const submit = () => store.transition('c', chat => submitConversationTurn(chat, 0, payload, turn, message));
  await Promise.all([submit(), submit()]);
  assert.equal(repository.read().conversations[0].messages.length, 1);
  assert.equal(repository.read().conversations[0].commandReceipts[0].turnId, 't');
  await store.transition('c', chat => startConversationTurn(chat, 1, 't'));
  const attempt: import('@praxis/core').ConversationAttempt = { id: 'a', turnId: 't', participantId: 'p', ordinal: 1, coordinatorEpoch: 'epoch', state: 'prepared', contextReceipt: { digest: 'context', messageIds: ['u'] }, createdAt: 'now', usageReferences: [], toolEvidenceReferences: [] };
  await store.transition('c', chat => reserveConversationAttempt(chat, 2, attempt));
  await store.transition('c', chat => advanceConversationAttempt(chat, 3, 't', 'a', 'epoch', 'dispatching', 'now'));
  const finish = () => store.transition('c', chat => completeConversationAttempt(chat, 4, 't', 'a', 'epoch', { ...message, id: 'reply', role: 'lead', participantId: 'p', sequence: 2 }, attempt.contextReceipt));
  const before = fs.readFileSync(file, 'utf8');
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('completion commit failed'); });
  await assert.rejects(finish(), /completion commit failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  rename.mock.restore();
  await finish();
  const reloaded = new FileTeamChatRepository(file).read().conversations[0];
  assert.equal(reloaded.messages.length, 2);
  assert.equal(reloaded.turns[0].attempts[0].state, 'completed');
  assert.equal(reloaded.turns[0].attempts[0].contextReceipt.digest, 'context');
});

test('provider bindings, summary provenance, usage and decision corrections survive reload in isolation', async t => {
  const file = profile(t);
  const repository = new FileTeamChatRepository(file);
  await repository.transaction(draft => {
    draft.conversations.push({ schemaVersion: 2, id: 'durable', title: 'chat', createdAt: 'now', updatedAt: 'now', revision: 0, coordinatorEpoch: 'epoch', participants: [],
      messages: [{ id: 'source', role: 'user', text: 'Original decision', createdAt: 'now', sequence: 1, turnId: 'old', attachments: [] }, { id: 'correction', role: 'user', text: 'Corrected decision', createdAt: 'now', sequence: 2, turnId: 'old', attachments: [] }], turns: [],
      bindings: [{ id: 'binding', conversationId: 'durable', participantId: 'lead', providerRuntime: 'fixture', compatibilityDigest: 'safe-hash', deliveredMessageIds: ['source'], nativeOutputMessageIds: [], status: 'valid' }],
      summaries: [{ id: 'summary', version: 1, sourceStart: 1, sourceEnd: 1, sourceMessageIds: ['source'], sourceDigest: 'source-hash', text: 'Summary', attemptId: 'summary-attempt', provider: 'fixture' }],
      summaryAttempts: [{ id: 'summary-attempt', sourceDigest: 'source-hash', provider: 'fixture', state: 'completed', usage: { inputTokens: 10 } }],
      pinnedMessageIds: ['source', 'correction'], decisionCorrections: [{ messageId: 'correction', supersedesMessageId: 'source' }], commandReceipts: [] });
  });
  const reloaded = new FileTeamChatRepository(file).read().conversations[0];
  assert.equal(reloaded.bindings[0].deliveredMessageIds[0], 'source');
  assert.equal(reloaded.summaryAttempts![0].usage?.inputTokens, 10);
  assert.equal(reloaded.summaries[0].attemptId, 'summary-attempt');
  assert.equal(reloaded.decisionCorrections![0].supersedesMessageId, 'source');
  reloaded.bindings[0].status = 'invalid';
  assert.equal(repository.read().conversations[0].bindings[0].status, 'valid');
  await assert.rejects(repository.transaction(draft => { draft.conversations[0].pinnedMessageIds.push('missing'); }), /pinned source/);
  await assert.rejects(repository.transaction(draft => { draft.conversations[0].summaryAttempts![0].state = 'invalid' as never; }), /summary attempt/);
});

test('startup evidence and recovered reply survive repeated durable epoch changes', async t => {
  const { TeamChatCoordinator, makeParticipant } = await import('@praxis/core');
  const file = profile(t);
  const repository = new FileTeamChatRepository(file);
  await repository.transaction(draft => {
    draft.conversations.push({ schemaVersion: 2, id: 'recover', title: 'chat', createdAt: 'now', updatedAt: 'now',
      revision: 1, coordinatorEpoch: 'original', participants: [makeParticipant('lead')], messages: [], turns: [],
      bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] });
  });
  const coordinator = new TeamChatCoordinator({ repository, executionAdapter: {
    execute: async () => { throw new Error('interruption'); }
  } });
  await coordinator.submitTurn({ conversationId: 'recover', commandId: 'submit', expectedRevision: 1,
    text: 'hello', selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  for (let i = 0; i < 100 && !repository.read().conversations[0].turns[0]?.attempts[0]?.completedAt; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  await repository.transaction(draft => {
    const conv = draft.conversations[0], turn = conv.turns[0], attempt = turn.attempts[0];
    turn.state = 'running';
    attempt.state = 'prepared';
    delete attempt.dispatchIntent;
    attempt.recoveryEvidence = [{ id: 'result', conversationId: conv.id, turnId: turn.id,
      participantId: attempt.participantId, attemptId: attempt.id, coordinatorEpoch: attempt.coordinatorEpoch,
      kind: 'final_result', observedAt: 'now', provenance: 'adapter', result: { text: 'recovered', usageReferences: ['once'] } }];
  });
  for (let i = 0; i < 2; i++) {
    const reloaded = new FileTeamChatRepository(file);
    await new TeamChatCoordinator({ repository: reloaded, executionAdapter: {
      execute: async () => { throw new Error('must not replay'); }
    } }).initialize();
    const conv = new FileTeamChatRepository(file).read().conversations[0];
    assert.equal(conv.messages.filter(m => m.text === 'recovered').length, 1);
    assert.equal(conv.turns[0].attempts[0].recoveryEvidence![0].coordinatorEpoch, conv.turns[0].attempts[0].coordinatorEpoch);
    const reconciliation = conv.turns[0].attempts[0].recoveryEvidence!.find(e => e.kind === 'reconciliation')!;
    assert.equal(typeof reconciliation.observingEpoch, 'string');
    assert.notEqual(reconciliation.observingEpoch, reconciliation.coordinatorEpoch);
    assert.equal(conv.turns[0].state, 'completed');
  }
});

test('repository validates observation epochs separately from immutable attempt epochs', async t => {
  const { makeParticipant } = await import('@praxis/core');
  const file = profile(t);
  const repository = new FileTeamChatRepository(file);
  await repository.transaction(draft => {
    draft.conversations.push({ schemaVersion: 2, id: 'c', title: 'chat', createdAt: 'now', updatedAt: 'now',
      revision: 0, coordinatorEpoch: 'observer', participants: [makeParticipant('lead')], messages: [],
      bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [], turns: [{
        id: 't', commandId: 'cmd', payloadDigest: 'digest', userMessageId: 'u', acceptedSequence: 1,
        plan: { participants: [makeParticipant('lead')], runtimeOptions: {} }, state: 'interrupted',
        completedParticipantIds: [], attempts: [{ id: 'a', turnId: 't', participantId: 'part-lead', ordinal: 1,
          coordinatorEpoch: 'origin', state: 'interrupted', createdAt: 'now', contextReceipt: { digest: 'd', messageIds: [] },
          usageReferences: [], toolEvidenceReferences: [], recoveryEvidence: [{ id: 'e', conversationId: 'c', turnId: 't',
            participantId: 'part-lead', attemptId: 'a', coordinatorEpoch: 'origin', observingEpoch: 'observer',
            kind: 'reconciliation', observedAt: 'now', provenance: 'startup' }] }] }] });
  });
  const snapshot = new FileTeamChatRepository(file).read();
  const evidence = snapshot.conversations[0].turns[0].attempts[0].recoveryEvidence![0];
  assert.equal(evidence.coordinatorEpoch, 'origin');
  assert.equal(evidence.observingEpoch, 'observer');
  for (const invalid of [{ ...evidence, observingEpoch: '' }, { ...evidence, coordinatorEpoch: 'observer' }]) {
    snapshot.conversations[0].turns[0].attempts[0].recoveryEvidence![0] = invalid;
    fs.writeFileSync(file, JSON.stringify(snapshot));
    assert.throws(() => new FileTeamChatRepository(file), /Invalid recovery evidence/);
  }
});
