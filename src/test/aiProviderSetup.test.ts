import * as assert from 'assert';
import type { AiProvider } from '../types';
import {
  AI_PROVIDER_LABELS,
  buildAiProviderSetupOptions,
  sortAiOptionsByDefaultProvider
} from '../ai/aiProviderSetup';

suite('AI provider setup', () => {
  test('includes GitHub Copilot SDK in setup options', () => {
    const options = buildAiProviderSetupOptions();
    const copilotOption = options.find(option => option.provider === 'copilot-cli');

    assert.ok(copilotOption);
    assert.strictEqual(copilotOption?.label, 'GitHub Copilot SDK');
    assert.strictEqual(AI_PROVIDER_LABELS['copilot-cli'], 'GitHub Copilot SDK');
  });

  test('sorts configured options by default provider', () => {
    const options: Array<{ provider: AiProvider; label: string }> = [
      { provider: 'openai', label: 'OpenAI' },
      { provider: 'claude', label: 'Claude' },
      { provider: 'copilot-cli', label: 'GitHub Copilot SDK' }
    ];

    const sorted = sortAiOptionsByDefaultProvider(options, 'copilot-cli');

    assert.deepStrictEqual(sorted.map(option => option.provider), [
      'copilot-cli',
      'openai',
      'claude'
    ]);
  });
});
