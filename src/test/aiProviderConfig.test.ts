import * as assert from 'assert';
import {
  buildAiProviderSettingsFromLegacy,
  isAiProviderConfigured,
  readFlatAiProviderSettings,
  sanitizeAiProviderSettings
} from '../config/aiProviderConfig';

suite('aiProviderConfig', () => {
  test('sanitizeAiProviderSettings defaults invalid values', () => {
    assert.deepStrictEqual(sanitizeAiProviderSettings(undefined), {
      provider: 'none',
      credential: '',
      agentName: '',
      runtimePath: ''
    });
    assert.deepStrictEqual(sanitizeAiProviderSettings({ provider: 'invalid', credential: 123 }), {
      provider: 'none',
      credential: '',
      agentName: '',
      runtimePath: ''
    });
  });

  test('buildAiProviderSettingsFromLegacy prefers explicit default provider', () => {
    const settings = buildAiProviderSettingsFromLegacy({
      defaultProvider: 'openai',
      openaiApiKey: 'sk-test',
      claudeApiKey: '',
      cursorCliPath: '',
      copilotEnabled: false,
      copilotCliPath: '',
      copilotAgentName: '',
      claudeCliPath: 'C:/claude.exe',
      openaiAgentName: 'GPT Reviewer',
      claudeAgentName: ''
    });

    assert.deepStrictEqual(settings, {
      provider: 'openai',
      credential: 'sk-test',
      agentName: 'GPT Reviewer',
      runtimePath: ''
    });
  });

  test('buildAiProviderSettingsFromLegacy detects highest-priority legacy provider', () => {
    const settings = buildAiProviderSettingsFromLegacy({
      defaultProvider: 'none',
      openaiApiKey: 'sk-test',
      claudeApiKey: '',
      cursorCliPath: '',
      copilotEnabled: false,
      copilotCliPath: '',
      copilotAgentName: '',
      claudeCliPath: 'C:/claude.exe',
      openaiAgentName: '',
      claudeAgentName: ''
    });

    assert.deepStrictEqual(settings, {
      provider: 'claude-cli',
      credential: 'C:/claude.exe',
      agentName: '',
      runtimePath: ''
    });
  });

  test('readFlatAiProviderSettings reads separate settings', () => {
    const settings = readFlatAiProviderSettings({
      get<T>(key: string, defaultValue?: T): T {
        switch (key) {
          case 'ai.provider':
            return 'openai' as T;
          case 'ai.credential':
            return 'sk-test' as T;
          case 'ai.agentName':
            return 'GPT Reviewer' as T;
          case 'ai.runtimePath':
            return '' as T;
          default:
            return defaultValue as T;
        }
      }
    });

    assert.deepStrictEqual(settings, {
      provider: 'openai',
      credential: 'sk-test',
      agentName: 'GPT Reviewer',
      runtimePath: ''
    });
  });

  test('readFlatAiProviderSettings supports nested legacy provider object', () => {
    const settings = readFlatAiProviderSettings({
      get<T>(key: string, defaultValue?: T): T {
        if (key === 'ai.provider') {
          return {
            provider: 'copilot-cli',
            credential: '',
            agentName: 'Copilot',
            runtimePath: ''
          } as T;
        }
        return defaultValue as T;
      }
    });

    assert.deepStrictEqual(settings, {
      provider: 'copilot-cli',
      credential: '',
      agentName: 'Copilot',
      runtimePath: ''
    });
  });

  test('isAiProviderConfigured treats copilot sdk as configured without credential', () => {
    assert.strictEqual(
      isAiProviderConfigured({
        provider: 'copilot-cli',
        credential: '',
        agentName: '',
        runtimePath: ''
      }),
      true
    );
    assert.strictEqual(
      isAiProviderConfigured({
        provider: 'openai',
        credential: '',
        agentName: '',
        runtimePath: ''
      }),
      false
    );
  });
});
