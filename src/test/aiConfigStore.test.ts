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
    await store.setAiProviderSettings({
      provider: 'copilot-cli',
      credential: '',
      agentName: '',
      runtimePath: ''
    });

    assert.deepStrictEqual(store.getConfiguredAiProviders(), ['copilot-cli']);
  });

  test('returns empty list when active provider lacks credentials', async () => {
    await store.setAiProviderSettings({
      provider: 'openai',
      credential: '',
      agentName: '',
      runtimePath: ''
    });

    assert.deepStrictEqual(store.getConfiguredAiProviders(), []);
  });

  test('claude code cli path counts as configured when active', async () => {
    await store.setAiProviderSettings({
      provider: 'claude-cli',
      credential: 'C:/Users/test/.local/bin/claude.exe',
      agentName: '',
      runtimePath: ''
    });

    assert.deepStrictEqual(store.getConfiguredAiProviders(), ['claude-cli']);
  });

  test('setAiProviderSettings writes separate flat settings', async () => {
    await store.setAiProviderSettings({
      provider: 'openai',
      credential: 'sk-test',
      agentName: 'GPT Reviewer',
      runtimePath: ''
    });

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    assert.strictEqual(config.get('ai.provider'), 'openai');
    assert.strictEqual(config.get('ai.credential'), 'sk-test');
    assert.strictEqual(config.get('ai.agentName'), 'GPT Reviewer');
    assert.strictEqual(config.get('ai.runtimePath'), '');
    assert.deepStrictEqual(store.getConfiguredAiAgents(), [{
      name: 'GPT Reviewer',
      provider: 'openai',
      apiKey: 'sk-test'
    }]);
  });
});
