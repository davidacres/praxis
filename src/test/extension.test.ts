import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TicketManagerExtensionApi } from '../extension';

const EXTENSION_ID_CANDIDATES = ['kam-ai-team.ticket-manager', 'local-dev.ticket-manager'];
const WORKSPACE_MCP_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'mcp.json')
  : undefined;
const USER_MCP_OVERRIDE_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.ticket-manager-test', 'user-mcp.json')
  : undefined;
const LIVE_FOLDER_TEST_ROOT_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders[0].uri,
      '.ticket-manager-test',
      'live-folder-mode'
    )
  : undefined;

interface LiveFolderFixture {
  rootUri: vscode.Uri;
  plansRootUri: vscode.Uri;
  featuresRootUri: vscode.Uri;
  featureDirUri: vscode.Uri;
  featureKey: string;
  storyKey: string;
  storyFileUri: vscode.Uri;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for condition.');
}

async function getApi(): Promise<TicketManagerExtensionApi> {
  const extension = EXTENSION_ID_CANDIDATES
    .map(id => vscode.extensions.getExtension<TicketManagerExtensionApi>(id))
    .find((candidate): candidate is vscode.Extension<TicketManagerExtensionApi> => Boolean(candidate));
  assert.ok(extension, 'Extension should be available');
  const api = await extension.activate();
  return api;
}

function getServerPath(): string {
  const extension = EXTENSION_ID_CANDIDATES
    .map(id => vscode.extensions.getExtension(id))
    .find((candidate): candidate is vscode.Extension<unknown> => Boolean(candidate));
  assert.ok(extension, 'Extension should be available');
  return path.join(extension.extensionPath, 'out', 'test', 'fixtures', 'fakeJiraMcpServer.js');
}

function getExtensionPath(): string {
  const extension = EXTENSION_ID_CANDIDATES
    .map(id => vscode.extensions.getExtension(id))
    .find((candidate): candidate is vscode.Extension<unknown> => Boolean(candidate));
  assert.ok(extension, 'Extension should be available');
  return extension.extensionPath;
}

async function clearWorkspaceMcpFile(): Promise<void> {
  if (!WORKSPACE_MCP_URI) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(WORKSPACE_MCP_URI);
  } catch {
    // Ignore missing file.
  }
}

async function writeWorkspaceMcpFile(contents: string): Promise<void> {
  if (!WORKSPACE_MCP_URI) {
    throw new Error('A workspace folder is required for workspace MCP tests.');
  }

  const directory = vscode.Uri.joinPath(WORKSPACE_MCP_URI, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(WORKSPACE_MCP_URI, Buffer.from(contents, 'utf8'));
}

async function clearUserMcpOverride(): Promise<void> {
  delete process.env.JIRA_MINI_USER_MCP_PATHS;
  if (!USER_MCP_OVERRIDE_URI) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(USER_MCP_OVERRIDE_URI);
  } catch {
    // Ignore missing file.
  }
}

async function clearLiveFolderFixture(): Promise<void> {
  if (!LIVE_FOLDER_TEST_ROOT_URI) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(LIVE_FOLDER_TEST_ROOT_URI, { recursive: true, useTrash: false });
  } catch {
    // Ignore missing file.
  }
}

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  const directory = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function createLiveFolderFixture(name: string): Promise<LiveFolderFixture> {
  if (!LIVE_FOLDER_TEST_ROOT_URI) {
    throw new Error('A workspace folder is required for live folder tests.');
  }

  const rootUri = vscode.Uri.joinPath(LIVE_FOLDER_TEST_ROOT_URI, name);
  const plansRootUri = vscode.Uri.joinPath(rootUri, 'product', 'docs', 'plans');
  const featuresRootUri = vscode.Uri.joinPath(plansRootUri, 'features');
  const featureDirUri = vscode.Uri.joinPath(featuresRootUri, 'feature-01-auth');

  await vscode.workspace.fs.createDirectory(featureDirUri);
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'feature.md'),
    `# Authentication

**Status:** Planned
**Created:** 2026-01-01T00:00:00.000Z

## Summary
Implement authentication support.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
`
  );
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'story-01-1-login-flow.md'),
    `# Login flow

**Status:** In Progress
**Created:** 2026-01-02T00:00:00.000Z
**Type:** Story
**Parent:** APP-F01

## Summary
Build the first login story.
`
  );

  const storyFileUri = vscode.Uri.joinPath(featureDirUri, 'story-01-1-login-flow.md');

  return {
    rootUri,
    plansRootUri,
    featuresRootUri,
    featureDirUri,
    featureKey: 'APP-F01',
    storyKey: 'APP-S01-1',
    storyFileUri
  };
}

