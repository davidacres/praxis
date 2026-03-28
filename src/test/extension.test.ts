import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { JiraMiniExtensionApi } from '../extension';

const EXTENSION_ID = 'local-dev.jira-mini';
const WORKSPACE_MCP_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'mcp.json')
  : undefined;
const USER_MCP_OVERRIDE_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.jira-mini-test', 'user-mcp.json')
  : undefined;

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

async function getApi(): Promise<JiraMiniExtensionApi> {
  const extension = vscode.extensions.getExtension<JiraMiniExtensionApi>(EXTENSION_ID);
  assert.ok(extension, 'Extension should be available');
  const api = await extension.activate();
  return api;
}

function getServerPath(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'Extension should be available');
  return path.join(extension.extensionPath, 'out', 'test', 'fixtures', 'fakeJiraMcpServer.js');
}

function getExtensionPath(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
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

async function writeUserMcpOverride(contents: string): Promise<void> {
  if (!USER_MCP_OVERRIDE_URI) {
    throw new Error('A workspace folder is required for user MCP tests.');
  }

  const directory = vscode.Uri.joinPath(USER_MCP_OVERRIDE_URI, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(USER_MCP_OVERRIDE_URI, Buffer.from(contents, 'utf8'));
  process.env.JIRA_MINI_USER_MCP_PATHS = USER_MCP_OVERRIDE_URI.fsPath;
}

async function resetConnectionState(api: JiraMiniExtensionApi): Promise<void> {
  const config = vscode.workspace.getConfiguration('jiraMini');
  await Promise.all([
    config.update('backendMode', 'jira', vscode.ConfigurationTarget.Workspace),
    config.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
    config.update('stdioCommand', '', vscode.ConfigurationTarget.Global),
    config.update('stdioArgs', [], vscode.ConfigurationTarget.Global),
    config.update('stdioCwd', '', vscode.ConfigurationTarget.Global),
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global),
    config.update('workspaceMcpServerName', '', vscode.ConfigurationTarget.Workspace),
    config.update('userMcpServerRef', '', vscode.ConfigurationTarget.Global)
  ]);

  await clearUserMcpOverride();
  await api.backendService.reset();
  await api.filterStore.clearFilters();
  await api.boardStore.clearFilters();
  await api.detailsProvider.setIssue(undefined);
  api.boardPanelManager.dispose();
}

async function configureScenario(
  api: JiraMiniExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported'
): Promise<void> {
  await clearWorkspaceMcpFile();
  await clearUserMcpOverride();
  const serverPath = getServerPath();
  const config = vscode.workspace.getConfiguration('jiraMini');

  await Promise.all([
    config.update('backendMode', 'jira', vscode.ConfigurationTarget.Workspace),
    config.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
    config.update('stdioCommand', 'node', vscode.ConfigurationTarget.Global),
    config.update('stdioArgs', [serverPath, `--scenario=${scenario}`], vscode.ConfigurationTarget.Global),
    config.update('stdioCwd', getExtensionPath(), vscode.ConfigurationTarget.Global),
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global),
    config.update('workspaceMcpServerName', '', vscode.ConfigurationTarget.Workspace),
    config.update('userMcpServerRef', '', vscode.ConfigurationTarget.Global),
    config.update('requestTimeoutMs', 10000, vscode.ConfigurationTarget.Global),
    config.update('defaultPageSize', 25, vscode.ConfigurationTarget.Global)
  ]);

  await api.backendService.reset();
  await api.filterStore.clearFilters();
  await api.boardStore.clearFilters();
  await api.detailsProvider.setIssue(undefined);
  api.boardPanelManager.dispose();
  await api.refresh();
}

