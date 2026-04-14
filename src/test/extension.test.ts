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

async function writePlanFile(contents: string): Promise<void> {
  if (!PLAN_FILE_URI) {
    throw new Error('A workspace folder is required for file mode tests.');
  }

  await vscode.workspace.fs.writeFile(PLAN_FILE_URI, Buffer.from(contents, 'utf8'));
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
    config.update('backendMode', 'jira', vscode.ConfigurationTarget.Workspace),
    config.update('planFilePath', '', vscode.ConfigurationTarget.Workspace),
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
    config.update('httpUrl', '', vscode.ConfigurationTarget.Global),
    config.update('workspaceMcpServerName', '', vscode.ConfigurationTarget.Workspace),
    config.update('userMcpServerRef', '', vscode.ConfigurationTarget.Global)
  ]);

  await clearUserMcpOverride();
  await clearPlanFile();
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
  await api.boardColumnStore.clearAllPreferences();
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
    assert.ok(commands.includes('ticketManager.importWorkspaceMcpConfig'));
    assert.ok(commands.includes('ticketManager.importUserMcpConfig'));
    assert.ok(commands.includes('ticketManager.setBackendMode'));
    assert.ok(commands.includes('ticketManager.openSettings'));
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
    assert.ok(issueKeys.includes('APP-103'), 'Bug APP-103 should appear in My Issues');
    const bugIssue = api.issuesProvider.getCurrentIssues().find(issue => issue.key === 'APP-103');
    assert.strictEqual(bugIssue?.issueType, 'Bug', 'APP-103 should be typed as Bug');
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
    assert.strictEqual(issue?.status, 'Backlog');

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

  test('supports connected task and subtask parent rules with parent metadata', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    const createdTask = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Task',
      summary: 'Connected task under epic',
      parentKey: 'APP-100'
    });
    assert.strictEqual(createdTask.parentKey, 'APP-100');
    assert.strictEqual(createdTask.parentIssue?.issueType, 'Epic');
    assert.strictEqual(createdTask.parentIssue?.summary, 'Core app epic');

    const createdSubtask = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Subtask',
      summary: 'Connected subtask under story',
      parentKey: 'APP-101'
    });
    assert.strictEqual(createdSubtask.parentKey, 'APP-101');
    assert.strictEqual(createdSubtask.parentIssue?.issueType, 'Story');
    assert.strictEqual(createdSubtask.parentIssue?.summary, 'Implement MCP adapter');
    assert.ok(createdSubtask.parentIssue?.description);

    await assert.rejects(
      () =>
        api.backendService.createIssue({
          projectKey: 'APP',
          issueType: 'Task',
          summary: 'Invalid connected task parent',
          parentKey: 'APP-101'
        }),
      /Epic/i
    );
    await assert.rejects(
      () =>
        api.backendService.createIssue({
          projectKey: 'APP',
          issueType: 'Subtask',
          summary: 'Invalid connected subtask parent',
          parentKey: 'APP-100'
        }),
      /Story/i
    );
  });

  test('updates connected issues, reassigns EPICs, and deletes created EPICs', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    const createdEpic = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Epic',
      summary: 'Connected EPIC for edit flow'
    });

    const updatedIssue = await api.backendService.updateIssue('APP-101', {
      summary: 'Connected issue updated from integration test',
      description: 'Updated description from the integration test.',
      parentKey: createdEpic.key,
      assignee: 'Jordan Builder',
      priority: 'Medium',
      issueType: 'Task'
    });
    assert.strictEqual(updatedIssue.summary, 'Connected issue updated from integration test');
    assert.strictEqual(updatedIssue.parentKey, createdEpic.key);
    assert.strictEqual(updatedIssue.assignee, 'Jordan Builder');
    assert.strictEqual(updatedIssue.priority, 'Medium');
    assert.strictEqual(updatedIssue.issueType, 'Task');
    assert.ok(updatedIssue.created, 'Connected issue details should include a created timestamp');

    await api.refresh();
    assert.strictEqual(api.issuesProvider.getIssueByKey('APP-101'), undefined);

    await api.backendService.deleteIssue(createdEpic.key);
    await api.refresh();

    await assert.rejects(
      () => api.backendService.getIssue(createdEpic.key),
      /was not found/i
    );
    const reassignedIssue = await api.backendService.getIssue('APP-101');
    assert.strictEqual(reassignedIssue.parentKey, undefined);
  });

  test('adds connected comments and exposes them in issue details', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await api.backendService.addComment('APP-101', 'Connected comment from the integration test.');
    const issue = await api.backendService.getIssue('APP-101');
    assert.ok(issue.comments && issue.comments.length > 0);
    assert.strictEqual(issue.comments?.[0]?.body, 'Connected comment from the integration test.');
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
    assert.strictEqual(issue?.status, 'Backlog');

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

  test('supports file-backed task and subtask parent rules with parent metadata', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    const createdTask = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Task',
      summary: 'File task under feature',
      parentKey: 'APP-100'
    });
    assert.strictEqual(createdTask.parentKey, 'APP-100');
    assert.strictEqual(createdTask.parentIssue?.issueType, 'Feature');
    assert.strictEqual(createdTask.parentIssue?.summary, 'Define the primary feature');

    const createdSubtask = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Subtask',
      summary: 'File subtask under story',
      parentKey: 'APP-101'
    });
    assert.strictEqual(createdSubtask.parentKey, 'APP-101');
    assert.strictEqual(createdSubtask.parentIssue?.issueType, 'Story');
    assert.strictEqual(createdSubtask.parentIssue?.summary, 'Write the first story');
    assert.ok(createdSubtask.parentIssue?.description);

    await assert.rejects(
      () =>
        api.backendService.createIssue({
          projectKey: 'APP',
          issueType: 'Task',
          summary: 'Invalid file task parent',
          parentKey: 'APP-101'
        }),
      /Epic|Feature/i
    );
    await assert.rejects(
      () =>
        api.backendService.createIssue({
          projectKey: 'APP',
          issueType: 'Subtask',
          summary: 'Invalid file subtask parent',
          parentKey: 'APP-100'
        }),
      /Story/i
    );
  });

  test('updates and deletes file-backed issues while persisting EPIC assignment changes', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    const createdIssue = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Task',
      summary: 'Temporary file-backed task',
      description: 'Temporary description',
      parentKey: 'APP-100'
    });

    const updatedIssue = await api.backendService.updateIssue(createdIssue.key, {
      summary: 'Updated file-backed task',
      description: 'Updated file-backed description',
      parentKey: null,
      assignee: 'Taylor Planner',
      priority: 'Low',
      issueType: 'Bug'
    });
    assert.strictEqual(updatedIssue.summary, 'Updated file-backed task');
    assert.strictEqual(updatedIssue.parentKey, undefined);
    assert.strictEqual(updatedIssue.assignee, 'Taylor Planner');
    assert.strictEqual(updatedIssue.priority, 'Low');
    assert.strictEqual(updatedIssue.issueType, 'Bug');
    assert.ok(updatedIssue.created, 'File-backed issue details should include a created timestamp');

    await api.refresh();
    assert.strictEqual(api.issuesProvider.getIssueByKey(createdIssue.key), undefined);

    await api.backendService.deleteIssue(createdIssue.key);
    await api.refresh();

    assert.strictEqual(api.issuesProvider.getIssueByKey(createdIssue.key), undefined);
    await assert.rejects(
      () => api.backendService.getIssue(createdIssue.key),
      /was not found/i
    );

    if (PLAN_FILE_URI) {
      const updatedText = Buffer.from(await vscode.workspace.fs.readFile(PLAN_FILE_URI)).toString('utf8');
      assert.ok(
        !updatedText.includes(`"key": "${createdIssue.key}"`),
        'Deleted plan item should be removed from the plan file'
      );
    }
  });

  test('adds file-backed comments and persists them to the plan file', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    await api.backendService.addComment('APP-101', 'Plan comment from the integration test.');
    const issue = await api.backendService.getIssue('APP-101');
    assert.ok(issue.comments && issue.comments.length > 0);
    assert.strictEqual(issue.comments?.[0]?.body, 'Plan comment from the integration test.');

    if (PLAN_FILE_URI) {
      const updatedText = Buffer.from(await vscode.workspace.fs.readFile(PLAN_FILE_URI)).toString('utf8');
      assert.match(updatedText, /"comments": \[/);
      assert.match(updatedText, /"body": "Plan comment from the integration test\."/);
    }
  });

  test('assigns file-backed issues to AI, updates assignee, and moves status in progress', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    const config = vscode.workspace.getConfiguration('ticketManager');
    await Promise.all([
      config.update('ai.openaiApiKey', 'test-openai-key', vscode.ConfigurationTarget.Global),
      config.update('ai.openaiAgentName', 'Planner Bot', vscode.ConfigurationTarget.Global)
    ]);

    const issue = await api.backendService.getIssue('APP-101');
    await api.detailsProvider.setIssue(issue);

    await vscode.commands.executeCommand('ticketManager.assignToAi');

    const updatedIssue = await api.backendService.getIssue('APP-101');
    const session = api.aiSessionManager.getSession('APP-101');

    assert.strictEqual(updatedIssue.assignee, 'Planner Bot');
    assert.strictEqual(updatedIssue.status, 'In Progress');
    assert.ok(session, 'AI assignment should create a session record');
    assert.strictEqual(session?.label, 'Planner Bot');
    assert.strictEqual(session?.status, 'active');
  });

  test('creates live-folder features and child issues by writing markdown files', async () => {
    const api = await getApi();
    const fixture = await configureLiveFolderScenario(api);

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);
    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);

    const createdFeature = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Feature',
      summary: 'Payments platform',
      description: 'Own the payment orchestration work.'
    });
    const createdBug = await api.backendService.createIssue({
      projectKey: 'APP',
      issueType: 'Bug',
      summary: 'Fix login timeout',
      description: 'Resolve the token refresh timeout.',
      parentKey: fixture.featureKey
    });

    await api.refresh();
    await waitFor(() => Boolean(api.issuesProvider.getIssueByKey(createdFeature.key)));
    await waitFor(() => Boolean(api.issuesProvider.getIssueByKey(createdBug.key)));

    assert.strictEqual(createdFeature.issueType, 'Feature');
    assert.strictEqual(createdBug.issueType, 'Bug');
    assert.strictEqual(createdBug.parentKey, fixture.featureKey);
    assert.strictEqual(createdBug.parentIssue?.issueType, 'Feature');

    const createdFeatureFileUri = vscode.Uri.joinPath(
      fixture.featuresRootUri,
      'feature-02-payments-platform',
      'feature.md'
    );
    const createdFeatureText = Buffer.from(
      await vscode.workspace.fs.readFile(createdFeatureFileUri)
    ).toString('utf8');
    assert.match(createdFeatureText, /# Payments platform/);
    assert.match(createdFeatureText, /\*\*Status:\*\* 📋 Proposed/);

    const createdBugFileUri = vscode.Uri.joinPath(
      fixture.featureDirUri,
      'bug-01-1-fix-login-timeout.md'
    );
    const createdBugText = Buffer.from(await vscode.workspace.fs.readFile(createdBugFileUri)).toString(
      'utf8'
    );
    assert.match(createdBugText, /# Fix login timeout/);
    assert.match(createdBugText, /\*\*Parent:\*\* APP-F01/);

    const parentFeatureText = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fixture.featureDirUri, 'feature.md'))
    ).toString('utf8');
    assert.match(parentFeatureText, /\| 01\.1 \| Bug \| Fix login timeout \| 📋 Proposed \|/);

    const board = api.boardsProvider.getCurrentBoards()[0];
    assert.ok(board, 'Live Folder mode should expose a board');
    const boardDetails = await api.backendService.getBoardDetails(board!);
    assert.ok(
      boardDetails.issues.some(issue => issue.key === createdBug.key),
      'Newly created live-folder issue should appear on the live board'
    );
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

  test('adds live-folder comments and persists them to the markdown file', async () => {
    const api = await getApi();
    const fixture = await configureLiveFolderScenario(api);

    await waitFor(() => api.issuesProvider.getCurrentIssues().length > 0);

    // Add a comment to the fixture story
    await api.backendService.addComment(fixture.storyKey, 'First live-folder comment.');

    // Verify comment is returned in issue details
    const details = await api.backendService.getIssue(fixture.storyKey);
    assert.ok(details.comments, 'Issue should have comments');
    assert.strictEqual(details.comments!.length, 1);
    assert.strictEqual(details.comments![0].body, 'First live-folder comment.');
    assert.strictEqual(details.comments![0].author, 'Me');

    // Verify comment is persisted in the markdown file
    const storyText = Buffer.from(
      await vscode.workspace.fs.readFile(fixture.storyFileUri)
    ).toString('utf8');
    assert.match(storyText, /## Comments/);
    assert.match(storyText, /\*\*Me\*\*/);
    assert.match(storyText, /First live-folder comment\./);

    // Add a second comment and verify both are returned
    await api.backendService.addComment(fixture.storyKey, 'Second comment.');
    const details2 = await api.backendService.getIssue(fixture.storyKey);
    assert.strictEqual(details2.comments!.length, 2);
    assert.strictEqual(details2.comments![1].body, 'Second comment.');
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
    assert.deepStrictEqual(snapshot.columnNames, ['Backlog', 'To Do', 'In Progress', 'Blocked']);

    const boardDetails = await api.backendService.getBoardDetails(board!);
    const bugOnBoard = boardDetails.issues.find(issue => issue.key === 'APP-103');
    assert.ok(bugOnBoard, 'Bug APP-103 should appear on the Application Board');
    assert.strictEqual(bugOnBoard?.issueType, 'Bug', 'APP-103 should be typed as Bug on the board');

    await api.boardPanelManager.selectIssue('APP-101');
    await waitFor(() => api.detailsProvider.getActiveIssue()?.key === 'APP-101');

    assert.strictEqual(api.detailsProvider.getActiveIssue()?.key, 'APP-101');
    assert.strictEqual(api.boardPanelManager.getSnapshot().selectedIssueKey, 'APP-101');
  });

  test('applies saved board workflow overrides before column customization', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await waitFor(() => api.boardsProvider.getCurrentBoards().length > 0);
    const board = api.boardsProvider.getCurrentBoards().find(candidate => candidate.name === 'Application Board');
    assert.ok(board, 'Application Board should be available');

    await api.boardColumnStore.setPreferences(board!.id, {
      workflowStatuses: ['Backlog', 'Ready for QA', 'Done'],
      orderedStatuses: []
    });

    await api.boardPanelManager.openBoard(board!);
    await waitFor(() => api.boardPanelManager.getSnapshot().issueCount > 0);
    await waitFor(() =>
      api.boardPanelManager.getSnapshot().columnNames.join('|') ===
      ['Backlog', 'Ready for QA', 'Done', 'Other statuses'].join('|')
    );

    assert.deepStrictEqual(api.boardPanelManager.getSnapshot().columnNames, [
      'Backlog',
      'Ready for QA',
      'Done',
      'Other statuses'
    ]);
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

  test('applies stored status filters to parent-item queries used by the EPICs view', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    await api.filterStore.updateFilters({
      projectKeys: ['APP'],
      statuses: ['Blocked']
    });
    await api.filterStore.setEpicStatuses(['In Progress']);

    const inProgressParents = await api.backendService.getParentItems({
      ...api.filterStore.getFilters(),
      statuses: api.filterStore.getEpicStatuses()
    });
    assert.deepStrictEqual(inProgressParents.map(item => item.key), ['APP-100']);

    await api.filterStore.setEpicStatuses(['Blocked']);

    const blockedParents = await api.backendService.getParentItems({
      ...api.filterStore.getFilters(),
      statuses: api.filterStore.getEpicStatuses()
    });
    assert.deepStrictEqual(blockedParents, []);
  });

  test('includes transition-based workflow statuses in connected filter metadata', async () => {
    const api = await getApi();
    await configureScenario(api, 'default');

    const metadata = await api.backendService.getFilterMetadata({
      ...api.filterStore.getFilters(),
      projectKeys: ['APP'],
      parentKey: 'APP-100',
      assigneeMode: 'all'
    });

    assert.ok(metadata.statuses.includes('To Do'));
    assert.ok(metadata.statuses.includes('Blocked'));
    assert.ok(metadata.statuses.includes('In Progress'));
    assert.ok(metadata.statuses.includes('Backlog'));
    assert.ok(metadata.statuses.includes('Done'));
  });

  test('includes workflow-defined statuses in file filter metadata even when unused', async () => {
    const api = await getApi();
    await configureFileScenario(api);

    const metadata = await api.backendService.getFilterMetadata({
      ...api.filterStore.getFilters(),
      projectKeys: ['APP'],
      assigneeMode: 'all'
    });

    assert.ok(metadata.statuses.includes('Backlog'));
    assert.ok(metadata.statuses.includes('To Do'));
    assert.ok(metadata.statuses.includes('In Progress'));
    assert.ok(metadata.statuses.includes('Blocked'));
    assert.ok(metadata.statuses.includes('Done'));
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
