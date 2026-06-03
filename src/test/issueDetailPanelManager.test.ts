import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { AiSessionManager } from '../ai/aiSessionManager';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails } from '../types';
import { IssueDetailPanelManager } from '../views/issueDetailPanelManager';

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

function createIssue(): IssueDetails {
  return {
    key: 'APP-101',
    summary: 'Add delivery links to issue detail window',
    status: 'In Progress',
    issueType: 'Story',
    projectKey: 'APP',
    projectName: 'Application Platform',
    comments: [],
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
  };
}

suite('IssueDetailPanelManager', () => {
  test('renders linked Jira items in the full issue details window', () => {
    const workspaceState = new MemoryMemento();
    const manager = new IssueDetailPanelManager(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      new AiSessionManager(workspaceState),
      async () => {}
    );

    const html = (
      manager as unknown as {
        buildIssueBodyHtml: (issue: IssueDetails) => string;
      }
    ).buildIssueBodyHtml(createIssue());

    assert.match(html, /Linked Items/);
    assert.match(html, /code implemented in/i);
    assert.match(html, /resolved in/i);
    assert.match(html, /https:\/\/jira\.example\.com\/browse\/APP-77/);
    assert.match(html, /APP-77/);
    assert.match(html, /Implement delivery workflow/);

    manager.dispose();
  });
});
