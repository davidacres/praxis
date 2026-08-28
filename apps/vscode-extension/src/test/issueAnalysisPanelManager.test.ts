import * as assert from 'assert';
import * as vscode from 'vscode';
import { AiSessionManager } from '@praxis/core';
import type { IssueDetails } from '@praxis/core';
import { IssueAnalysisPanelManager } from '../views/issueAnalysisPanelManager';

class MemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T {
    return (this.store.get(key) as T) ?? (defaultValue as T);
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, value);
  }

  public keys(): readonly string[] {
    return [...this.store.keys()];
  }

  public setKeysForSync(): void {
    // No-op for tests.
  }
}

function createIssue(issueKey: string): IssueDetails {
  return {
    key: issueKey,
    summary: 'Analysis test issue',
    status: 'To Do',
    issueType: 'Story',
    projectKey: 'APP',
    projectName: 'Application Platform',
    comments: [],
    transitions: []
  };
}

suite('IssueAnalysisPanelManager', () => {
  test('handles webview messages posted during initial html assignment', async () => {
    const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    const order: string[] = [];
    const logs: string[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    let disposeListener: (() => void) | undefined;

    const webview = {
      postMessage: async () => true,
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        order.push('listener');
        messageListener = listener;
        return new vscode.Disposable(() => {
          messageListener = undefined;
        });
      }
    } as unknown as {
      html: string;
      postMessage: (message: unknown) => Thenable<boolean>;
      onDidReceiveMessage: (listener: (message: unknown) => void) => vscode.Disposable;
    };

    let htmlValue = '';
    Object.defineProperty(webview, 'html', {
      get: () => htmlValue,
      set: (value: string) => {
        order.push('html');
        htmlValue = value;
        messageListener?.({ type: 'debugLog', detail: 'boot message' });
      },
      enumerable: true,
      configurable: true
    });

    const panel = {
      webview,
      reveal: () => {},
      dispose: () => {
        disposeListener?.();
      },
      onDidDispose: (listener: () => void) => {
        disposeListener = listener;
        return new vscode.Disposable(() => {
          disposeListener = undefined;
        });
      }
    } as unknown as vscode.WebviewPanel;

    (vscode.window as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel = () => panel;

    try {
      const workspaceState = new MemoryMemento();
      const manager = new IssueAnalysisPanelManager(
        workspaceState,
        new AiSessionManager(workspaceState),
        () => 'Default analysis prompt',
        () => 'gpt-5.4',
        () => 'Test Provider',
        () => [],
        () => [],
        async (issueKey: string) => createIssue(issueKey),
        message => {
          logs.push(message);
        },
        async () => 'analysis complete'
      );

      await manager.open('APP-1');

      assert.deepStrictEqual(order.slice(0, 2), ['listener', 'html']);
      assert.ok(logs.some(message => message.includes('[IssueAnalysis] Webview APP-1: boot message')));

      manager.dispose();
    } finally {
      (vscode.window as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel = originalCreateWebviewPanel;
    }
  });

  test('renders a syntactically valid webview script', () => {
    const workspaceState = new MemoryMemento();
    const manager = new IssueAnalysisPanelManager(
      workspaceState,
      new AiSessionManager(workspaceState),
      () => 'Default analysis prompt',
      () => 'gpt-5.4',
      () => 'Test Provider',
      () => [],
      () => [],
      async (issueKey: string) => createIssue(issueKey),
      () => {},
      async () => 'analysis complete'
    );

    const html = (
      manager as unknown as {
        renderHtml: (webview: vscode.Webview, context: unknown) => string;
      }
    ).renderHtml({} as vscode.Webview, {
      issue: createIssue('APP-1'),
      state: {
        issueKey: 'APP-1',
        model: 'gpt-5.4',
        confirmed: false,
        messages: [],
        repositories: []
      },
      defaultPrompt: 'Default analysis prompt',
      providerLabel: 'Test Provider',
      availableModels: [],
      workspaceFolders: []
    });

    const scriptMatch = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch, 'expected the analysis webview to include an inline script');
    const script = scriptMatch?.[1] ?? '';
    assert.doesNotThrow(() => new Function(script));
    assert.ok(script.includes("replace(/\\r\\n/g, '\\n')"));
    assert.ok(script.includes('/^\\d+\\.\\s+(.+)$/'));
  });
});