import test from 'node:test';
import assert from 'node:assert/strict';
import type { PageAssistantContext } from '@praxis/core';
import { buildSubmitCommand, type SubmitCommandInput } from '../src/assistant/assistantSubmitCommand.ts';

/* TASK-484 AC-C / AC-D: one send is one fenced command carrying exactly what was captured. */

const issue: PageAssistantContext = { pageType: 'issue', title: 'Issue TEAM-12', summary: 'A ticket', projectId: 'p1', issueKey: 'TEAM-12', entityId: 'TEAM-12' };

function input(overrides: Partial<SubmitCommandInput> = {}): SubmitCommandInput {
  return {
    conversationId: 'chat-1', commandId: 'cmd-1', expectedRevision: 4, text: 'Review this',
    members: ['dev'], attachmentRefs: [], context: issue, runtimeOptions: {}, ...overrides
  };
}

test('a detached context submits one message with no context field at all', () => {
  const command = buildSubmitCommand(input({ context: undefined }));
  assert.equal('context' in command, false);
  assert.equal(command.text, 'Review this');
  assert.equal(command.commandId, 'cmd-1');
});

test('an attached context is captured as a copy navigation cannot change', () => {
  const live = structuredClone(issue);
  const command = buildSubmitCommand(input({ context: live }));
  live.issueKey = 'TEAM-99';
  live.title = 'Issue TEAM-99';
  assert.deepEqual(command.context, issue);
});

test('a mention travels verbatim so core can route it to that member', () => {
  const command = buildSubmitCommand(input({ text: '@qa can you check the edge cases?', members: ['dev', 'qa'] }));
  assert.equal(command.text, '@qa can you check the edge cases?');
  assert.deepEqual(command.selectedParticipantIds, ['part-dev', 'part-qa']);
});

test('the command targets the captured conversation and revision', () => {
  const command = buildSubmitCommand(input({ conversationId: 'chat-7', expectedRevision: 12 }));
  assert.equal(command.conversationId, 'chat-7');
  assert.equal(command.expectedRevision, 12);
});

test('staged attachment refs are carried and copied, not aliased', () => {
  const refs = [{ id: 'att-1', mediaType: 'image/png', name: 'a.png' }] as unknown as SubmitCommandInput['attachmentRefs'];
  const command = buildSubmitCommand(input({ attachmentRefs: refs }));
  assert.deepEqual(command.attachmentRefs, refs);
  assert.notEqual(command.attachmentRefs, refs);
});

test('only string runtime options cross the bridge', () => {
  const command = buildSubmitCommand(input({ runtimeOptions: { provider: 'openai', model: 'm', count: 3, flag: true, missing: undefined } }));
  assert.deepEqual(command.runtimeOptions, { provider: 'openai', model: 'm' });
});
