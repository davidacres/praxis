import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TicketManagerExtensionApi } from '../extension';
import { createPlanTemplate } from '../file/planTemplate';

const EXTENSION_ID = 'local-dev.ticket-manager';
const WORKSPACE_MCP_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'mcp.json')
  : undefined;
const USER_MCP_OVERRIDE_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.ticket-manager-test', 'user-mcp.json')
  : undefined;
const PLAN_FILE_URI = vscode.workspace.workspaceFolders?.[0]
  ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'ticket-plan.jsonc')
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

async function getApi(): Promise<TicketManagerExtensionApi> {
  const extension = vscode.extensions.getExtension<TicketManagerExtensionApi>(EXTENSION_ID);
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

async function clearPlanFile(): Promise<void> {
  if (!PLAN_FILE_URI) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(PLAN_FILE_URI);
  } catch {
    // Ignore missing file.
  }
}

async function writePlanFile(contents: string): Promise<void> {
  if (!PLAN_FILE_URI) {
    throw new Error('A workspace folder is required for file mode tests.');
  }

  await vscode.workspace.fs.writeFile(PLAN_FILE_URI, Buffer.from(contents, 'utf8'));
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
    config.update('backendMode', 'jira', vscode.ConfigurationTarget.Workspace),
    config.update('planFilePath', '', vscode.ConfigurationTarget.Workspace),
    config.update('connectionType', 'stdio', vscode.ConfigurationTarget.Global),
    config.update('stdioCommand', '', vscode.ConfigurationTarget.Global),
    config.update('stdioArgs', [], vscode.ConfigurationTarget.Global),
    config.update('stdioCwd', '', vscode.ConfigurationTarget.Global),
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global),
    config.update('workspaceMcpServerName', '', vscode.ConfigurationTarget.Workspace),
    config.update('userMcpServerRef', '', vscode.ConfigurationTarget.Global)
  ]);

  await clearUserMcpOverride();
  await clearPlanFile();
  await api.backendService.reset();
  await api.filterStore.clearFilters();
  await api.boardStore.clearFilters();
  await api.detailsProvider.setIssue(undefined);
  api.boardPanelManager.dispose();
}

