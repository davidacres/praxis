import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiSessionManager } from './aiSessionManager';
import type { KeyValueStore } from '../host/stateStore';

function storeWith(agentSessions: Record<string, unknown>): KeyValueStore {
  const data: Record<string, unknown> = { 'praxis.agentSessions': agentSessions };
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => { data[key] = value; }
  };
}

const baseRecord = (state: string) => ({
  issueKey: 'SESSION-abc',
  sessionId: 's1',
  state,
  taskDefinition: { kind: 'chat', goal: 'do a thing', scope: '', definitionOfDone: '' },
  events: [{ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_start', summary: 'started' }],
  stepCount: 1,
  startedAt: '2026-01-01T00:00:00.000Z'
});

test('an interrupted session is settled to aborted on load', () => {
  for (const state of ['planning', 'executing', 'awaiting_approval', 'awaiting_input']) {
    const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord(state) }));
    const loaded = mgr.getAgentSession('SESSION-abc');
    assert.equal(loaded?.state, 'aborted', `state ${state} should load as aborted`);
    assert.ok(loaded?.completedAt, 'completedAt is stamped');
    assert.equal(
      loaded?.events.at(-1)?.summary,
      'Session interrupted by an app restart'
    );
  }
});

test('a terminal or idle session loads unchanged', () => {
  for (const state of ['completed', 'failed', 'aborted', 'paused', 'not_started']) {
    const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord(state) }));
    assert.equal(mgr.getAgentSession('SESSION-abc')?.state, state);
    assert.equal(mgr.getAgentSession('SESSION-abc')?.events.length, 1, `${state}: no extra event`);
  }
});

test('updateAgentRuntime persists Agent Hub attribution', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('not_started') }));
  mgr.updateAgentRuntime('SESSION-abc', { agentId: 'praxis-reviewer', activeSkills: ['code-audit'] });
  const record = mgr.getAgentSession('SESSION-abc');
  assert.equal(record?.agentId, 'praxis-reviewer');
  assert.deepEqual(record?.activeSkills, ['code-audit']);

  mgr.updateAgentRuntime('SESSION-abc', { activeSkills: [] });
  assert.equal(mgr.getAgentSession('SESSION-abc')?.activeSkills, undefined);
});

test('token usage accumulates across a session\'s turns', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  // A session with tools makes several model calls; each reports its own usage.
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 900, outputTokens: 50, totalTokens: 950 });
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 });

  assert.deepEqual(mgr.getAgentSession('SESSION-abc')?.tokenUsage, {
    inputTokens: 2100,
    outputTokens: 130,
    totalTokens: 2230
  });
});

test('a session with no reported usage keeps tokenUsage unset', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  // Nothing reported means nothing shown — a zero would read as "this was free".
  assert.equal(mgr.getAgentSession('SESSION-abc')?.tokenUsage, undefined);
});

test('a provider reporting only some fields does not invent the others', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  mgr.addAgentTokenUsage('SESSION-abc', { outputTokens: 42 });

  const usage = mgr.getAgentSession('SESSION-abc')?.tokenUsage;
  assert.equal(usage?.outputTokens, 42);
  assert.equal(usage?.inputTokens, undefined, 'an unreported input count stays unreported');
});
