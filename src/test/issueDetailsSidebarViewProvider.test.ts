import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { DetailsProviderSnapshot, DetailsViewProvider } from '../views/detailsViewProvider';
import { IssueDetailsSidebarViewProvider } from '../views/issueDetailsSidebarViewProvider';

class FakeDetailsProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private snapshot: DetailsProviderSnapshot) {}

  public getSnapshot(): DetailsProviderSnapshot {
    return this.snapshot;
  }

  public getActiveIssue(): DetailsProviderSnapshot['selectedIssue'] {
    return this.snapshot.selectedIssue;
  }

  public fireChange(): void {
    this.emitter.fire();
  }
}

function createFakeWebviewView(): vscode.WebviewView & {
  webview: {
    options: vscode.WebviewOptions;
    html: string;
    onDidReceiveMessage: (listener: (message: unknown) => void) => vscode.Disposable;
  };
  fireDispose: () => void;
} {
  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: (_listener: (message: unknown) => void) => new vscode.Disposable(() => {})
  };

  const disposeListeners: Array<() => void> = [];

  return {
    webview,
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return new vscode.Disposable(() => {});
    },
    fireDispose: () => {
      for (const listener of disposeListeners) {
        listener();
      }
    }
  } as unknown as vscode.WebviewView & {
    webview: {
      options: vscode.WebviewOptions;
      html: string;
      onDidReceiveMessage: (listener: (message: unknown) => void) => vscode.Disposable;
    };
    fireDispose: () => void;
  };
}

suite('IssueDetailsSidebarViewProvider', () => {
  test('renders a fallback error page instead of going blank', () => {
    const detailsProvider = new FakeDetailsProvider({
      loading: false,
      selectedIssue: {
        key: 'APP-100',
        summary: 'Core app epic',
        status: 'In Progress',
        issueType: 'Epic',
        projectKey: 'APP',
        projectName: 'Application Platform'
      },
      detailedIssue: {
        key: 'APP-100',
        summary: 'Core app epic',
        status: 'In Progress',
        issueType: 'Epic',
        projectKey: 'APP',
        projectName: 'Application Platform',
        comments: [],
        transitions: []
      },
      transitions: []
    });

    const provider = new IssueDetailsSidebarViewProvider(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      detailsProvider as unknown as DetailsViewProvider,
      {
        getSession: () => undefined,
        getAgentSession: () => undefined,
        getIssueWorkflowAssignment: () => undefined,
        onDidChangeSession: () => new vscode.Disposable(() => {}),
        onDidChangeAgentSession: () => new vscode.Disposable(() => {}),
        onDidChangeWorkflowAssignment: () => new vscode.Disposable(() => {})
      } as unknown as AiSessionManager,
      () => {
        throw new Error('agent lookup failed');
      },
      {
        onSaveIssueEdits: async () => {},
        onAddComment: async () => {},
        onRequestAiReview: async () => {}
      }
    );

    const view = createFakeWebviewView();
    provider.resolveWebviewView(view);

    assert.match(view.webview.html, /Unable to render issue details/i);
    assert.match(view.webview.html, /agent lookup failed/i);
    assert.match(view.webview.html, /APP-100/);

    provider.dispose();
  });

  test('renders linked Jira items with relationship labels', () => {
    const detailsProvider = new FakeDetailsProvider({
      loading: false,
      selectedIssue: {
        key: 'APP-101',
        summary: 'Add delivery links to details pane',
        status: 'In Progress',
        issueType: 'Story',
        projectKey: 'APP',
        projectName: 'Application Platform'
      },
      detailedIssue: {
        key: 'APP-101',
        summary: 'Add delivery links to details pane',
        status: 'In Progress',
        issueType: 'Story',
        projectKey: 'APP',
        projectName: 'Application Platform',
        comments: [],
        transitions: [],
        linkedIssues: [
          {
            key: 'APP-77',
            summary: 'Implement delivery workflow',
            issueType: 'Task',
            status: 'Done',
            relationship: 'code implemented in',
            browseUrl: 'https://jira.example.com/browse/APP-77'
          },
          {
            key: 'APP-88',
            summary: 'Release package update',
            relationship: 'resolved in'
          }
        ]
      },
      transitions: []
    });

    const provider = new IssueDetailsSidebarViewProvider(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      detailsProvider as unknown as DetailsViewProvider,
      {
        getSession: () => undefined,
        getAgentSession: () => undefined,
        getIssueWorkflowAssignment: () => undefined,
        onDidChangeSession: () => new vscode.Disposable(() => {}),
        onDidChangeAgentSession: () => new vscode.Disposable(() => {}),
        onDidChangeWorkflowAssignment: () => new vscode.Disposable(() => {})
      } as unknown as AiSessionManager,
      () => [],
      {
        onSaveIssueEdits: async () => {},
        onAddComment: async () => {},
        onRequestAiReview: async () => {}
      }
    );

    const view = createFakeWebviewView();
    provider.resolveWebviewView(view);

    assert.match(view.webview.html, /Linked Items/);
    assert.match(view.webview.html, /code implemented in/i);
    assert.match(view.webview.html, /resolved in/i);
    assert.match(view.webview.html, /https:\/\/jira\.example\.com\/browse\/APP-77/);
    assert.match(view.webview.html, /APP-77/);
    assert.match(view.webview.html, /Implement delivery workflow/);

    provider.dispose();
  });

  test('does not throw "Webview is disposed" after the view is disposed (mode switch)', () => {
    const detailsProvider = new FakeDetailsProvider({
      loading: false,
      selectedIssue: {
        key: 'APP-100',
        summary: 'Core app epic',
        status: 'In Progress',
        issueType: 'Epic',
        projectKey: 'APP',
        projectName: 'Application Platform'
      },
      detailedIssue: undefined,
      transitions: []
    });

    const provider = new IssueDetailsSidebarViewProvider(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      detailsProvider as unknown as DetailsViewProvider,
      {
        getSession: () => undefined,
        getAgentSession: () => undefined,
        getIssueWorkflowAssignment: () => undefined,
        onDidChangeSession: () => new vscode.Disposable(() => {}),
        onDidChangeAgentSession: () => new vscode.Disposable(() => {}),
        onDidChangeWorkflowAssignment: () => new vscode.Disposable(() => {})
      } as unknown as AiSessionManager,
      () => [],
      {
        onSaveIssueEdits: async () => {},
        onAddComment: async () => {},
        onRequestAiReview: async () => {}
      }
    );

    const view = createFakeWebviewView();
    provider.resolveWebviewView(view);

    // Simulate VS Code disposing the view when its container is hidden during a
    // classic <-> work mode switch.
    view.fireDispose();

    // A subsequent render (triggered via the details provider change event) must
    // be a no-op rather than throwing "Webview is disposed".
    assert.doesNotThrow(() => {
      detailsProvider.fireChange();
    });

    provider.dispose();
  });
});