async function configureScenario(
  api: TicketManagerExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported'
): Promise<void> {
  await clearWorkspaceMcpFile();
  await clearUserMcpOverride();
  const serverPath = getServerPath();
  const config = vscode.workspace.getConfiguration('ticketManager');

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
  api: TicketManagerExtensionApi,
  scenario: 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported'
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

async function configureDemoScenario(api: TicketManagerExtensionApi): Promise<void> {
  await resetConnectionState(api);
  const config = vscode.workspace.getConfiguration('ticketManager');
  await config.update('backendMode', 'demo', vscode.ConfigurationTarget.Workspace);
  await api.backendService.reset();
  await api.refresh();
}

async function configureFileScenario(api: TicketManagerExtensionApi): Promise<void> {
  await resetConnectionState(api);
  const config = vscode.workspace.getConfiguration('ticketManager');
  await writePlanFile(createPlanTemplate(vscode.workspace.workspaceFolders?.[0]?.name));
  await Promise.all([
    config.update('backendMode', 'file', vscode.ConfigurationTarget.Workspace),
    config.update('planFilePath', '', vscode.ConfigurationTarget.Workspace)
  ]);
  await api.backendService.reset();
  await api.refresh();
}

suite('Ticket Manager Extension', () => {
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
    assert.ok(commands.includes('ticketManager.refresh'));
    assert.ok(commands.includes('ticketManager.checkConnection'));
    assert.ok(commands.includes('ticketManager.changeStatus'));
    assert.ok(commands.includes('ticketManager.importWorkspaceMcpConfig'));
    assert.ok(commands.includes('ticketManager.importUserMcpConfig'));
    assert.ok(commands.includes('ticketManager.setBackendMode'));
    assert.ok(commands.includes('ticketManager.openBoard'));
    assert.ok(commands.includes('ticketManager.setBoardProjects'));
    assert.ok(commands.includes('ticketManager.setBoardTypes'));
    assert.ok(commands.includes('ticketManager.setBoardSearchText'));
    assert.ok(commands.includes('ticketManager.openIssueFullDetails'));
    assert.ok(commands.includes('ticketManager.configureBoardColumns'));
    assert.ok(commands.includes('ticketManager.createIssue'));
  });

  test('loads my issues from the fake connected backend', async () => {
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

  test('reports a warning when no projects are accessible', async () => {
    const api = await getApi();
    await configureScenario(api, 'no-projects');

    const result = await api.backendService.checkConnection();
    assert.strictEqual(result.status, 'warning');
    assert.match(result.message, /no jira projects are accessible/i);
    assert.deepStrictEqual(api.issuesProvider.getCurrentIssues(), []);
  });

  test('automatically reuses workspace .vscode/mcp.json when manual config is empty', async () => {
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

  test('loads demo data without any connected backend when demo mode is enabled', async () => {
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

  test('creates issues through the connected backend and refreshes the sidebar', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    const createdIssue = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Story',
      summary: 'Create issue from integration test',
      parentKey: 'APP-100'
    });
    await api.refresh();

    await waitFor(() => Boolean(api.issuesProvider.getIssueByKey(createdIssue.key)));
    const issue = api.issuesProvider.getIssueByKey(createdIssue.key);
    assert.strictEqual(issue?.summary, 'Create issue from integration test');
    assert.strictEqual(issue?.status, 'To Do');

    const board = api.boardsProvider
      .getCurrentBoards()
      .find(candidate => candidate.name === 'Application Board');
    assert.ok(board, 'Application Board should be available after create');

    const boardDetails = await api.backendService.getBoardDetails(board!);
    assert.ok(
      boardDetails.issues.some(candidate => candidate.key === createdIssue.key),
      'Newly created connected issue should appear on the project board'
    );
  });

  test('loads file-backed plan data and persists status changes', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);

    const issueKeys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);
    const boardNames = api.boardsProvider.getCurrentBoards().map(board => board.name);
    const transitions = await api.backendService.getTransitions('APP-101');
    const moveToInProgress = transitions.find(transition => transition.toStatus === 'In Progress');
    assert.ok(moveToInProgress, 'File mode should expose transitions derived from plan statuses');

    assert.ok(issueKeys.includes('APP-100'));
    assert.ok(issueKeys.includes('APP-103'));
    assert.strictEqual(boardNames[0], `${vscode.workspace.workspaceFolders?.[0]?.name ?? 'Workspace Project'} Board`);

    await api.backendService.transitionIssue('APP-101', moveToInProgress!.id);
    await api.refresh();

    const updatedIssue = api.issuesProvider.getIssueByKey('APP-101');
    assert.strictEqual(updatedIssue?.status, 'In Progress');

    if (PLAN_FILE_URI) {
      const updatedText = Buffer.from(await vscode.workspace.fs.readFile(PLAN_FILE_URI)).toString('utf8');
      assert.match(updatedText, /"status": "In Progress"/);
    }
  });

  test('creates file-backed issues and persists them to the plan file', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    const board = api.boardsProvider.getCurrentBoards()[0];
    assert.ok(board, 'File mode should expose a board for create tests');

    const createdIssue = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Task',
      summary: 'Persist a newly created plan item',
      description: 'Created by the integration test.',
      parentKey: 'APP-100',
      boardId: board!.id
    });
    await api.refresh();

    await waitFor(() => Boolean(api.issuesProvider.getIssueByKey(createdIssue.key)));
    const issue = api.issuesProvider.getIssueByKey(createdIssue.key);
    assert.strictEqual(issue?.summary, 'Persist a newly created plan item');
    assert.strictEqual(issue?.status, 'To Do');

    const boardDetails = await api.backendService.getBoardDetails(board!);
    assert.ok(
      boardDetails.issues.some(candidate => candidate.key === createdIssue.key),
      'Newly created file-backed issue should appear on the target board'
    );

    if (PLAN_FILE_URI) {
      const updatedText = Buffer.from(await vscode.workspace.fs.readFile(PLAN_FILE_URI)).toString('utf8');
      assert.match(updatedText, new RegExp(`"key": "${createdIssue.key}"`));
      assert.match(updatedText, /"summary": "Persist a newly created plan item"/);
      assert.match(updatedText, /"parent": "APP-100"/);
    }
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
    await api.boardsProvider.refresh();
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
    await api.boardsProvider.refresh();
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

  test('supports parent-item scoping and successful status transitions', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await api.filterStore.updateFilters({
      projectKeys: ['APP']
    });
    await api.refresh();

    await api.filterStore.updateFilters({
      parentKey: 'APP-100'
    });
    await api.refresh();

    const childKeys = api.issuesProvider.getCurrentIssues().map(issue => issue.key);
    assert.deepStrictEqual(childKeys.sort(), ['APP-101', 'APP-103']);

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

  test('falls back to the alternate parent field when parent queries are rejected', async () => {
    const api = await getApi();
    await configureScenario(api, 'parent-unsupported');

    await api.filterStore.updateFilters({
      projectKeys: ['APP'],
      parentKey: 'APP-100'
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
