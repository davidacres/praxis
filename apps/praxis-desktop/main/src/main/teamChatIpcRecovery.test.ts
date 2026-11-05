import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamChatCoordinator, makeParticipant, type ConversationUpdate, type DurableConversation, type SubmitConversationCommand, type TeamChatExecutionParams } from '@praxis/core';
import { createTeamChatServices } from './teamChatServices';
import { FileTeamChatRepository, TeamChatCommitUncertainError } from './adapters/teamChatRepository';

function profile(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chat-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'team-chats.json');
}
function conversation(id: string): DurableConversation {
  return { schemaVersion: 2, id, title: id, createdAt: 'now', updatedAt: 'now', revision: 1, coordinatorEpoch: 'epoch-before-restart',
    participants: [makeParticipant('lead')], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] };
}
const submit = (conversationId: string, commandId: string, expectedRevision = 1): SubmitConversationCommand => ({ conversationId, commandId,
  expectedRevision, text: `${commandId} text`, selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
/** One "process": a services instance whose provider is scripted by `execute`. */
function launch(file: string, execute: (params: TeamChatExecutionParams) => Promise<{ text: string }>, enabled = true) {
  const calls: TeamChatExecutionParams[] = [];
  const updates: ConversationUpdate[] = [];
  let epoch = 0;
  const prefix = `process-${Math.random().toString(36).slice(2, 8)}`;
  const services = createTeamChatServices({ filePath: () => file, enabled, createCoordinator: repository => new TeamChatCoordinator({
    repository, idSource: () => `${prefix}-${++epoch}`, onUpdate: update => updates.push(update),
    executionAdapter: { execute: async params => { calls.push(params); return execute(params); } } }) });
  return { services, calls, updates };
}
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { revision: number; conversations: DurableConversation[] };

test('startup recovery reconciles a running attempt and resumes a queued turn before any chat is opened', async t => {
  const file = profile(t);
  // First process: accept one turn in each chat, crash while one is mid-reply and the other is queued behind it.
  const first = launch(file, () => new Promise(() => undefined));
  await first.services.activate();
  await first.services.repository().transaction(draft => { draft.conversations.push(conversation('running'), conversation('queued')); });
  await first.services.submitTurn(submit('running', 'mid-reply'));
  await until(() => read(file).conversations[0].turns[0]?.attempts[0]?.state === 'dispatching', 'dispatch');
  // The queued chat's turn was accepted durably, but this process never dispatched it.
  const bytes = read(file);
  bytes.conversations[1].turns.push({ ...structuredClone(bytes.conversations[0].turns[0]), id: 'queued-turn', commandId: 'waiting',
    userMessageId: 'queued-message', state: 'queued', attempts: [] });
  bytes.conversations[1].messages.push({ id: 'queued-message', turnId: 'queued-turn', role: 'user', text: 'still waiting', createdAt: 'now', sequence: 1, attachments: [] });
  bytes.conversations[1].commandReceipts.push({ commandId: 'waiting', payloadDigest: bytes.conversations[1].turns[0].payloadDigest, turnId: 'queued-turn', revision: 1, outcome: 'accepted' });
  fs.writeFileSync(file, JSON.stringify(bytes));

  // Second process: nothing calls getConversation; startup alone must do the work.
  const second = launch(file, async () => ({ text: 'resumed after restart' }));
  assert.equal(await second.services.recoverOnStartup(), true);
  await until(() => read(file).conversations[1].turns[0].state === 'completed', 'queued turn completion');
  const after = read(file);
  assert.deepEqual(second.calls.map(call => call.conversation.id), ['queued'], 'only the queued chat dispatches');
  assert.equal(after.conversations[0].turns[0].attempts[0].state, 'outcome_unknown', 'the dispatched attempt is never replayed');
  assert.equal(after.conversations[0].turns[0].state, 'outcome_unknown');
  assert.equal(after.conversations[1].messages.filter(m => m.text === 'resumed after restart').length, 1);

  // A third process over the settled bytes changes nothing and dispatches nothing.
  const third = launch(file, async () => ({ text: 'unexpected' }));
  await third.services.recoverOnStartup();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(third.calls.length, 0);
  assert.equal(read(file).conversations[1].messages.filter(m => m.role === 'lead').length, 1);
});

test('startup recovery leaves a profile that never activated durable chat untouched', async t => {
  const file = profile(t);
  const missing = launch(file, async () => ({ text: 'unexpected' }));
  assert.equal(await missing.services.recoverOnStartup(), false);
  assert.equal(fs.existsSync(file), false, 'no file is created for a fresh profile');
  const legacy = JSON.stringify({ teamChats: [{ id: 'old', projectId: 'p', title: 'Old', createdAt: 'then', updatedAt: 'then', messages: [] }] });
  fs.writeFileSync(file, legacy);
  assert.equal(await launch(file, async () => ({ text: 'unexpected' })).services.recoverOnStartup(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy, 'legacy data is migrated only by a chat request');
  assert.equal(fs.existsSync(`${file}.v1-backup`), false);
  const disabled = launch(file, async () => ({ text: 'unexpected' }), false);
  assert.equal(await disabled.services.recoverOnStartup(), false);
});

test('activation failure leaves durable dispatch disabled', async t => {
  const file = profile(t);
  const legacy = JSON.stringify({ teamChats: [{ id: 'old', projectId: 'p', title: 'Old', createdAt: 'then', updatedAt: 'then', messages: [] }] });
  fs.writeFileSync(file, legacy);
  // An interrupted earlier backup that does not match the source makes activation fail.
  fs.writeFileSync(`${file}.v1-backup`, 'incomplete');
  const failed = launch(file, async () => ({ text: 'must not run' }));
  await assert.rejects(failed.services.submitTurn(submit('old', 'blocked', 0)), /backup/);
  await assert.rejects(failed.services.submitTurn(submit('old', 'blocked-again', 0)), /backup/);
  assert.equal(failed.calls.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  // The disabled switch also refuses, rather than silently dispatching against legacy data.
  const off = launch(file, async () => ({ text: 'must not run' }), false);
  await assert.rejects(off.services.submitTurn(submit('old', 'off', 0)), /disabled/);
  assert.equal(off.calls.length, 0);
  // Once the bad backup is removed, activation and dispatch proceed.
  fs.rmSync(`${file}.v1-backup`);
  const fixed = launch(file, async () => ({ text: 'now allowed' }));
  await fixed.services.submitTurn(submit('old', 'allowed', 0));
  await until(() => read(file).conversations[0].turns[0]?.state === 'completed', 'completion after repair');
  assert.equal(fixed.calls.length, 1);
});

/** Start a profile with durable chat active and the given conversations, ready to accept commands. */
async function ready(file: string, execute: (params: TeamChatExecutionParams) => Promise<{ text: string }>, ...ids: string[]) {
  const app = launch(file, execute);
  await app.services.activate();
  await app.services.repository().transaction(draft => { draft.conversations.push(...ids.map(conversation)); });
  await app.services.coordinator().initialize();
  return app;
}
const revisionOf = (file: string, id: string) => read(file).conversations.find(c => c.id === id)!.revision;

test('a pre-rename submit failure emits no acceptance and invokes no provider; the same command then succeeds once', async t => {
  const file = profile(t);
  const app = await ready(file, async () => ({ text: 'reply' }), 'c');
  const before = fs.readFileSync(file, 'utf8');
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('injected before rename'); });
  await assert.rejects(app.services.submitTurn(submit('c', 'cmd', revisionOf(file, 'c'))), /injected before rename/);
  rename.mock.restore();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the old committed snapshot is still what is on disk');
  assert.equal(app.updates.some(update => update.type === 'turn_accepted'), false, 'no accepted acknowledgement');
  assert.equal(app.calls.length, 0, 'no provider dispatch');

  const accepted = await app.services.submitTurn(submit('c', 'cmd', revisionOf(file, 'c')));
  await until(() => read(file).conversations[0].turns[0]?.state === 'completed', 'completion');
  const after = read(file).conversations[0];
  assert.equal(after.turns.length, 1); assert.equal(after.turns[0].id, accepted.turnId);
  assert.equal(after.commandReceipts.length, 1);
  assert.equal(app.updates.filter(update => update.type === 'turn_accepted').length, 1);
  assert.equal(app.calls.length, 1);
});

test('an uncertain submit commit is not acknowledged; reconciliation returns the original turn for the same command id', async t => {
  if (process.platform === 'win32') { t.skip('Windows does not flush directories'); return; }
  const file = profile(t);
  const first = await ready(file, () => new Promise(() => undefined), 'c');
  const command = submit('c', 'uncertain', revisionOf(file, 'c'));
  const originalOpen = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === path.dirname(file)) throw new Error('directory flush unavailable');
    return originalOpen(...args);
  });
  await assert.rejects(first.services.submitTurn(command), TeamChatCommitUncertainError);
  open.mock.restore();
  assert.equal(first.updates.some(update => update.type === 'turn_accepted'), false, 'an uncertain commit is never acknowledged');
  assert.equal(first.calls.length, 0, 'an uncertain commit never dispatches');
  // Every later write is refused until reconciliation reads the receipts back.
  await assert.rejects(first.services.submitTurn({ ...command, commandId: 'later' }), TeamChatCommitUncertainError);

  let receipt: string | undefined;
  await first.services.repository().reconcile(snapshot => {
    receipt = snapshot.conversations[0].commandReceipts.find(item => item.commandId === 'uncertain')?.turnId;
  });
  assert.ok(receipt, 'the rename landed, so the receipt is on disk');
  const replay = await first.services.submitTurn(command);
  assert.equal(replay.turnId, receipt, 'the same command id resolves to the original turn');
  const after = read(file).conversations[0];
  assert.equal(after.turns.length, 1);
  assert.equal(after.messages.filter(message => message.role === 'user').length, 1);
});

