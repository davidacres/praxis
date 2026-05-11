import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import {
  buildGitLabSetupUpdates,
  canPromptForGitLabBoardSelection,
  createGitLabBoardSelectionSummary,
  getGitLabSetupValues,
  hasConfiguredJiraMcpConnection
} from '../views/setupSidebarViewProvider';

function createConfig(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
  return {
    get<T>(section: string, defaultValue?: T): T {
      return (section in values ? values[section] : defaultValue) as T;
    }
  } as vscode.WorkspaceConfiguration;
}

suite('setupSidebarViewProvider', () => {
  test('treats imported workspace or user Jira MCP references as configured', () => {
    const config = createConfig({
      workspaceMcpServerName: 'jira-workspace-server'
    });

    assert.strictEqual(hasConfiguredJiraMcpConnection(config), true);
    assert.strictEqual(
      hasConfiguredJiraMcpConnection(
        createConfig({
          userMcpServerRef: 'C:/Users/me/AppData/Roaming/Code/User/mcp.json::jira'
        })
      ),
      true
    );
  });

  test('treats manual Jira MCP connection settings as configured', () => {
    assert.strictEqual(
      hasConfiguredJiraMcpConnection(
        createConfig({
          connectionType: 'stdio',
          stdioCommand: 'node'
        })
      ),
      true
    );
    assert.strictEqual(
      hasConfiguredJiraMcpConnection(
        createConfig({
          connectionType: 'http',
          httpUrl: 'https://mcp.example.test'
        })
      ),
      true
    );
  });

  test('returns false when no Jira MCP connection is configured', () => {
    assert.strictEqual(hasConfiguredJiraMcpConnection(createConfig({})), false);
  });

  test('loads stored GitLab setup values including project path settings', () => {
    const values = getGitLabSetupValues(
      createConfig({
        gitlabUrl: 'https://gitlab.example.com',
        gitlabConnectionType: 'api',
        gitlabApiKey: 'token',
        gitlabProjectPath: 'group/project',
        gitlabListAllAccessibleBoards: true,
        gitlabMcpCommand: 'node',
        gitlabMcpArgs: ['server.js', '--flag']
      })
    );

    assert.deepStrictEqual(values, {
      gitlabUrl: 'https://gitlab.example.com',
      gitlabConnectionType: 'api',
      gitlabApiKey: 'token',
      gitlabProjectPath: 'group/project',
      gitlabListAllAccessibleBoards: true,
      gitlabMcpCommand: 'node',
      gitlabMcpArgs: 'server.js --flag'
    });
  });

  test('builds GitLab setup updates including project path and board scope', () => {
    const updates = buildGitLabSetupUpdates({
      gitlabUrl: 'https://gitlab.example.com',
      gitlabConnectionType: 'api',
      gitlabApiKey: 'token',
      gitlabProjectPath: 'group/project',
      gitlabListAllAccessibleBoards: 'true'
    });

    assert.deepStrictEqual(updates, [
      { key: 'gitlabConnectionType', value: 'api' },
      { key: 'gitlabProjectPath', value: 'group/project' },
      { key: 'gitlabListAllAccessibleBoards', value: true },
      { key: 'gitlabUrl', value: 'https://gitlab.example.com' },
      { key: 'gitlabApiKey', value: 'token' }
    ]);
  });

  test('only prompts for GitLab project and board selection in API mode with credentials', () => {
    assert.strictEqual(
      canPromptForGitLabBoardSelection({
        gitlabConnectionType: 'api',
        gitlabUrl: 'https://gitlab.example.com',
        gitlabApiKey: 'token'
      }),
      true
    );

    assert.strictEqual(
      canPromptForGitLabBoardSelection({
        gitlabConnectionType: 'mcp',
        gitlabUrl: 'https://gitlab.example.com',
        gitlabApiKey: 'token'
      }),
      false
    );
  });

  test('creates an openable Ticket Manager board summary from GitLab board data', () => {
    const summary = createGitLabBoardSelectionSummary(
      {
        id: 10,
        name: 'Delivery',
        hideBacklogList: false,
        hideClosedList: false,
        project: {
          id: 1,
          name: 'Project',
          path: 'project',
          pathWithNamespace: 'group/project'
        },
        labels: [],
        lists: [],
        raw: { id: 10 }
      },
      {
        id: 1,
        name: 'Project',
        path: 'project',
        pathWithNamespace: 'group/project'
      },
      'https://gitlab.example.com/'
    );

    assert.deepStrictEqual(summary, {
      id: 'gitlab:1:10',
      name: 'Delivery',
      type: 'issue-board',
      projectKey: 'group/project',
      projectName: 'Project',
      locationName: 'https://gitlab.example.com',
      raw: {
        id: 10,
        name: 'Delivery',
        hideBacklogList: false,
        hideClosedList: false,
        project: {
          id: 1,
          name: 'Project',
          path: 'project',
          pathWithNamespace: 'group/project'
        },
        labels: [],
        lists: [],
        raw: { id: 10 }
      }
    });
  });
});