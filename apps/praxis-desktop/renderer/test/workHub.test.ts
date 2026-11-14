import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionRecord, ScheduledRunView, WorkflowRunSummary } from '@praxis/core';
import { attentionItems, matchingExcerpt, pendingDecisionQuestions } from '../src/app/workHubModel.ts';
import { sessionCommandEvidence } from '../src/ai/sessionReviewModel.ts';

const session = (patch: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({ issueKey: 'SESSION-review', sessionId: 'review', taskDefinition: { goal: 'Review the patch' }, state: 'completed', events: [], stepCount: 0, startedAt: '2026-11-14T12:00:00Z', ...patch } as AgentSessionRecord);

test('attention includes actionable states and excludes settled and archived work', () => {
  const states = ['awaiting_input', 'awaiting_approval', 'failed', 'paused', 'completed', 'executing', 'aborted'] as const;
  const values = states.map(state => session({ issueKey: state, state }));
  const items = attentionItems([...values, session({ state: 'failed', archived: true }), session({ issueKey: 'interrupted', state: 'aborted', interruptedByRestart: true })], [], []);
  assert.deepEqual(items.map(item => item.target), ['awaiting_input', 'awaiting_approval', 'failed', 'paused', 'interrupted']);
  assert.equal(items[0].action, 'Answer question');
  assert.equal(items[1].action, 'Review request');
});

test('workflow decisions and missed schedules remain visible without claiming failure', () => {
  const run = { runId: 'run', projectId: 'project', workflowName: 'Delivery', status: 'running', explanation: 'Budget exhausted', needsDecision: { edgeId: 'edge', message: 'Grant another iteration' } } as WorkflowRunSummary;
  const schedule = { run: { id: 'night', name: 'Night run', projectId: 'project', status: 'missed' } } as ScheduledRunView;
  const items = attentionItems([], [run, { ...run, archived: true }], [schedule]);
  assert.equal(items.length, 2);
  assert.equal(items[0].reason, 'Grant another iteration');
  assert.equal(items[1].action, 'Resolve missed start');
});

test('search excerpts preserve deep matches and reject nonmatching content', () => {
  const text = `${'before '.repeat(500)}UniqueNeedle${' after'.repeat(500)}`;
  assert.match(matchingExcerpt(text, 'uniqueneedle')!, /UniqueNeedle/);
  assert.ok(matchingExcerpt(text, 'uniqueneedle')!.length < 300);
  assert.equal(matchingExcerpt(text, 'absent'), undefined);
});

test('command evidence distinguishes exit status from unknown and ignores narrative claims', () => {
  const record = session({ events: [
    { type: 'message', timestamp: '1', summary: 'All tests passed' },
    { type: 'tool_start', timestamp: '2', summary: 'npm test', data: { kind: 'shell' } },
    { type: 'tool_complete', timestamp: '3', summary: 'npm test', data: { kind: 'shell', exitCode: 1, output: '1 failure' } },
    { type: 'tool_complete', timestamp: '4', summary: 'npm run build', data: { kind: 'shell', exitCode: 0 } },
    { type: 'tool_complete', timestamp: '5', summary: 'npm test', data: { kind: 'shell', ok: true } },
    { type: 'tool_complete', timestamp: '6', summary: 'read file', data: { kind: 'read', ok: true } }
  ] });
  assert.deepEqual(sessionCommandEvidence(record).map(item => item.outcome), ['Failed', 'Succeeded', 'Outcome unreported']);
  assert.equal(sessionCommandEvidence(record)[0].output, '1 failure');
});


test('unanswered choices survive a finished turn, while answered and revoked choices disappear', () => {
  const block = (state: string, kind = 'choice') => ({ type: 'gadget', gadget: { kind, state, actions: [{ effect: 'informational' }], payload: { question: 'Which approach?' } } });
  assert.deepEqual(pendingDecisionQuestions([block('active'), block('completed'), block('superseded'), block('revoked'), block('active', 'image')] as never), ['Which approach?']);
});
