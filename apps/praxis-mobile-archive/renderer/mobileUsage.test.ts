import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileSessionSnapshot, MobileSessionUsage } from '@praxis/core';
import { describeUsage, formatCost, formatTokenCount, latestUsage } from './mobileUsage';

const snapshot = (overrides: Partial<MobileSessionSnapshot> = {}): MobileSessionSnapshot => ({
  sessionId: 's1', sessionKey: 'SESSION-1', title: 'x', lifecycle: 'completed', mode: 'chat', archived: false,
  startedAt: '2026-09-23T09:00:00.000Z', sequence: 10, messages: [], pendingPermissions: [], canContinue: true, canCancel: false,
  provider: 'claude-code-cli', model: 'opus', ...overrides,
});

test('formats token counts and costs compactly', () => {
  assert.equal(formatTokenCount(950), '950');
  assert.equal(formatTokenCount(1_234), '1.2k');
  assert.equal(formatTokenCount(4_600_000), '4.6m');
  assert.equal(formatTokenCount(250_000), '250k');
  assert.equal(formatCost({ currency: 'USD', amount: 2.81 }), 'US$2.81');
  assert.equal(formatCost({ currency: 'USD', amount: 0.004 }), '<US$0.01');
  assert.equal(formatCost({ currency: 'eur', amount: 1.5 }), '1.50 EUR');
});

test('real provider, model, token and cost figures when the desktop reports them', () => {
  const view = describeUsage({
    source: latestUsage(snapshot({ tokenUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, contextTokens: 9000, contextLimit: 200000, cost: { currency: 'USD', amount: 0.42 } }), undefined),
    loading: false,
    providerLabel: 'Claude Code (local)',
  });
  assert.equal(view.state, 'ready');
  assert.equal(view.summary, 'opus · 1.5k tokens · US$0.42');
  assert.deepEqual(view.details.map(row => row.label), ['Provider', 'Model', 'Input tokens', 'Output tokens', 'Total tokens', 'Context', 'Cost']);
  assert.equal(view.details.find(row => row.label === 'Context')?.value, '9k of 200k');
});

test('a provider that reports no cost says so rather than showing zero', () => {
  const view = describeUsage({ source: latestUsage(snapshot({ provider: 'anthropic', model: 'claude-opus-4-6', tokenUsage: { totalTokens: 50 } }), undefined), loading: false, providerLabel: 'Anthropic' });
  assert.equal(view.costReported, false);
  assert.equal(view.cost, 'Cost not reported by Anthropic');
  assert.equal(view.summary, 'claude-opus-4-6 · 50 tokens · no cost data');
  assert.doesNotMatch(view.summary, /\$0/);
});

test('loading, absent and draft states are distinct', () => {
  assert.equal(describeUsage({ source: undefined, loading: true }).state, 'loading');
  const absent = describeUsage({ source: latestUsage(snapshot(), undefined), loading: false });
  assert.equal(absent.state, 'empty');
  assert.match(absent.summary, /no usage recorded yet/);
  const draft = describeUsage({ source: undefined, loading: false, draft: true, providerLabel: 'Anthropic' });
  assert.equal(draft.summary, 'Usage appears after the first reply.');
});

test('a streamed snapshot supersedes an older usage read and vice versa', () => {
  const read: MobileSessionUsage = { sessionId: 's1', lifecycle: 'completed', costStatus: 'not-reported', tokenUsage: { totalTokens: 100 }, sequence: 5, providerLabel: 'Codex CLI (local)' };
  const streamed = snapshot({ sequence: 9, tokenUsage: { totalTokens: 900 } });
  assert.equal(latestUsage(streamed, read)?.tokenUsage?.totalTokens, 900, 'usage updates after a streamed response');
  assert.equal(latestUsage(streamed, read)?.providerLabel, 'Codex CLI (local)');
  assert.equal(latestUsage(streamed, { ...read, sequence: 12, tokenUsage: { totalTokens: 1200 } })?.tokenUsage?.totalTokens, 1200);
});
