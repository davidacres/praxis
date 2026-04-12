import * as assert from 'assert';
import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';

const CONFIG_SECTION = 'ticketManager';
const SCOPED_KEYS = [
  'backendMode',
  'planFilePath',
  'liveFolderPath',
  'liveFolderProjectKey',
  'liveFolderProjectName',
  'liveFolderAllowIssueCreation'
] as const;

type ScopedKey = (typeof SCOPED_KEYS)[number];

interface ConfigSnapshotEntry {
  globalValue: unknown;
  workspaceValue: unknown;
}

type ConfigSnapshot = Record<ScopedKey, ConfigSnapshotEntry>;

function captureSnapshot(): ConfigSnapshot {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const entries = {} as ConfigSnapshot;
  for (const key of SCOPED_KEYS) {
    const inspected = config.inspect(key);
    entries[key] = {
      globalValue: inspected?.globalValue,
      workspaceValue: inspected?.workspaceValue
    };
  }
  return entries;
}

async function restoreSnapshot(snapshot: ConfigSnapshot): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  for (const key of SCOPED_KEYS) {
    await config.update(key, snapshot[key].workspaceValue, vscode.ConfigurationTarget.Workspace);
    await config.update(key, snapshot[key].globalValue, vscode.ConfigurationTarget.Global);
  }
}

suite('AppConfigStore workspace-scoped settings', () => {
  let snapshot: ConfigSnapshot;
  let store: AppConfigStore;

  setup(async () => {
    snapshot = captureSnapshot();
    store = new AppConfigStore();
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    for (const key of SCOPED_KEYS) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  });

  teardown(async () => {
    await restoreSnapshot(snapshot);
  });

  test('workspace projects ignore global backend mode', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('backendMode', 'livefolder', vscode.ConfigurationTarget.Global);

    assert.strictEqual(store.getBackendMode(), undefined);
    assert.strictEqual(store.getEffectiveBackendMode(), 'jira');
  });

  test('workspace projects ignore global live folder path', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(
      'liveFolderPath',
      'C:/global-only/should-not-be-used',
      vscode.ConfigurationTarget.Global
    );

    assert.strictEqual(store.getLiveFolderPath(), '');
  });

  test('workspace values override conflicting global values', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('backendMode', 'livefolder', vscode.ConfigurationTarget.Global);
    await config.update('backendMode', 'file', vscode.ConfigurationTarget.Workspace);
    await config.update(
      'liveFolderPath',
      'C:/global-only/should-not-be-used',
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      'liveFolderPath',
      'C:/workspace/plans',
      vscode.ConfigurationTarget.Workspace
    );
    await config.update(
      'liveFolderAllowIssueCreation',
      false,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      'liveFolderAllowIssueCreation',
      true,
      vscode.ConfigurationTarget.Workspace
    );

    assert.strictEqual(store.getBackendMode(), 'file');
    assert.strictEqual(store.getLiveFolderPath(), 'C:/workspace/plans');
    assert.strictEqual(store.getLiveFolderAllowIssueCreation(), true);
  });
});
