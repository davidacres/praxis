import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiSettings, ProviderUsageSnapshot } from '@praxis/core';
import { enabledUsageProviders, readProviderSnapshots } from './providerUsageBatch';

function snapshot(provider: string, unavailableReason?: string): ProviderUsageSnapshot {
  return {
    provider: provider as ProviderUsageSnapshot['provider'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    windows: [],
    unavailableReason
  };
}

const AI_SETTINGS = {
  providers: {
    openai: {},
    anthropic: { enabled: false },
    'codex-cli': { enabled: true }
  },
  customProviders: [
    { id: 'custom:minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.test', addedAt: '2026-01-01' },
    { id: 'custom:ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', addedAt: '2026-01-01' }
  ]
} as unknown as Pick<AiSettings, 'providers' | 'customProviders'>;

test('every provider the user has not turned off is reported on', () => {
  const providers = enabledUsageProviders(AI_SETTINGS);
  // anthropic is explicitly disabled, so it drops out; an unset `enabled`
  // (openai) does not, matching AiProviderConfig's documented default.
  assert.ok(providers.includes('openai'));
  assert.ok(providers.includes('codex-cli'));
  assert.ok(providers.includes('custom:minimax'));
  assert.ok(providers.includes('custom:ollama'));
  assert.ok(!providers.includes('anthropic'));
});

test('a custom endpoint listed in both places appears once', () => {
  const providers = enabledUsageProviders({
    providers: { 'custom:minimax': {} },
    customProviders: [{ id: 'custom:minimax', label: 'MiniMax', baseUrl: 'https://x.test', addedAt: '2026-01-01' }]
  } as unknown as Pick<AiSettings, 'providers' | 'customProviders'>);
  assert.equal(providers.filter(id => id === 'custom:minimax').length, 1);
});

test('disabling a custom endpoint removes it too', () => {
  const providers = enabledUsageProviders({
    providers: { 'custom:minimax': { enabled: false } },
    customProviders: [{ id: 'custom:minimax', label: 'MiniMax', baseUrl: 'https://x.test', addedAt: '2026-01-01' }]
  } as unknown as Pick<AiSettings, 'providers' | 'customProviders'>);
  assert.deepEqual(providers, []);
});

test('settings with no providers and no custom endpoints yield none', () => {
  assert.deepEqual(enabledUsageProviders({ providers: {} }), []);
});

test('one provider failing does not lose the others', async () => {
  // A rejecting adapter is the normal case, not an edge case: the Codex adapter
  // spawns a CLI process and a custom endpoint can reject its key. The other
  // providers' budgets must survive it.
  const result = await readProviderSnapshots(['codex-cli', 'custom:minimax', 'openai'], async provider => {
    if (provider === 'codex-cli') throw new Error('Codex CLI not found on PATH');
    return snapshot(provider, 'no usage API');
  });
  assert.equal(result.snapshots.length, 3);
  assert.equal(result.snapshots[0].unavailableReason, 'Codex CLI not found on PATH');
  assert.equal(result.snapshots[0].windows.length, 0);
  assert.equal(result.snapshots[1].unavailableReason, 'no usage API');
  assert.equal(result.snapshots[2].unavailableReason, 'no usage API');
});

test('snapshots stay aligned with the providers that were requested', async () => {
  const result = await readProviderSnapshots(['codex-cli', 'openai'], async provider => {
    if (provider === 'openai') throw new Error('boom');
    return { provider, fetchedAt: '2026-01-01T00:00:00.000Z', windows: [{ period: 'week', usedPercent: 62 }] };
  });
  // Index 0 succeeded and index 1 failed, so a shifted result would attribute
  // the wrong windows to the wrong provider.
  assert.equal(result.snapshots[0].provider, 'codex-cli');
  assert.equal(result.snapshots[0].windows[0].usedPercent, 62);
  assert.equal(result.snapshots[1].provider, 'openai');
  assert.equal(result.snapshots[1].unavailableReason, 'boom');
});

test('a non-Error rejection still becomes a readable reason', async () => {
  const result = await readProviderSnapshots(['openai'], async () => { throw 'just a string'; });
  assert.equal(result.snapshots[0].unavailableReason, 'This provider did not respond.');
});

test('no providers is a valid, empty batch', async () => {
  const result = await readProviderSnapshots([], async () => snapshot('openai'));
  assert.deepEqual(result.snapshots, []);
  assert.ok(result.checkedAt);
});
