import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  customBaseUrlProblem,
  customHeaderNameProblem,
  customProviderIdFor,
  isCustomProviderId,
  isInsecureRemoteUrl,
  normalizeApiPath
} from './customProviders';
import { PROVIDER_PRESETS } from './providerPresets';
import { gatewayOptionsFor, getProviderDescriptor, listProviderIds, resolveProviderAdapter, setCustomProviders } from './registry';
import { openAiCompatibleAdapter } from './openAiCompatibleAdapter';
import { endpoint } from '../gateway/gatewayClient';
import { buildHeaders } from '../gateway/gatewayClient';
import { secretKeyForProvider } from '../providerSecrets';

test('custom ids are custom:<slug> and new ids never collide', () => {
  assert.equal(isCustomProviderId('custom:ollama-2'), true);
  assert.equal(isCustomProviderId('custom:'), false);
  assert.equal(isCustomProviderId('custom:Ollama'), false);
  assert.equal(isCustomProviderId('openai'), false);
  assert.equal(customProviderIdFor('Ollama · studio-mac', []), 'custom:ollama-studio-mac');
  assert.equal(customProviderIdFor('Ollama', ['custom:ollama', 'custom:ollama-2']), 'custom:ollama-3');
  assert.equal(customProviderIdFor('···', []), 'custom:endpoint');
});

test('header names that look like credentials or that the client owns are refused', () => {
  assert.equal(customHeaderNameProblem('HTTP-Referer'), undefined);
  assert.equal(customHeaderNameProblem('X-Title'), undefined);
  assert.match(customHeaderNameProblem('X-Api-Key') ?? '', /credential/);
  assert.match(customHeaderNameProblem('x-auth-token') ?? '', /credential/);
  assert.match(customHeaderNameProblem('Authorization') ?? '', /set by Praxis/);
  assert.match(customHeaderNameProblem('bad header') ?? '', /not a valid/);
});

test('base URLs must be http(s) without embedded credentials; plain http off-machine is flagged', () => {
  assert.equal(customBaseUrlProblem('http://localhost:11434'), undefined);
  assert.ok(customBaseUrlProblem('ftp://host'));
  assert.ok(customBaseUrlProblem('https://user:pass@host'));
  assert.ok(customBaseUrlProblem(''));
  assert.equal(isInsecureRemoteUrl('http://localhost:11434'), false);
  assert.equal(isInsecureRemoteUrl('http://127.0.0.1:8000'), false);
  assert.equal(isInsecureRemoteUrl('http://10.0.4.20:8000'), true);
  assert.equal(isInsecureRemoteUrl('https://10.0.4.20:8000'), false);
  assert.equal(normalizeApiPath('v1/'), '/v1');
  assert.equal(normalizeApiPath(' '), '');
});

test('presets have unique ids, parseable URLs and no credential-like headers', () => {
  const ids = PROVIDER_PRESETS.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of PROVIDER_PRESETS) {
    if (preset.id === 'custom') continue;
    assert.equal(customBaseUrlProblem(preset.baseUrl), undefined, preset.id);
    assert.equal(preset.keyRequired, preset.auth.kind !== 'none', preset.id);
  }
});

test('a registered endpoint resolves like a built-in and carries its wire options', () => {
  setCustomProviders([
    { id: 'custom:lab', label: 'Lab vLLM', protocol: 'openai-chat', baseUrl: 'http://10.0.0.2:8000', apiPath: '/v1', auth: { kind: 'header', name: 'api-key' }, headers: { 'X-Title': 'Praxis' }, streamUsage: false }
  ]);
  try {
    assert.equal(getProviderDescriptor('custom:lab').label, 'Lab vLLM');
    assert.equal(resolveProviderAdapter('custom:lab'), openAiCompatibleAdapter);
    assert.ok(listProviderIds().includes('custom:lab'));
    const opts = gatewayOptionsFor('custom:lab', undefined, 'secret-key');
    assert.equal(opts.url, 'http://10.0.0.2:8000');
    assert.equal(opts.streamUsage, false);
    assert.equal(opts.gatewayCaching, false);
    assert.equal(endpoint(opts, '/chat/completions'), 'http://10.0.0.2:8000/v1/chat/completions');
    const headers = buildHeaders(opts);
    assert.equal(headers['api-key'], 'secret-key');
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['X-Title'], 'Praxis');
    assert.equal(secretKeyForProvider('custom:lab'), 'praxis.customProvider.lab.apiKey');
    assert.throws(() => getProviderDescriptor('custom:gone'), /was removed/);
  } finally {
    setCustomProviders([]);
  }
});

test('an exact empty API path is joined as-is, with no /v1 guessing', () => {
  assert.equal(endpoint({ url: 'http://host:8080/', apiPath: '', exactPath: true }, '/models'), 'http://host:8080/models');
  assert.equal(endpoint({ url: 'http://host:8080' }, '/models'), 'http://host:8080/v1/models');
});

test('built-in options are unchanged except that only Vercel may send its caching hint', () => {
  assert.equal(gatewayOptionsFor('vercel-gateway', undefined, 'k').gatewayCaching, undefined);
  assert.equal(gatewayOptionsFor('openai', undefined, 'k').gatewayCaching, false);
  assert.equal(gatewayOptionsFor('z-ai', undefined, 'k').apiPath, '/api/coding/paas/v4');
  assert.equal(buildHeaders(gatewayOptionsFor('openai', undefined, 'k')).Authorization, 'Bearer k');
});


test('Bifrost uses virtual-key auth and unified reasoning without Vercel options', () => {
  const preset = PROVIDER_PRESETS.find(p => p.id === 'bifrost')!;
  assert.equal(preset.apiPath, '/openai');
  assert.deepEqual(preset.auth, { kind: 'header', name: 'x-bf-vk' });
  setCustomProviders([{
    id: 'custom:bifrost', label: 'Bifrost', presetId: 'bifrost', protocol: 'openai-chat',
    baseUrl: preset.baseUrl, apiPath: preset.apiPath, auth: preset.auth
  }]);
  try {
    const opts = gatewayOptionsFor('custom:bifrost', undefined, 'sk-bf-test');
    assert.equal(new URL(endpoint(opts, '/chat/completions')).pathname, '/openai/chat/completions');
    assert.equal(buildHeaders(opts)['x-bf-vk'], 'sk-bf-test');
    const adapter = resolveProviderAdapter('custom:bifrost');
    for (const modelId of ['openai/o3', 'anthropic/claude-sonnet-4.6', 'gemini/gemini-2.5-pro', 'team-alias']) {
      for (const reasoningEffort of ['low', 'medium', 'high'] as const) {
        const body = adapter.buildChatRequest({ modelId, messages: [], reasoningEffort }) as Record<string, unknown>;
        assert.deepEqual(body.reasoning, { effort: reasoningEffort });
        assert.equal(body.model, modelId);
        assert.equal(body.providerOptions, undefined);
        assert.equal(body.reasoning_effort, undefined);
      }
    }
    for (const reasoningEffort of [undefined, 'off'] as const) {
      const body = adapter.buildChatRequest({ modelId: 'team-alias', messages: [], reasoningEffort }) as Record<string, unknown>;
      assert.equal(body.reasoning, undefined);
    }
    assert.equal(resolveProviderAdapter('openai'), openAiCompatibleAdapter);
  } finally {
    setCustomProviders([]);
  }
});
