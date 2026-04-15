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
}

function createFakeWebviewView(): vscode.WebviewView & {
  webview: {
    options: vscode.WebviewOptions;
    html: string;
    onDidReceiveMessage: (listener: (message: unknown) => void) => vscode.Disposable;
  };
} {
  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: (_listener: (message: unknown) => void) => new vscode.Disposable(() => {})
  };

  return {
    webview
  } as unknown as vscode.WebviewView & {
    webview: {
      options: vscode.WebviewOptions;
      html: string;
      onDidReceiveMessage: (listener: (message: unknown) => void) => vscode.Disposable;
    };
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
      { mode: 'jira' } as unknown as IssueTrackerService,
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
});
