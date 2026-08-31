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
