import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { FilterStore } from '../state/filterStore';
import type { IssueFilters, IssueSummary } from '../types';

export interface IssuesProviderSnapshot {
  issues: IssueSummary[];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage?: string;
}

abstract class BaseNode {
  public constructor(
    public readonly id: string,
    public readonly contextValue: string
  ) {}
}

class GroupNode extends BaseNode {
  public constructor(
    id: string,
    public readonly label: string,
    public readonly groupKey: string
  ) {
    super(id, 'group');
  }
}

class MessageNode extends BaseNode {
  public constructor(
    id: string,
    public readonly label: string,
    public readonly severity: 'info' | 'warning' | 'error'
  ) {
    super(id, 'message');
  }
}

export class IssueNode extends BaseNode {
  public constructor(public readonly issue: IssueSummary) {
    super(`issue:${issue.key}`, 'issue');
  }
}

export class LoadMoreNode extends BaseNode {
  public constructor() {
    super('loadMore', 'loadMore');
  }
}

type TreeNode = GroupNode | MessageNode | IssueNode | LoadMoreNode;

function getStatusIcon(statusCategory?: string): vscode.ThemeIcon | undefined {
  switch (statusCategory?.toLowerCase()) {
    case 'done':
      return new vscode.ThemeIcon('pass');
    case 'indeterminate':
      return new vscode.ThemeIcon('debug-pause');
    default:
      return new vscode.ThemeIcon('circle-filled');
  }
}

function getIssueDescription(issue: IssueSummary): string {
  const parts = [issue.status];
  if (issue.summary) {
    parts.push(issue.summary);
  }
  return parts.join(' • ');
}

export class IssuesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private issues: IssueSummary[] = [];
  private hasMore = false;
  private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private errorMessage?: string;
  private requestGeneration = 0;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly filterStore: FilterStore
  ) {}

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof GroupNode) {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.iconPath =
        element.groupKey === 'project' ? new vscode.ThemeIcon('repo') : new vscode.ThemeIcon('list-tree');
      return item;
    }

    if (element instanceof MessageNode) {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.iconPath =
        element.severity === 'error'
          ? new vscode.ThemeIcon('error')
          : element.severity === 'warning'
            ? new vscode.ThemeIcon('warning')
            : new vscode.ThemeIcon('info');
      return item;
    }

    if (element instanceof LoadMoreNode) {
      const item = new vscode.TreeItem('Load more issues', vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.iconPath = new vscode.ThemeIcon('chevron-down');
      item.command = {
        command: 'ticketManager.loadMore',
        title: 'Load More',
        arguments: [element]
      };
      return item;
    }

    const item = new vscode.TreeItem(element.issue.key, vscode.TreeItemCollapsibleState.None);
    item.id = element.id;
    item.contextValue = element.contextValue;
    item.description = getIssueDescription(element.issue);
    item.tooltip = [
      `${element.issue.key}: ${element.issue.summary}`,
      `${element.issue.projectKey || 'Unknown project'} • ${element.issue.issueType}`,
      element.issue.assignee ? `Assignee: ${element.issue.assignee}` : undefined,
      element.issue.updated ? `Updated: ${element.issue.updated}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    item.iconPath = getStatusIcon(element.issue.statusCategory);
    return item;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof GroupNode) {
      return this.getGroupedIssues(element);
    }

    if (this.status === 'idle') {
      void this.refresh();
      return [new MessageNode('loading', 'Loading issues...', 'info')];
    }

    if (this.status === 'loading' && this.issues.length === 0) {
      return [new MessageNode('loading', 'Loading issues...', 'info')];
    }

    if (this.status === 'error') {
      return [
        new MessageNode(
          'error',
          this.errorMessage ?? 'Unable to load issues.',
          'error'
        )
      ];
    }

    if (this.issues.length === 0) {
      return [this.buildEmptyNode()];
    }

    const filters = this.filterStore.getFilters();
    if (filters.grouping === 'none') {
      const nodes: TreeNode[] = this.issues.map(issue => new IssueNode(issue));
      if (this.hasMore) {
        nodes.push(new LoadMoreNode());
      }
      return nodes;
    }

    const labels =
      filters.grouping === 'status'
        ? unique(this.issues.map(issue => issue.status))
        : unique(this.issues.map(issue => issue.projectKey || 'Unknown project'));

    return labels.map(label => new GroupNode(`${filters.grouping}:${label}`, label, filters.grouping));
  }

  public async refresh(): Promise<void> {
    await this.loadPage(true);
  }

  public async loadMore(): Promise<void> {
    if (!this.hasMore || this.status === 'loading') {
      return;
    }

    await this.loadPage(false);
  }

  public getCurrentIssues(): IssueSummary[] {
    return [...this.issues];
  }

  public getSnapshot(): IssuesProviderSnapshot {
    return {
      issues: [...this.issues],
      hasMore: this.hasMore,
      status: this.status,
      errorMessage: this.errorMessage
    };
  }

  public getIssueByKey(issueKey: string): IssueSummary | undefined {
    return this.issues.find(issue => issue.key === issueKey);
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private async loadPage(reset: boolean): Promise<void> {
    const generation = ++this.requestGeneration;
    const startAt = reset ? 0 : this.issues.length;
    this.status = 'loading';
    if (reset) {
      this.errorMessage = undefined;
      this.issues = [];
      this.hasMore = false;
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);

    try {
      const filters = this.filterStore.getFilters();
      const page = await this.backendService.getIssues(
        filters,
        startAt,
        this.backendService.getDefaultPageSize()
      );

      if (generation !== this.requestGeneration) {
        return;
      }

      this.issues = reset ? page.issues : [...this.issues, ...page.issues];
      this.hasMore = page.hasMore;
      this.status = 'ready';
      this.errorMessage = undefined;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.issues = [];
      this.hasMore = false;
    } finally {
      if (generation === this.requestGeneration) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    }
  }

  private getGroupedIssues(groupNode: GroupNode): TreeNode[] {
    const matchingIssues = this.issues.filter(issue =>
      groupNode.groupKey === 'status'
        ? issue.status === groupNode.label
        : (issue.projectKey || 'Unknown project') === groupNode.label
    );

    const nodes: TreeNode[] = matchingIssues.map(issue => new IssueNode(issue));
    if (this.hasMore && groupNode.label === this.getLastGroupLabel()) {
      nodes.push(new LoadMoreNode());
    }
    return nodes;
  }

  private getLastGroupLabel(): string | undefined {
    const filters = this.filterStore.getFilters();
    const labels =
      filters.grouping === 'status'
        ? unique(this.issues.map(issue => issue.status))
        : unique(this.issues.map(issue => issue.projectKey || 'Unknown project'));
    return labels.at(-1);
  }

  private buildEmptyNode(): MessageNode {
    const filters = this.filterStore.getFilters();
    if (filters.parentKey) {
      return new MessageNode(
        'empty',
        `No issues found for parent item ${filters.parentKey}.`,
        'warning'
      );
    }

    return new MessageNode('empty', 'No issues match the current filters.', 'warning');
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
