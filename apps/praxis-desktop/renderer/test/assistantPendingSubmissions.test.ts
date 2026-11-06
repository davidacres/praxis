import test from 'node:test';
import assert from 'node:assert/strict';
import type { PageAssistantContext, SubmitConversationCommand } from '@praxis/core';
import { PendingSubmissions } from '../src/assistant/assistantPendingSubmissions.ts';

/* TASK-484 AC-D: a queued submission keeps its captured context and attachments; navigation cannot redirect it. */

const context: PageAssistantContext = { pageType: 'issue', title: 'Issue TEAM-12', summary: 'A ticket', projectId: 'p1', issueKey: 'TEAM-12', entityId: 'TEAM-12' };

const command = (overrides: Partial<SubmitConversationCommand> = {}): SubmitConversationCommand => ({
  conversationId: 'conv-a',
  commandId: 'cmd-1',
  expectedRevision: 4,
  text: 'Explain the failure',
  selectedParticipantIds: ['part-dev'],
  attachmentRefs: [{ id: 'att-1', digest: 'sha256:abc', mediaType: 'image/png', size: 1024 }],
  context,
  runtimeOptions: { toolMode: 'read-only', workingDirectory: '/tmp/work' },
  ...overrides
} as SubmitConversationCommand);

test('a recorded submission is found by its own conversation, not by whatever is open now', () => {
  const pending = new PendingSubmissions();
  const first = command();
  pending.record(first, true);
  assert.equal(pending.get('conv-a', 'Explain the failure'), first);
  // The panel navigated to another chat: the pending command still carries its own conversation id.
  assert.equal(pending.get('conv-b', 'Explain the failure'), undefined);
  assert.equal(pending.get('conv-a', 'A different message'), undefined);
  assert.equal(pending.list().length, 1);
  assert.equal(pending.size, 1);
  // Re-issuing it (a transport retry) reuses the same command identity and payload, so main
  // recognises the duplicate command id rather than accepting a second turn.
  assert.equal(pending.get('conv-a', 'Explain the failure')!.commandId, 'cmd-1');
  assert.deepEqual(pending.get('conv-a', 'Explain the failure')!.attachmentRefs, first.attachmentRefs);
  assert.deepEqual(pending.get('conv-a', 'Explain the failure')!.context, context);
});

test('attachments are staged once: a retry reuses the refs the first attempt wrote', () => {
  const pending = new PendingSubmissions();
  assert.equal(pending.hasStagedAttachments('conv-a', 'Explain the failure'), false);
  pending.record(command(), true);
  assert.equal(pending.hasStagedAttachments('conv-a', 'Explain the failure'), true);
  // A text-only submission never claims staged attachments.
  pending.record(command({ conversationId: 'conv-c', text: 'No images', attachmentRefs: [] }), false);
  assert.equal(pending.hasStagedAttachments('conv-c', 'No images'), false);
});

test('two conversations can hold a submission each, keyed independently', () => {
  const pending = new PendingSubmissions();
  pending.record(command(), true);
  pending.record(command({ conversationId: 'conv-b', commandId: 'cmd-2', text: 'Second chat', attachmentRefs: [] }), false);
  assert.equal(pending.size, 2);
  assert.deepEqual(pending.list().map(entry => entry.conversationId), ['conv-a', 'conv-b']);
});

test('acknowledging clears only that submission', () => {
  const pending = new PendingSubmissions();
  pending.record(command(), true);
  pending.record(command({ conversationId: 'conv-b', text: 'Still in flight', attachmentRefs: [] }), false);
  pending.acknowledge('conv-a', 'Explain the failure');
  assert.equal(pending.get('conv-a', 'Explain the failure'), undefined);
  assert.equal(pending.size, 1);
  assert.equal(pending.list()[0].conversationId, 'conv-b');
});

test('deleting a conversation drops only its own pending submissions', () => {
  const pending = new PendingSubmissions();
  pending.record(command(), true);
  pending.record(command({ conversationId: 'conv-a', text: 'Another message in the same chat', attachmentRefs: [] }), false);
  pending.record(command({ conversationId: 'conv-b', text: 'Untouched', attachmentRefs: [] }), false);
  pending.dropConversation('conv-a');
  assert.equal(pending.size, 1);
  assert.deepEqual(pending.list().map(entry => [entry.conversationId, entry.text]), [['conv-b', 'Untouched']]);
});

test('a conversation id that is a prefix of another never matches it', () => {
  const pending = new PendingSubmissions();
  pending.record(command({ conversationId: 'conv', text: 'x', attachmentRefs: [] }), false);
  pending.record(command({ conversationId: 'conv-long', text: 'y', attachmentRefs: [] }), false);
  pending.dropConversation('conv');
  assert.deepEqual(pending.list().map(entry => entry.conversationId), ['conv-long']);
});