test('an uncertain commit while reserving an attempt halts dispatch and reports reload', async t => {
  if (process.platform === 'win32') { t.skip('Windows does not flush directories'); return; }
  const file = profile(t);
  const first = await ready(file, async () => ({ text: 'must not run' }), 'c');
  const originalOpen = fs.promises.open;
  let failed = false;
  // Fail the directory flush only for the commit whose bytes first carry a reserved attempt.
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (!failed && args[0] === path.dirname(file) && read(file).conversations[0].turns[0]?.attempts.length) {
      failed = true;
      throw new Error('directory flush unavailable');
    }
    return originalOpen(...args);
  });
  await first.services.submitTurn(submit('c', 'reserve', revisionOf(file, 'c')));
  await until(() => first.updates.some(update => update.type === 'turn_failed'), 'halt report');
  open.mock.restore();
  assert.equal(failed, true);
  assert.equal(first.calls.length, 0, 'the provider is never called after an uncertain reservation');
  const halt = first.updates.find(update => update.type === 'turn_failed')!;
  assert.match(halt.error ?? '', /Restart Praxis to recover this team chat\./);
  const stranded = read(file).conversations[0].turns[0].attempts[0];
  assert.equal(stranded.state, 'prepared');
  assert.equal(stranded.dispatchIntent, undefined);

  // Writes stay refused until reconciliation (a real restart resets this module-level fence).
  await assert.rejects(first.services.repository().transaction(() => undefined), TeamChatCommitUncertainError);
  await first.services.repository().reconcile(snapshot => { assert.equal(snapshot.conversations[0].turns[0].attempts[0].id, stranded.id); });
  // Restart: a new process starts a new epoch, and the never-dispatched attempt is not replayed.
  const second = launch(file, async () => ({ text: 'after restart' }));
  assert.equal(await second.services.recoverOnStartup(), true);
  await new Promise(resolve => setTimeout(resolve, 30));
  const recovered = read(file).conversations[0].turns[0];
  assert.equal(recovered.attempts[0].state, 'interrupted', 'an undispatched reservation is classified, not replayed');
  assert.equal(recovered.attempts[0].id, stranded.id);
  assert.equal(second.calls.filter(call => call.attempt.id === stranded.id).length, 0);
});

