import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamChatCoordinator, makeParticipant, type DurableConversation, type SubmitConversationCommand, type TeamChatExecutionParams } from '@praxis/core';
import { createTeamChatServices } from './teamChatServices';

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
  let epoch = 0;
  const prefix = `process-${Math.random().toString(36).slice(2, 8)}`;
  const services = createTeamChatServices({ filePath: () => file, enabled, createCoordinator: repository => new TeamChatCoordinator({
    repository, idSource: () => `${prefix}-${++epoch}`, executionAdapter: { execute: async params => { calls.push(params); return execute(params); } } }) });
  return { services, calls };
}
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { conversations: DurableConversation[] };

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
