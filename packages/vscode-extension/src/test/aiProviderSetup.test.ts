import * as assert from 'assert';
import type { AiProvider } from '../types';
import {
  AI_PROVIDER_LABELS,
  buildAiProviderSetupOptions,
  sortAiOptionsByDefaultProvider
} from '../ai/aiProviderSetup';

suite('AI provider setup', () => {
  test('includes only Vercel AI Gateway and Disable AI', () => {
    const options = buildAiProviderSetupOptions();
    assert.deepStrictEqual(
      options.map(option => option.provider),
      ['vercel-gateway', 'none']
    );
    assert.strictEqual(AI_PROVIDER_LABELS['vercel-gateway'], 'Vercel AI Gateway');
    assert.ok(options[0]?.detail?.toLowerCase().includes('gateway'));
  });

  test('sorts configured options by default provider', () => {
    const options: Array<{ provider: AiProvider; label: string }> = [
      { provider: 'vercel-gateway', label: 'Vercel AI Gateway' }
    ];

    const sorted = sortAiOptionsByDefaultProvider(options, 'vercel-gateway');

    assert.deepStrictEqual(
      sorted.map(option => option.provider),
      ['vercel-gateway']
    );
  });
});
