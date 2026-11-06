import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionRecord, TeamChatSummary } from '@praxis/core';
import { dedupeTeamChats, isAssistantOwnedSession, visibleSessions } from '../src/ai/assistantOwnership.ts';
import { isConversationSession, isTicketReviewKey, isWorkflowStageSession } from '../src/ai/sessionNav.ts';

/*
 * TASK-484 AC-B: Classic and Easy Mode show one team-chat row and exclude typed internal
 * executions, while standalone chats stay visible. One classifier, table-driven.
 */

const session = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  issueKey: 'SESSION-a1b2c3',
  sessionId: 'sess-a1b2c3',
  title: 'A standalone chat',
  state: 'completed',
  provider: 'vercel-gateway',
  startedAt: '2026-11-01T10:00:00.000Z',
  events: [],
  taskDefinition: { kind: 'general', goal: 'Chat' },
  ...overrides
} as unknown as AgentSessionRecord);

const rows: Array<[string, AgentSessionRecord, boolean]> = [
  ['a typed Virtual Team execution is assistant-owned', session({ issueKey: 'SESSION-tc1', teamChatExecution: { conversationId: 'conv-1', turnId: 't1', attemptId: 'a1', participantId: 'part-dev' } as never }), true],
  ['a legacy ASSISTANT- runtime record is still assistant-owned', session({ issueKey: 'ASSISTANT-dev-1' }), true],
  ['a standalone conversation stays visible', session(), false],
  ['a ticket session stays visible', session({ issueKey: 'TEAM-12', projectId: 'p1' }), false],
  ['a workflow stage session is not assistant-owned', session({ issueKey: 'WF-run-1-node-a', workflowRunId: 'run-1', workflowNodeId: 'node-a' }), false],
  ['a ticket review session is not assistant-owned', session({ issueKey: 'review~TEAM-12' }), false]
];

test('the shared classifier names exactly the assistant-owned sessions', () => {
  for (const [name, record, owned] of rows) {
    assert.equal(isAssistantOwnedSession(record), owned, name);
  }
});

test('visibleSessions removes only assistant-owned executions, on initial load and increments alike', () => {
  const all = rows.map(([, record]) => record);
  const visible = visibleSessions(all);
  assert.deepEqual(visible.map(record => record.issueKey), ['SESSION-a1b2c3', 'TEAM-12', 'WF-run-1-node-a', 'review~TEAM-12']);
  // An incremental push of an assistant-owned record yields nothing new to show.
  assert.deepEqual(visibleSessions([session({ issueKey: 'SESSION-tc2', teamChatExecution: { conversationId: 'conv-1' } as never })]), []);
  // ...and an incremental push of a standalone one is kept.
  assert.deepEqual(visibleSessions([session({ issueKey: 'SESSION-new1' })]).map(record => record.issueKey), ['SESSION-new1']);
});

test('the exclusion does not change what counts as a conversation, a workflow stage or a ticket review', () => {
  const standalone = session();
  const teamExecution = session({ issueKey: 'SESSION-tc1', teamChatExecution: { conversationId: 'conv-1' } as never });
  // Both are "conversations" by the pre-existing rule; only the assistant-owned one is hidden.
  assert.equal(isConversationSession(standalone), true);
  assert.equal(isConversationSession(teamExecution), true);
  assert.equal(visibleSessions([standalone, teamExecution]).filter(isConversationSession).length, 1);
  assert.equal(isWorkflowStageSession(session({ workflowRunId: 'run-1', workflowNodeId: 'n' })), true);
  assert.equal(isTicketReviewKey('review~TEAM-12'), true);
});

test('Easy Mode root-session filtering keeps standalone chats and hides internal executions', () => {
  // Mirrors `rootSessions` in EasyModeSidebar/EasyModeSessionsList: no parent, no workflow run.
  const roots = visibleSessions([
    session({ issueKey: 'SESSION-root1' }),
    session({ issueKey: 'SESSION-sub', parentSessionKey: 'SESSION-root1' }),
    session({ issueKey: 'WF-run-1-node-a', workflowRunId: 'run-1' }),
    session({ issueKey: 'SESSION-tc1', teamChatExecution: { conversationId: 'conv-1' } as never })
  ]).filter(record => !record.parentSessionKey && !record.workflowRunId);
  assert.deepEqual(roots.map(record => record.issueKey), ['SESSION-root1']);
});

const chat = (id: string, projectId: string): TeamChatSummary => ({
  id, projectId, title: `Chat ${id}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T11:00:00.000Z', messageCount: 2, personas: ['dev']
} as TeamChatSummary);

test('one team-chat row per conversation id, whichever feed listed it first', () => {
  const general = chat('c1', '');
  const project = { ...chat('c1', 'p1'), updatedAt: '2026-11-01T12:00:00.000Z' } as TeamChatSummary;
  const deduped = dedupeTeamChats([general, project, chat('c2', 'p1')]);
  assert.deepEqual(deduped.map(entry => [entry.id, entry.projectId]), [['c1', ''], ['c2', 'p1']]);
  assert.equal(deduped[0].updatedAt, general.updatedAt, 'the first listing wins');
});

test('an empty list stays empty and a single chat is unchanged', () => {
  assert.deepEqual(dedupeTeamChats([]), []);
  const one = [chat('c1', 'p1')];
  assert.deepEqual(dedupeTeamChats(one), one);
});
