import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileModelCatalog, MobileProviderCatalog } from '@praxis/core';
import { availableProviderOptions, effectiveSelection, modelLabel, selectionPayload, validateSelection } from './mobileSessionOptions';

const catalog: MobileProviderCatalog = {
  defaultProvider: 'openai',
  providers: [
    { provider: 'openai', label: 'OpenAI', kind: 'api', available: false, unavailableReason: 'not-configured', unavailableMessage: 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.' },
    { provider: 'anthropic', label: 'Anthropic', kind: 'api', available: true, defaultModel: 'claude-sonnet-4-6' },
    { provider: 'codex-cli', label: 'Codex CLI (local)', kind: 'cli-agent', available: true },
  ],
  sessionModes: [
    { mode: 'chat', available: true, toolAccess: 'full' },
    { mode: 'analysis', available: false, toolAccess: 'read-only', unavailableMessage: 'Set an analysis system prompt under Settings → AI Provider on the desktop first.' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
  ],
};
const anthropicModels: MobileModelCatalog = {
  provider: 'anthropic', status: 'ok', defaultModel: 'claude-sonnet-4-6',
  models: [{ modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
};

test('provider picker choices contain only configured and enabled providers', () => {
  assert.deepEqual(availableProviderOptions(catalog).map(option => option.provider), ['anthropic', 'codex-cli']);
});

test('an unavailable desktop default falls through to the first available provider', () => {
  const selection = effectiveSelection(catalog, { mode: 'chat' });
  assert.equal(selection.provider, 'anthropic');
  assert.deepEqual(validateSelection(catalog, selection), { ok: true });
});

test('an unavailable provider cannot be selected, and says why', () => {
  const forced = effectiveSelection(catalog, { provider: 'openai', mode: 'chat' });
  assert.equal(forced.provider, 'anthropic', 'the phone never sends an unavailable provider');
  assert.deepEqual(validateSelection(catalog, { provider: 'openai', mode: 'chat' }), { ok: false, message: 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.' });
});

test('provider A + model A reach the create payload; a model from another provider is dropped', () => {
  const chosen = effectiveSelection(catalog, { provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review' }, anthropicModels);
  assert.deepEqual(selectionPayload(chosen), { provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review' });
  const stale = effectiveSelection(catalog, { provider: 'anthropic', model: 'gpt-5.5', mode: 'chat' }, anthropicModels);
  assert.equal(stale.model, undefined);
  assert.equal(validateSelection(catalog, { provider: 'anthropic', model: 'gpt-5.5', mode: 'chat' }, anthropicModels).ok, false);
});

test('an unavailable mode is refused with the desktop reason and not silently sent', () => {
  assert.equal(effectiveSelection(catalog, { provider: 'anthropic', mode: 'analysis' }).mode, 'chat');
  assert.deepEqual(validateSelection(catalog, { provider: 'anthropic', mode: 'analysis' }), { ok: false, message: 'Set an analysis system prompt under Settings → AI Provider on the desktop first.' });
});

test('model labels name the default the desktop will actually use', () => {
  assert.equal(modelLabel(anthropicModels, undefined), 'Default (Claude Sonnet 4.6)');
  assert.equal(modelLabel(anthropicModels, 'claude-opus-4-6'), 'Claude Opus 4.6');
  assert.equal(modelLabel(undefined, undefined), 'Provider default');
});

test('an older desktop without a catalog is not blocked', () => {
  assert.deepEqual(validateSelection(undefined, { mode: 'chat' }), { ok: true });
});