test('two windows over two chats retain every accepted submit', async t => {
  const file = profile(t);
  const app = await ready(file, async params => ({ text: `reply to ${params.turn.id}` }), 'x', 'y');
  // A second adapter instance stands in for another window's writes to the same profile.
  const otherWindow = new FileTeamChatRepository(file);
  const revisions: number[] = [];
  const watch = <T>(work: Promise<T>) => work.then(value => { revisions.push(read(file).revision); return value; });
  const results = await Promise.all([
    watch(app.services.submitTurn(submit('x', 'x1', revisionOf(file, 'x')))),
    watch(app.services.submitTurn(submit('y', 'y1', revisionOf(file, 'y')))),
    watch(otherWindow.transaction(draft => { draft.conversations.find(c => c.id === 'x')!.title = 'renamed in window two'; })),
    watch(otherWindow.transaction(draft => { draft.conversations.find(c => c.id === 'y')!.title = 'also renamed'; }))
  ]);
  await until(() => read(file).conversations.every(c => c.turns.length && c.turns.every(turn => turn.state === 'completed')), 'both turns complete');
  await app.services.submitTurn(submit('x', 'x2', revisionOf(file, 'x')));
  await until(() => read(file).conversations[0].turns.length === 2 && read(file).conversations[0].turns[1].state === 'completed', 'second x turn');
  const after = read(file);
  const x = after.conversations.find(c => c.id === 'x')!, y = after.conversations.find(c => c.id === 'y')!;
  assert.deepEqual(x.commandReceipts.map(r => r.commandId), ['x1', 'x2']);
  assert.deepEqual(y.commandReceipts.map(r => r.commandId), ['y1']);
  assert.equal(x.turns[0].id, (results[0] as { turnId: string }).turnId);
  assert.equal(y.turns[0].id, (results[1] as { turnId: string }).turnId);
  assert.equal(x.title, 'renamed in window two'); assert.equal(y.title, 'also renamed');
  assert.deepEqual(x.messages.map(m => m.sequence), x.messages.map((_, i) => i + 1));
  assert.equal(new Set(revisions).size, revisions.length, 'each accepted commit has its own revision');
  for (const conv of [x, y]) for (const r of conv.commandReceipts) assert.ok(r.revision <= conv.revision);
});

