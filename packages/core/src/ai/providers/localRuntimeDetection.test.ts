import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLocalRuntimes, type DetectFetch } from './localRuntimeDetection';
import { PROVIDER_PRESETS } from './providerPresets';

const answering = (routes: Record<string, unknown>): { fetch: DetectFetch; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async url => {
      urls.push(url);
      if (!(url in routes)) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => routes[url] };
    }
  };
};

test('only local presets are probed, and only the ones that answer with a model list are reported', async () => {
  const { fetch, urls } = answering({
    'http://localhost:11434/v1/models': { data: [{ id: 'llama3' }, { id: 'qwen3' }] },
    'http://localhost:1234/v1/models': { error: 'not a list' }
  });
  const found = await detectLocalRuntimes(PROVIDER_PRESETS, fetch);
  assert.deepEqual(found, [{ presetId: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', modelCount: 2 }]);
  const probed = PROVIDER_PRESETS.filter(preset => preset.group === 'local').length;
  assert.equal(urls.length, probed);
  assert.ok(urls.every(url => url.startsWith('http://localhost:')), 'no cloud or gateway preset is contacted');
});

test('an origin override replaces the preset base URL', async () => {
  const { fetch } = answering({ 'http://127.0.0.1:5555/v1/models': { data: [] } });
  const found = await detectLocalRuntimes(PROVIDER_PRESETS, fetch, { origins: { ollama: 'http://127.0.0.1:5555/' } });
  assert.deepEqual(found.map(entry => [entry.presetId, entry.baseUrl, entry.modelCount]), [['ollama', 'http://127.0.0.1:5555', 0]]);
});

test('a runtime that never answers is dropped after the timeout', async () => {
  const hanging: DetectFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const started = Date.now();
  const found = await detectLocalRuntimes(PROVIDER_PRESETS, hanging, { timeoutMs: 50 });
  assert.deepEqual(found, []);
  assert.ok(Date.now() - started < 1000);
});
