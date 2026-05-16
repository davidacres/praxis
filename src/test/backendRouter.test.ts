import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { BackendRouter } from '../backends/backendRouter';

function createRouter(mode: 'github' | 'gitlab'): BackendRouter {
  const context = {
    globalState: {
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined
    }
  } as unknown as vscode.ExtensionContext;

  const configStore = {
    getEffectiveBackendMode: () => mode,
    getDefaultPageSize: () => 25
  } as never;

  const output = {
    appendLine: () => undefined
  } as unknown as vscode.OutputChannel;

  return new BackendRouter(context, configStore, output);
}

suite('backendRouter', () => {
  test('reports GitLab mode as unsupported instead of falling back to Jira', async () => {
    const router = createRouter('gitlab');
    try {
      const result = await router.checkConnection();
      assert.strictEqual(result.status, 'error');
      assert.match(result.message, /GitLab project mode is not implemented yet/i);
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