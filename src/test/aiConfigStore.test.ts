import * as assert from 'assert';
import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';

const CONFIG_SECTION = 'ticketManager';

interface AiConfigSnapshot {
  provider: unknown;
  credential: unknown;
  agentName: unknown;
  runtimePath: unknown;
}

function captureAiSnapshot(): AiConfigSnapshot {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    provider: config.inspect('ai.provider')?.globalValue,
    credential: config.inspect('ai.credential')?.globalValue,
    agentName: config.inspect('ai.agentName')?.globalValue,
    runtimePath: config.inspect('ai.runtimePath')?.globalValue
  };
}

async function restoreAiSnapshot(snapshot: AiConfigSnapshot): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('ai.provider', snapshot.provider, vscode.ConfigurationTarget.Global);
  await config.update('ai.credential', snapshot.credential, vscode.ConfigurationTarget.Global);
  await config.update('ai.agentName', snapshot.agentName, vscode.ConfigurationTarget.Global);
  await config.update('ai.runtimePath', snapshot.runtimePath, vscode.ConfigurationTarget.Global);
}

async function resetAiSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('ai.provider', 'none', vscode.ConfigurationTarget.Global);
  await config.update('ai.credential', '', vscode.ConfigurationTarget.Global);
  await config.update('ai.agentName', '', vscode.ConfigurationTarget.Global);
  await config.update('ai.runtimePath', '', vscode.ConfigurationTarget.Global);
}

suite('AppConfigStore AI settings', () => {
  let snapshot: AiConfigSnapshot;
  let store: AppConfigStore;

  setup(async () => {
    snapshot = captureAiSnapshot();
    store = new AppConfigStore();
    await resetAiSettings();
  });

  teardown(async () => {
    await restoreAiSnapshot(snapshot);
  });

  test('returns only the active provider when configured', async () => {
    const secretMap = new Map<string, string>();
    store.bindExtensionSecrets({
      get: async (key: string) => secretMap.get(key),
      store: async (key: string, value: string) => {
        secretMap.set(key, value);
      },
      delete: async (key: string) => {
        secretMap.delete(key);
      },
      keys: async () => [...secretMap.keys()],
      onDidChange: (() => ({ dispose() {} })) as vscode.SecretStorage['onDidChange']
    });

    await store.setAiProviderSettings({
      provider: 'vercel-gateway',
      credential: '',
      agentName: '',
      runtimePath: '',
      vercelUrl: 'https://ai-gateway.vercel.sh'
    });
    await store.storeVercelGatewayApiKey('gw-key');

    assert.deepStrictEqual(store.getConfiguredAiProviders(), ['vercel-gateway']);
  });

  test('returns empty list when active provider lacks credentials', async () => {
    await store.setAiProviderSettings({
      provider: 'vercel-gateway',
      credential: '',
      agentName: '',
      runtimePath: '',
      vercelUrl: ''
    });

    assert.deepStrictEqual(store.getConfiguredAiProviders(), []);
  });

  test('setAiProviderSettings writes separate flat settings', async () => {
    await store.setAiProviderSettings({
      provider: 'vercel-gateway',
      credential: 'sk-test',
      agentName: 'Gateway Bot',
      runtimePath: '',
      vercelUrl: 'https://ai-gateway.vercel.sh'
    });

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    assert.strictEqual(config.get('ai.provider'), 'vercel-gateway');
    // Vercel API key is SecretStorage-backed; credential setting stays empty.
    assert.strictEqual(config.get('ai.credential'), '');
    assert.strictEqual(config.get('ai.agentName'), 'Gateway Bot');
    assert.strictEqual(config.get('ai.runtimePath'), '');
    assert.strictEqual(config.get('ai.vercelUrl'), 'https://ai-gateway.vercel.sh');
  });
});