test('simultaneous sends to one chat on the file repository produce distinct FIFO turns and one turn per repeated command', async t => {
  const file = profile(t);
  const app = await ready(file, async params => ({ text: `reply to ${params.turn.id}` }), 'x');
  const revision = revisionOf(file, 'x');
  const [first, second, repeat] = await Promise.all([
    app.services.submitTurn(submit('x', 'x1', revision)),
    app.services.submitTurn(submit('x', 'x2', revision)),
    app.services.submitTurn(submit('x', 'x1', revision))
  ]) as { turnId: string }[];
  assert.notEqual(first.turnId, second.turnId);
  assert.equal(repeat.turnId, first.turnId, 'a repeated command converges on its original turn');
  await until(() => read(file).conversations[0].turns.length === 2 && read(file).conversations[0].turns.every(turn => turn.state === 'completed'), 'both turns complete');
  const x = read(file).conversations[0];
  assert.deepEqual(x.commandReceipts.map(r => r.commandId), ['x1', 'x2']);
  assert.deepEqual(x.turns.map(turn => turn.id), [first.turnId, second.turnId]);
  assert.deepEqual(x.messages.map(m => m.sequence), x.messages.map((_, i) => i + 1));
  assert.deepEqual(app.calls.map(call => call.turn.id), [first.turnId, second.turnId], 'provider calls follow acceptance order');
  assert.equal(app.updates.filter(u => u.type === 'turn_accepted' && u.turnId === first.turnId).length, 1);
});

test('startup recovery keeps an outcome_unknown attempt blocked: no provider runs and a later queued turn in the same chat waits', async t => {
  const file = profile(t);
  const first = launch(file, () => new Promise(() => undefined));
  await first.services.activate();
  await first.services.repository().transaction(draft => { draft.conversations.push(conversation('blocked')); });
  await first.services.submitTurn(submit('blocked', 'mid-reply'));
  await until(() => read(file).conversations[0].turns[0]?.attempts[0]?.state === 'dispatching', 'dispatch');
  const bytes = read(file);
  const chat = bytes.conversations[0];
  chat.turns.push({ ...structuredClone(chat.turns[0]), id: 'later-turn', commandId: 'later', userMessageId: 'later-message', state: 'queued', attempts: [] });
  fs.writeFileSync(file, JSON.stringify(bytes));

  const second = launch(file, async () => ({ text: 'unexpected' }));
  assert.equal(await second.services.recoverOnStartup(), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  const after = read(file).conversations[0];
  assert.equal(second.calls.length, 0, 'no provider is invoked after recovery');
  assert.equal(after.turns[0].attempts[0].state, 'outcome_unknown');
  assert.equal(after.turns[1].state, 'queued', 'later work stays blocked behind the uncertain attempt');
  assert.equal(after.turns[1].attempts.length, 0);
});

test('startup restores a pending approval on its own attempt only for a live matching runtime request', async t => {
  for (const live of [true, false]) {
    const file = profile(t);
    const first = new Promise<void>(() => undefined);
    const crashed = launch(file, async params => { await params.onAccepted!(); await params.onApproval!({ runtimeRequestId: 'session-1:permission:1' }); return first as never; });
    await crashed.services.activate();
    await crashed.services.repository().transaction(draft => { draft.conversations.push(conversation('approval')); });
    await crashed.services.submitTurn(submit('approval', 'needs-approval'));
    await until(() => read(file).conversations[0].turns[0]?.attempts[0]?.state === 'awaiting_approval', 'persisted approval');
    const originalAttempt = read(file).conversations[0].turns[0].attempts[0].id;

    const updates: string[] = [];
    const calls: string[] = [];
    const services = createTeamChatServices({ filePath: () => file, enabled: true, createCoordinator: repository => new TeamChatCoordinator({
      repository, idSource: () => 'epoch-after-restart', onUpdate: update => updates.push(update.type),
      executionAdapter: { execute: async params => { calls.push(params.attempt.id); return { text: 'never' }; },
        listLiveApprovals: async attempt => live ? [{ requestId: 'session-1:permission:1', attemptId: attempt.id }] : [] } }) });
    assert.equal(await services.recoverOnStartup(), true);
    const attempts = read(file).conversations[0].turns[0].attempts;
    assert.equal(attempts.length, 1, 'the approval is never transferred to a new attempt');
    assert.equal(attempts[0].id, originalAttempt);
    assert.equal(attempts[0].pendingApproval?.status, live ? 'restored' : 'invalidated');
    assert.equal(updates.includes('approval_restored'), live);
    assert.equal(calls.length, 0);
  }
});
