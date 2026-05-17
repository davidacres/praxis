import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { BackendRouter } from '../backends/backendRouter';

function createRouter(mode: 'github' | 'gitlab'): BackendRouter {
  const context = {
    globalState: {
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined
    }
  } as unknown as vscode.ExtensionContext;

  const configStore = {
    getEffectiveBackendMode: () => mode,
    getDefaultPageSize: () => 25,
    getGitLabApiKey: () => '',
    getGitLabUrl: () => 'https://gitlab.com',
    getGitLabProjectPath: () => '',
    getGitLabSelectedBoardRefs: () => [],
    getGitLabListAllAccessibleBoards: () => false,
    getGitLabApiKeyFromSecrets: async () => ''
  } as never;

  const output = {
    appendLine: () => undefined
  } as unknown as vscode.OutputChannel;

  return new BackendRouter(context, configStore, output);
}

suite('backendRouter', () => {
  test('routes GitLab mode to GitLab service instead of unsupported fallback', async () => {
    const router = createRouter('gitlab');
    try {
      await assert.rejects(
        router.checkConnection(),
        error => {
          const message = error instanceof Error ? error.message : String(error);
          assert.doesNotMatch(message, /GitLab project mode is not implemented yet/i);
          assert.match(message, /No GitLab API key is configured/i);
          return true;
        }
      );
    } finally {
      router.dispose();
    }
  });

  test('reports GitHub mode as unsupported instead of falling back to Jira', async () => {
    const router = createRouter('github');
    try {
      const result = await router.checkConnection();
      assert.strictEqual(result.status, 'error');
      assert.match(result.message, /GitHub project mode is not implemented yet/i);
    } finally {
      router.dispose();
    }
  });
});