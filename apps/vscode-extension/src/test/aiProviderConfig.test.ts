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
      runtimePath: '',
      vercelUrl: ''
    });
    assert.deepStrictEqual(sanitizeAiProviderSettings({ provider: 'invalid', credential: 123 }), {
      provider: 'none',
      credential: '',
      agentName: '',
      runtimePath: '',
      vercelUrl: ''
    });
  });

  test('sanitizeAiProviderSettings coerces legacy providers to vercel-gateway', () => {
    for (const provider of ['copilot-cli', 'openai', 'claude', 'cursor-cli', 'claude-cli']) {
      assert.deepStrictEqual(
        sanitizeAiProviderSettings({
          provider,
          credential: 'key',
          agentName: 'Bot',
          runtimePath: ''
        }),
        {
          provider: 'vercel-gateway',
          credential: 'key',
          agentName: 'Bot',
          runtimePath: '',
          vercelUrl: ''
        }
      );
    }
  });

  test('buildAiProviderSettingsFromLegacy migrates any legacy AI config to vercel-gateway', () => {
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
      provider: 'vercel-gateway',
      credential: '',
      agentName: 'GPT Reviewer',
      runtimePath: '',
      vercelUrl: ''
    });
  });

  test('buildAiProviderSettingsFromLegacy detects highest-priority legacy provider as vercel-gateway', () => {
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
      provider: 'vercel-gateway',
      credential: '',
      agentName: '',
      runtimePath: '',
      vercelUrl: ''
    });
  });

  test('readFlatAiProviderSettings coerces legacy provider ids', () => {
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
          case 'ai.vercelUrl':
            return '' as T;
          default:
            return defaultValue as T;
        }
      }
    });

    assert.deepStrictEqual(settings, {
      provider: 'vercel-gateway',
      credential: 'sk-test',
      agentName: 'GPT Reviewer',
      runtimePath: '',
      vercelUrl: ''
    });
  });

  test('readFlatAiProviderSettings supports nested legacy provider object', () => {
    const settings = readFlatAiProviderSettings({
      get<T>(key: string, defaultValue?: T): T {
        if (key === 'ai.provider') {
          return {
            provider: 'vercel-gateway',
            credential: 'gw-key',
            agentName: 'Agent',
            runtimePath: '',
            vercelUrl: 'https://ai-gateway.vercel.sh'
          } as T;
        }
        return defaultValue as T;
      }
    });

    assert.deepStrictEqual(settings, {
      provider: 'vercel-gateway',
      credential: 'gw-key',
      agentName: 'Agent',
      runtimePath: '',
      vercelUrl: 'https://ai-gateway.vercel.sh'
    });
  });

  test('isAiProviderConfigured requires credential for vercel gateway', () => {
    assert.strictEqual(
      isAiProviderConfigured({
        provider: 'vercel-gateway',
        credential: '',
        agentName: '',
        runtimePath: '',
        vercelUrl: ''
      }),
      false
    );
    assert.strictEqual(
      isAiProviderConfigured({
        provider: 'vercel-gateway',
        credential: 'gw-key',
        agentName: '',
        runtimePath: '',
        vercelUrl: ''
      }),
      true
    );
    assert.strictEqual(
      isAiProviderConfigured({
        provider: 'vercel-gateway',
        credential: '',
        agentName: '',
        runtimePath: '',
        vercelUrl: ''
      }, { secretCredentialPresent: true }),
      true
    );
  });
});