async function writeUserMcpOverride(contents: string): Promise<void> {
  if (!USER_MCP_OVERRIDE_URI) {
    throw new Error('A workspace folder is required for user MCP tests.');
  }

  const directory = vscode.Uri.joinPath(USER_MCP_OVERRIDE_URI, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(USER_MCP_OVERRIDE_URI, Buffer.from(contents, 'utf8'));
  process.env.JIRA_MINI_USER_MCP_PATHS = USER_MCP_OVERRIDE_URI.fsPath;
}

async function resetConnectionState(api: TicketManagerExtensionApi): Promise<void> {
  const config = vscode.workspace.getConfiguration('ticketManager');
  await Promise.all([
    config.update('backendMode', 'jiracloud', vscode.ConfigurationTarget.Workspace),
    config.update('liveFolderPath', '', vscode.ConfigurationTarget.Workspace),
    config.update('liveFolderProjectKey', '', vscode.ConfigurationTarget.Workspace),
    config.update('liveFolderProjectName', '', vscode.ConfigurationTarget.Workspace),
    config.update('liveFolderAllowIssueCreation', true, vscode.ConfigurationTarget.Workspace),
    config.update('ai.openaiApiKey', '', vscode.ConfigurationTarget.Global),
    config.update('ai.openaiAgentName', '', vscode.ConfigurationTarget.Global),
    config.update('ai.claudeApiKey', '', vscode.ConfigurationTarget.Global),
    config.update('ai.claudeAgentName', '', vscode.ConfigurationTarget.Global),
    config.update('ai.cursorCliPath', '', vscode.ConfigurationTarget.Global),
    config.update('ai.copilotEnabled', false, vscode.ConfigurationTarget.Global),
    config.update('ai.copilotCliPath', '', vscode.ConfigurationTarget.Global),
    config.update('ai.defaultProvider', 'none', vscode.ConfigurationTarget.Global),
    config.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
    config.update('stdioCommand', '', vscode.ConfigurationTarget.Global),
    config.update('stdioArgs', [], vscode.ConfigurationTarget.Global),
    config.update('stdioCwd', '', vscode.ConfigurationTarget.Global),
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global)
  ]);

  await clearUserMcpOverride();
  await clearLiveFolderFixture();
  await api.backendService.reset();
  await api.filterStore.clearFilters();
  await api.boardStore.clearFilters();
  await api.boardColumnStore.clearAllPreferences();
  await api.detailsProvider.setIssue(undefined);
  api.boardPanelManager.dispose();
}

async function configureScenario(
  api: TicketManagerExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported' | 'atlassian'
): Promise<void> {
  await clearWorkspaceMcpFile();
  await clearUserMcpOverride();
  const serverPath = getServerPath();
  const config = vscode.workspace.getConfiguration('ticketManager');

  await Promise.all([
    config.update('backendMode', 'jiracloud', vscode.ConfigurationTarget.Workspace),
    config.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
    config.update('stdioCommand', 'node', vscode.ConfigurationTarget.Global),
    config.update('stdioArgs', [serverPath, `--scenario=${scenario}`], vscode.ConfigurationTarget.Global),
    config.update('stdioCwd', getExtensionPath(), vscode.ConfigurationTarget.Global),
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global),
    config.update('requestTimeoutMs', 10000, vscode.ConfigurationTarget.Global),
    config.update('defaultPageSize', 25, vscode.ConfigurationTarget.Global)
  ]);

  await api.backendService.reset();
  await api.filterStore.clearFilters();
  await api.boardStore.clearFilters();
  await api.boardColumnStore.clearAllPreferences();
  await api.detailsProvider.setIssue(undefined);
  api.boardPanelManager.dispose();
  await api.refresh();
}

