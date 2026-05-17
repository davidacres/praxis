import * as assert from 'assert';
import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';

const CONFIG_SECTION = 'ticketManager';

interface AiConfigSnapshot {
  copilotEnabled: unknown;
  copilotCliPath: unknown;
  claudeCliPath: unknown;
}

function captureAiSnapshot(): AiConfigSnapshot {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    copilotEnabled: config.inspect('ai.copilotEnabled')?.globalValue,
    copilotCliPath: config.inspect('ai.copilotCliPath')?.globalValue,
    claudeCliPath: config.inspect('ai.claudeCliPath')?.globalValue
  };
}

async function restoreAiSnapshot(snapshot: AiConfigSnapshot): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('ai.copilotEnabled', snapshot.copilotEnabled, vscode.ConfigurationTarget.Global);
  await config.update('ai.copilotCliPath', snapshot.copilotCliPath, vscode.ConfigurationTarget.Global);
  await config.update('ai.claudeCliPath', snapshot.claudeCliPath, vscode.ConfigurationTarget.Global);
}

suite('AppConfigStore AI settings', () => {
  let snapshot: AiConfigSnapshot;
  let store: AppConfigStore;

  setup(async () => {
    snapshot = captureAiSnapshot();
    store = new AppConfigStore();
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('ai.copilotEnabled', false, vscode.ConfigurationTarget.Global);
    await config.update('ai.copilotCliPath', '', vscode.ConfigurationTarget.Global);
    await config.update('ai.claudeCliPath', '', vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await restoreAiSnapshot(snapshot);
  });

  test('copilot sdk enablement counts as configured without cli path', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('ai.copilotEnabled', true, vscode.ConfigurationTarget.Global);

    assert.ok(store.getConfiguredAiProviders().includes('copilot-cli'));
  });

  test('legacy copilot cli path still counts as configured', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('ai.copilotCliPath', '/tmp/copilot', vscode.ConfigurationTarget.Global);

    assert.ok(store.getConfiguredAiProviders().includes('copilot-cli'));
  });

  test('claude code cli path counts as configured', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('ai.claudeCliPath', 'C:/Users/test/.local/bin/claude.exe', vscode.ConfigurationTarget.Global);

    assert.ok(store.getConfiguredAiProviders().includes('claude-cli'));
  });
});