async function configureWorkspaceMcpScenario(
  api: JiraMiniExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported'
): Promise<void> {
  await resetConnectionState(api);

  await writeWorkspaceMcpFile(`{
  // Jira Mini should automatically use this workspace MCP server.
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
  api: JiraMiniExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported'
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

async function configureDemoScenario(api: JiraMiniExtensionApi): Promise<void> {
  await resetConnectionState(api);
  const config = vscode.workspace.getConfiguration('jiraMini');
  await config.update('backendMode', 'demo', vscode.ConfigurationTarget.Workspace);
  await api.backendService.reset();
  await api.refresh();
}

suite('Jira Mini Extension', () => {
  suiteTeardown(async () => {
    const api = await getApi();
    await clearWorkspaceMcpFile();
    await clearUserMcpOverride();
    await resetConnectionState(api);
  });

  test('activates and registers core commands', async () => {
    const api = await getApi();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(api.issuesProvider, 'Issues provider should be created');
    assert.ok(api.detailsProvider, 'Details provider should be created');
    assert.ok(commands.includes('jiraMini.refresh'));
    assert.ok(commands.includes('jiraMini.checkConnection'));
    assert.ok(commands.includes('jiraMini.changeStatus'));
    assert.ok(commands.includes('jiraMini.importWorkspaceMcpConfig'));
    assert.ok(commands.includes('jiraMini.importUserMcpConfig'));
    assert.ok(commands.includes('jiraMini.setBackendMode'));
    assert.ok(commands.includes('jiraMini.openBoard'));
    assert.ok(commands.includes('jiraMini.setBoardProjects'));
    assert.ok(commands.includes('jiraMini.setBoardTypes'));
    assert.ok(commands.includes('jiraMini.setBoardSearchText'));
  });

  test('loads my issues from the fake Jira MCP server', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    const keys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);

    assert.ok(keys.includes('APP-100'));
    assert.ok(keys.includes('APP-101'));
    assert.ok(keys.includes('APP-103'));
    assert.ok(keys.includes('OPS-200'));
    assert.ok(!keys.includes('APP-102'), 'Issues not assigned to currentUser() should be filtered out');
  });

  test('reports a warning when no Jira projects are accessible', async () => {
    const api = await getApi();
    await configureScenario(api, 'no-projects');

    const result = await api.backendService.checkConnection();
    assert.strictEqual(result.status, 'warning');
    assert.match(result.message, /no jira projects are accessible/i);
    assert.deepStrictEqual(api.issuesProvider.getCurrentIssues(), []);
  });

  test('automatically reuses workspace .vscode/mcp.json when manual Jira Mini config is empty', async () => {
    const api = await getApi();
    await configureWorkspaceMcpScenario(api, 'default');

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    const keys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);

    assert.ok(keys.includes('APP-100'));
    assert.ok(keys.includes('APP-101'));
    assert.ok(keys.includes('APP-103'));
  });

  test('automatically reuses user/profile MCP config when manual and workspace config are empty', async () => {
    const api = await getApi();
    await configureUserMcpScenario(api, 'default');

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    const keys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);

    assert.ok(keys.includes('APP-100'));
    assert.ok(keys.includes('APP-101'));
    assert.ok(keys.includes('APP-103'));
  });

  test('loads demo data without any Jira connection when demo mode is enabled', async () => {
    const api = await getApi();
    await configureDemoScenario(api);

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);
    const issueKeys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);
    const boardNames = api.boardsProvider.getCurrentBoards().map(board => board.name);
    const result = await api.backendService.checkConnection();

    assert.ok(issueKeys.includes('APP-101'));
    assert.ok(issueKeys.includes('OPS-200'));
    assert.ok(boardNames.includes('Application Board'));
    assert.strictEqual(result.status, 'ok');
    assert.match(result.message, /demo mode active/i);
  });

  test('loads boards and applies board filters', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);
    const initialBoards = api.boardsProvider.getCurrentBoards().map(board => board.name).sort();
    assert.deepStrictEqual(initialBoards, ['Application Board', 'Operations Board', 'Platform Overview']);

    await api.boardStore.updateFilters({
      projectKeys: ['OPS']
    });
    await waitFor(() => api.boardsProvider.getCurrentBoards().length === 1);
    assert.deepStrictEqual(
      api.boardsProvider.getCurrentBoards().map(board => board.name),
      ['Operations Board']
    );

    await api.boardStore.updateFilters({
      projectKeys: [],
      types: ['scrum'],
      searchText: 'platform'
    });
    await waitFor(
      () =>
        api.boardsProvider.getCurrentBoards().length === 1 &&
        api.boardsProvider.getCurrentBoards()[0]?.name === 'Platform Overview'
    );
  });

  test('opens a board panel with status columns and syncs issue selection to details', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);
    const board = api.boardsProvider.getCurrentBoards().find(candidate => candidate.name === 'Application Board');
    assert.ok(board, 'Application Board should be available');

    await api.boardPanelManager.openBoard(board!);
    await waitFor(() => api.boardPanelManager.getSnapshot().issueCount > 0);

    const snapshot = api.boardPanelManager.getSnapshot();
    assert.deepStrictEqual(snapshot.columnNames, ['To Do', 'In Progress', 'Blocked']);

    await api.boardPanelManager.selectIssue('APP-101');
    await waitFor(() => api.detailsProvider.getActiveIssue()?.key === 'APP-101');

    assert.strictEqual(api.detailsProvider.getActiveIssue()?.key, 'APP-101');
    assert.strictEqual(api.boardPanelManager.getSnapshot().selectedIssueKey, 'APP-101');
  });

  test('supports epic scoping and successful status transitions', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await api.filterStore.updateFilters({
      projectKeys: ['APP']
    });
    await api.refresh();

    await api.filterStore.updateFilters({
      epicKey: 'APP-100'
    });
    await api.refresh();

    const epicKeys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);
    assert.deepStrictEqual(epicKeys.sort(), ['APP-101', 'APP-103']);

    await api.backendService.transitionIssue('APP-101', 'start-progress');
    await api.refresh();

    const updatedIssue = api.issuesProvider.getIssueByKey('APP-101');
    assert.strictEqual(updatedIssue?.status, 'In Progress');
  });

  test('surfaces workflow transition failures', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await assert.rejects(
      () => api.backendService.transitionIssue('APP-103', 'resume'),
      /extra fields are required/i
    );
  });

  test('falls back to parentEpic when parent queries are rejected', async () => {
    const api = await getApi();
    await configureScenario(api, 'parent-unsupported');

    await api.filterStore.updateFilters({
      projectKeys: ['APP'],
      epicKey: 'APP-100'
    });
    await api.refresh();

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    const keys = api.issuesProvider.getCurrentIssues().map(issue => issue.key).sort();
    assert.deepStrictEqual(keys, ['APP-101', 'APP-103']);
  });

  test('fails connection checks when required Jira capabilities are missing', async () => {
    const api = await getApi();
    await configureScenario(api, 'missing-capabilities');

    const result = await api.backendService.checkConnection();
    assert.strictEqual(result.status, 'error');
    assert.match(result.message, /missing required tools/i);
  });
});