async function configureWorkspaceMcpScenario(
  api: TicketManagerExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported' | 'atlassian'
): Promise<void> {
  await resetConnectionState(api);

  await writeWorkspaceMcpFile(`{
  // Ticket Manager should automatically use this workspace MCP server.
  "servers": {
    "jira": {
      "command": "node",
      "args": ["\${workspaceFolder}\\\\out\\\\test\\\\fixtures\\\\fakeJiraMcpServer.js", "--scenario=${scenario}"],
      "cwd": "\${workspaceFolder}"
    },
    "memory": {
      "command": "node",
      "args": ["-e", "console.log('memory server placeholder')"]
    }
  }
}`);

  await api.refresh();
}

async function configureUserMcpScenario(
  api: TicketManagerExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported' | 'atlassian'
): Promise<void> {
  await resetConnectionState(api);

  await writeUserMcpOverride(`{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["\${workspaceFolder}\\\\out\\\\test\\\\fixtures\\\\fakeJiraMcpServer.js", "--scenario=${scenario}"],
      "cwd": "\${workspaceFolder}"
    }
  }
}`);

  await api.refresh();
}

async function configureDemoScenario(api: TicketManagerExtensionApi): Promise<void> {
  await resetConnectionState(api);
  const config = vscode.workspace.getConfiguration('ticketManager');
  await config.update('backendMode', 'demo', vscode.ConfigurationTarget.Workspace);
  await api.backendService.reset();
  await api.refresh();
}

async function configureLiveFolderScenario(
  api: TicketManagerExtensionApi,
  options?: { allowIssueCreation?: boolean }
): Promise<LiveFolderFixture> {
  await resetConnectionState(api);
  const fixture = await createLiveFolderFixture('default');
  const config = vscode.workspace.getConfiguration('ticketManager');
  await Promise.all([
    config.update('backendMode', 'livefolder', vscode.ConfigurationTarget.Workspace),
    config.update(
      'liveFolderPath',
      fixture.rootUri.fsPath.replace(/\\/g, '/'),
      vscode.ConfigurationTarget.Workspace
    ),
    config.update('liveFolderProjectKey', 'APP', vscode.ConfigurationTarget.Workspace),
    config.update('liveFolderProjectName', 'Application', vscode.ConfigurationTarget.Workspace),
    config.update(
      'liveFolderAllowIssueCreation',
      options?.allowIssueCreation ?? true,
      vscode.ConfigurationTarget.Workspace
    )
  ]);
  await api.backendService.reset();
  await api.refresh();
  return fixture;
}

suite('Ticket Manager Extension', () => {
  suiteTeardown(async () => {
    const api = await getApi();
    await clearWorkspaceMcpFile();
    await clearUserMcpOverride();
    await resetConnectionState(api);
  });

  test('activates and registers core commands', async function () {
    this.timeout(60000);
    const api = await getApi();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(api.issuesProvider, 'Issues provider should be created');
    assert.ok(api.detailsProvider, 'Details provider should be created');
    assert.ok(commands.includes('ticketManager.refresh'));
    assert.ok(commands.includes('ticketManager.checkConnection'));
    assert.ok(commands.includes('ticketManager.changeStatus'));
    assert.ok(commands.includes('ticketManager.setBackendMode'));
    assert.ok(commands.includes('ticketManager.openSettings'));
    assert.ok(commands.includes('ticketManager.toggleWorkMode'));
    assert.ok(commands.includes('ticketManager.configureAi'));
    assert.ok(commands.includes('ticketManager.openBoard'));
    assert.ok(commands.includes('ticketManager.setBoardProjects'));
    assert.ok(commands.includes('ticketManager.setBoardTypes'));
    assert.ok(commands.includes('ticketManager.setBoardSearchText'));
    assert.ok(commands.includes('ticketManager.openIssueFullDetails'));
    assert.ok(commands.includes('ticketManager.configureBoardColumns'));
    assert.ok(commands.includes('ticketManager.createIssue'));
    assert.ok(commands.includes('ticketManager.createBoard'));
  });

  test('can disable live-folder issue creation with a workspace setting', async () => {
    const api = await getApi();
    await configureLiveFolderScenario(api, { allowIssueCreation: false });

    await assert.rejects(
      () =>
        api.backendService.createIssue({
          projectKey: 'APP',
          issueType: 'Feature',
          summary: 'Should stay read only'
        }),
      /disabled/i
    );
  });

});

