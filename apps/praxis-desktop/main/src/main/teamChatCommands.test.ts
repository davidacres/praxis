import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamChatCoordinator, makeParticipant, type ConversationUpdate, type DurableConversation, type SubmitConversationCommand, type TeamChatExecutionParams } from '@praxis/core';
import { createTeamChatServices } from './teamChatServices';
import { createTeamChatCommands } from './teamChatCommands';
import { TeamChatAttachments } from './teamChatAttachments';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A temporary profile: chat file, attachment store and a scripted provider. */
function profile(t: { after(fn: () => void): void }, execute: (params: TeamChatExecutionParams) => Promise<{ text: string }> = async () => ({ text: 'reply' })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chat-commands-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'team-chats.json');
  const calls: TeamChatExecutionParams[] = [];
  /** Each open window's listener; main broadcasts to whichever are still open. */
  const windows = new Map<string, ConversationUpdate[]>();
  let id = 0;
  const services = createTeamChatServices({ filePath: () => file, enabled: true, createCoordinator: repository => new TeamChatCoordinator({
    repository, idSource: () => `id-${++id}`,
    onUpdate: update => { for (const received of windows.values()) received.push(update); },
    executionAdapter: { execute: async params => { calls.push(params); return execute(params); } } }) });
  const attachments = new TeamChatAttachments(path.join(directory, 'team-chat-attachments'));
  const projects = new Set(['project-a', 'project-b']);
  const commands = createTeamChatCommands({ services, attachments: () => attachments, projectExists: p => projects.has(p),
    activeProvider: () => 'claude-code', assertCanRunAgentSession: () => undefined });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { conversations: DurableConversation[] };
  return { services, commands, attachments, projects, calls, windows, read };
}
async function seed(app: ReturnType<typeof profile>, projectId: string | undefined, conversationId = 'c'): Promise<void> {
  await app.services.activate();
  await app.services.repository().transaction(draft => {
    draft.conversations.push({ schemaVersion: 2, id: conversationId, ...(projectId !== undefined ? { projectId } : {}), title: 'Chat', createdAt: 'now', updatedAt: 'now',
      revision: 1, coordinatorEpoch: 'e', participants: [makeParticipant('lead'), makeParticipant('dev')], messages: [], turns: [], bindings: [],
      summaries: [], pinnedMessageIds: [], commandReceipts: [] });
  });
  await app.services.coordinator().initialize();
}
const submit = (commandId: string, extra: Partial<SubmitConversationCommand> = {}): SubmitConversationCommand => ({ conversationId: 'c', commandId,
  expectedRevision: 1, text: `${commandId} text`, selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {}, ...extra });
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}.`);
}
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; }

test('TASK-479 AC1: a lost IPC acknowledgement after durable acceptance, then resubmission of the same command ID, returns the original turn', async t => {
  const reply = gate();
  const app = profile(t, async () => { await reply.wait; return { text: 'reply' }; });
  await seed(app, 'project-a');
  const command = submit('cmd-lost-ack');
  // The renderer's invoke times out; main has already committed the turn and started the reply.
  void app.commands.submitTurn(command);
  await until(() => app.calls.length === 1, 'dispatch');
  const accepted = app.read().conversations[0].turns[0].id;
  const again = await app.commands.submitTurn(command);
  assert.equal(again.turnId, accepted, 'resubmission returns the original turn ID');
  reply.open();
  await until(() => app.read().conversations[0].turns[0].state === 'completed', 'completion');
  const after = app.read().conversations[0];
  assert.equal(after.turns.length, 1, 'one turn on disk');
  assert.equal(after.messages.filter(m => m.role === 'user').length, 1, 'one user message on disk');
  assert.equal(app.calls.length, 1, 'one provider call');
});

test('TASK-479 AC3: invalid participant, project, page context, attachment and permission are rejected before provider invocation', async t => {
  const app = profile(t);
  await seed(app, 'project-a');
  const [staged] = await app.attachments.stage('c', [{ mimeType: 'image/png', dataBase64: PNG }]);
  const imageRuntime = { mode: 'chat', toolMode: 'full' };
  const cases: [string, SubmitConversationCommand, RegExp][] = [
    ['unknown participant', submit('p', { selectedParticipantIds: ['part-ghost'] }), /Invalid participant reference/],
    ['context from another project', submit('ctx', { context: { pageType: 'issue', title: 'B-1', summary: '', projectId: 'project-b' } }), /different project/],
    ['unknown attachment digest', submit('att', { attachmentRefs: [{ ...staged, id: 'f'.repeat(64), digest: 'f'.repeat(64) }], runtimeOptions: imageRuntime }), /Unknown attachment reference/],
    ['malformed attachment digest', submit('att-bad', { attachmentRefs: [{ ...staged, digest: '../escape' }], runtimeOptions: imageRuntime }), /Unknown attachment reference/],
    ['tampered attachment size', submit('att-size', { attachmentRefs: [{ ...staged, size: staged.size + 1 }], runtimeOptions: imageRuntime }), /integrity/],
    ['invalid permission choice', submit('perm', { runtimeOptions: { permissionMode: 'everything' } }), /Invalid permission choice/],
    ['unknown conversation', submit('conv', { conversationId: 'missing' }), /not found/]
  ];
  for (const [label, command, expected] of cases) await assert.rejects(app.commands.submitTurn(command), expected, label);
  // A project deleted after the chat was created.
  app.projects.delete('project-a');
  await assert.rejects(app.commands.submitTurn(submit('deleted')), /Project project-a was not found/, 'deleted project');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.calls.length, 0, 'no provider invocation');
  assert.equal(app.read().conversations[0].turns.length, 0, 'no turn on disk');
  assert.equal(app.read().conversations[0].commandReceipts.length, 0, 'no receipt on disk');
});

test('TASK-479 AC3: a projectless chat with a valid attachment and page context is accepted', async t => {
  const app = profile(t);
  await seed(app, '');
  const [staged] = await app.attachments.stage('c', [{ mimeType: 'image/png', dataBase64: PNG }]);
  await app.commands.submitTurn(submit('ok', { attachmentRefs: [staged], runtimeOptions: { mode: 'chat', toolMode: 'full' },
    context: { pageType: 'issue', title: 'A-1', summary: '', projectId: 'project-a' } }));
  const accepted = app.read().conversations[0];
  assert.equal(accepted.turns.length, 1, 'the turn is accepted');
  assert.deepEqual(accepted.messages[0].attachments, [staged], 'with its validated attachment reference');
});

test('TASK-479 AC3: a stale retry target is rejected as a conflict before provider invocation', async t => {
  let fail = true;
  const app = profile(t, async () => { if (fail) throw new Error('provider down'); return { text: 'reply' }; });
  await seed(app, 'project-a');
  const { turnId } = await app.commands.submitTurn(submit('first'));
  await until(() => app.read().conversations[0].turns[0].state === 'failed', 'failure');
  const failed = app.read().conversations[0];
  const attempt = failed.turns[0].attempts.at(-1)!;
  const before = app.calls.length;
  fail = false;
  const retry = { conversationId: 'c', commandId: 'r', expectedRevision: failed.revision, turnId, attemptId: attempt.id, participantId: attempt.participantId };

  for (const [label, stale, reason] of [
    ['stale revision', { ...retry, commandId: 'r1', expectedRevision: failed.revision - 1 }, 'stale-revision'],
    ['superseded attempt', { ...retry, commandId: 'r2', attemptId: 'attempt-old' }, 'stale-target'],
    ['wrong participant', { ...retry, commandId: 'r3', participantId: 'part-dev' }, 'stale-target']
  ] as const) {
    const outcome = await app.commands.retryParticipant(stale);
    assert.equal(outcome.status, 'conflict', label);
    assert.equal(outcome.status === 'conflict' && outcome.reason, reason, label);
    assert.equal(outcome.conversation.revision, failed.revision, `${label} returns fresh state`);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.calls.length, before, 'no stale retry dispatches');
  assert.equal(app.read().conversations[0].revision, failed.revision, 'no stale retry commits');

  assert.equal((await app.commands.retryParticipant(retry)).status, 'applied');
  await until(() => app.read().conversations[0].turns[0].state === 'completed', 'retry completion');
  assert.equal((await app.commands.retryParticipant(retry)).status, 'duplicate', 'a repeated command is a duplicate, not a second retry');
  assert.equal(app.calls.length, before + 1);
});

test('TASK-479 AC3: malformed control commands and unknown projects on create are rejected', async t => {
  const app = profile(t);
  await seed(app, 'project-a');
  const base = { conversationId: 'c', commandId: 'x', expectedRevision: 1, turnId: 't' };
  await assert.rejects(app.commands.cancelTurn({ ...base, commandId: '' }), /command ID/);
  await assert.rejects(app.commands.cancelTurn({ ...base, expectedRevision: 'one' as never }), /expected revision/);
  await assert.rejects(app.commands.retryParticipant({ ...base, attemptId: 'a', participantId: '' }), /participant ID/);
  await assert.rejects(app.commands.retryParticipant({ ...base, attemptId: '', participantId: 'p' }), /attempt ID/);
  await assert.rejects(app.commands.resolveAttempt({ ...base, attemptId: 'a', resolution: 'accept' as never }), /Unknown attempt resolution/);
  await assert.rejects(app.commands.resolveAttempt({ ...base, turnId: '', attemptId: 'a', resolution: 'reconcile' }), /turn ID/);
  await assert.rejects(app.commands.control({ ...base, commandId: '', action: 'pin', messageId: 'm' }), /command ID/);
  await assert.rejects(app.commands.control({ ...base, action: 'explode' as never }), /Unknown control action/);
  await assert.rejects(app.commands.control({ ...base, expectedRevision: 'one' as never, action: 'resume-context' }), /expected revision/);
  await assert.rejects(app.commands.control({ ...base, action: 'pin' }), /message ID/);
  await assert.rejects(app.commands.control({ ...base, turnId: '', action: 'cancel' }), /turn ID/);
  await assert.rejects(app.commands.createChat('project-gone'), /Project project-gone was not found/);
  assert.equal((await app.commands.createChat('')).projectId, '', 'a projectless chat may be created');
  assert.equal((await app.commands.createChat('project-a')).projectId, 'project-a');
});

test('TASK-479 AC4 (main): closing the initiating window does not cancel accepted work; another window observes it complete', async t => {
  const reply = gate();
  const app = profile(t, async () => { await reply.wait; return { text: 'finished after the window closed' }; });
  await seed(app, 'project-a');
  app.windows.set('initiator', []);
  app.windows.set('observer', []);
  const { turnId } = await app.commands.submitTurn(submit('from-initiator'));
  await until(() => app.calls.length === 1, 'dispatch');
  app.windows.delete('initiator');
  reply.open();
  const observed = app.windows.get('observer')!;
  await until(() => observed.some(u => u.type === 'turn_completed'), 'turn_completed broadcast');
  assert.equal(app.read().conversations[0].turns[0].state, 'completed', 'the turn was not cancelled');
  assert.ok(observed.some(u => u.type === 'attempt_completed' && u.turnId === turnId), 'observer sees attempt_completed');
  assert.ok(observed.some(u => u.type === 'turn_completed' && u.turnId === turnId), 'observer sees turn_completed');
  const snapshot = await app.commands.getConversation('c');
  assert.equal(snapshot!.messages.filter(m => m.text === 'finished after the window closed').length, 1);
});
