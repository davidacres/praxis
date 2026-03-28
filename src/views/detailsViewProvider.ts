import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { JiraIssueDetails, JiraIssueSummary, JiraTransition } from '../types';

abstract class DetailsNode {
  public constructor(
    public readonly id: string,
    public readonly contextValue: string
  ) {}
}

class DetailsMessageNode extends DetailsNode {
  public constructor(
    id: string,
    public readonly label: string,
    public readonly severity: 'info' | 'warning' | 'error'
  ) {
    super(id, 'message');
  }
}

class DetailsFieldNode extends DetailsNode {
  public constructor(
    id: string,
    public readonly label: string,
    public readonly value: string,
    public readonly icon?: vscode.ThemeIcon
  ) {
    super(id, 'field');
  }
}

class TransitionGroupNode extends DetailsNode {
  public constructor(public readonly transitions: JiraTransition[]) {
    super('transitions', 'transitions');
  }
}

class TransitionNode extends DetailsNode {
  public constructor(public readonly transition: JiraTransition) {
    super(`transition:${transition.id}`, 'transition');
  }
}

type Node = DetailsMessageNode | DetailsFieldNode | TransitionGroupNode | TransitionNode;

function toSnippet(value: string | undefined, maxLength = 140): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

export class DetailsViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
  private loading = false;
  private errorMessage?: string;
  private selectedIssue?: JiraIssueSummary;
  private detailedIssue?: JiraIssueDetails;
  private transitions: JiraTransition[] = [];
  private requestGeneration = 0;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(private readonly backendService: IssueTrackerService) {}

  public getTreeItem(element: Node): vscode.TreeItem {
    if (element instanceof DetailsMessageNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = element.contextValue;
      item.iconPath =
        element.severity === 'error'
          ? new vscode.ThemeIcon('error')
          : element.severity === 'warning'
            ? new vscode.ThemeIcon('warning')
            : new vscode.ThemeIcon('info');
      return item;
    }

    if (element instanceof DetailsFieldNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = element.contextValue;
      item.description = element.value;
      item.tooltip = `${element.label}: ${element.value}`;
      item.iconPath = element.icon;
      return item;
    }

    if (element instanceof TransitionGroupNode) {
      const item = new vscode.TreeItem(
        `Transitions (${element.transitions.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = element.contextValue;
      item.iconPath = new vscode.ThemeIcon('list-tree');
      return item;
    }

    const item = new vscode.TreeItem(
      element.transition.name,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = element.contextValue;
    item.description = element.transition.toStatus;
    item.tooltip = element.transition.toStatus
      ? `${element.transition.name} → ${element.transition.toStatus}`
      : element.transition.name;
    item.iconPath = new vscode.ThemeIcon('debug-step-over');
    return item;
  }

  public async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof TransitionGroupNode) {
      return element.transitions.map(transition => new TransitionNode(transition));
    }

    if (!this.selectedIssue) {
      return [new DetailsMessageNode('empty', 'Select an issue to inspect its details.', 'info')];
    }

    if (this.loading) {
      return [new DetailsMessageNode('loading', `Loading ${this.selectedIssue.key}...`, 'info')];
    }

    if (this.errorMessage) {
      return [new DetailsMessageNode('error', this.errorMessage, 'error')];
    }

    if (!this.detailedIssue) {
      return [new DetailsMessageNode('missing', 'Issue details are unavailable.', 'warning')];
    }

    const nodes: Node[] = [
      new DetailsFieldNode('summary', 'Summary', this.detailedIssue.summary, new vscode.ThemeIcon('note')),
      new DetailsFieldNode(
        'project',
        'Project',
        this.detailedIssue.projectName
          ? `${this.detailedIssue.projectKey} • ${this.detailedIssue.projectName}`
          : this.detailedIssue.projectKey || 'Unknown',
        new vscode.ThemeIcon('repo')
      ),
      new DetailsFieldNode(
        'status',
        'Status',
        this.detailedIssue.status,
        new vscode.ThemeIcon('circle-filled')
      ),
      new DetailsFieldNode(
        'type',
        'Issue Type',
        this.detailedIssue.issueType,
        new vscode.ThemeIcon('symbol-class')
      ),
      new DetailsFieldNode(
        'assignee',
        'Assignee',
        this.detailedIssue.assignee ?? 'Unassigned',
        new vscode.ThemeIcon('account')
      ),
      new DetailsFieldNode(
        'priority',
        'Priority',
        this.detailedIssue.priority ?? 'Unknown',
        new vscode.ThemeIcon('arrow-up')
      )
    ];

    if (this.detailedIssue.updated) {
      nodes.push(
        new DetailsFieldNode(
          'updated',
          'Updated',
          this.detailedIssue.updated,
          new vscode.ThemeIcon('history')
        )
      );
    }

    const descriptionSnippet = toSnippet(this.detailedIssue.description);
    if (descriptionSnippet) {
      nodes.push(
        new DetailsFieldNode(
          'description',
          'Description',
          descriptionSnippet,
          new vscode.ThemeIcon('comment')
        )
      );
    }

    if (this.transitions.length > 0) {
      nodes.push(new TransitionGroupNode(this.transitions));
    } else {
      nodes.push(
        new DetailsFieldNode(
          'transitions-empty',
          'Transitions',
          'No transitions available',
          new vscode.ThemeIcon('debug-stop')
        )
      );
    }

    return nodes;
  }

  public async setIssue(issue: JiraIssueSummary | undefined): Promise<void> {
    this.selectedIssue = issue;
    this.detailedIssue = undefined;
    this.transitions = [];
    this.errorMessage = undefined;

    if (!issue) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.selectedIssue) {
      return;
    }

    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);

    try {
      const [issue, transitions] = await Promise.all([
        this.backendService.getIssue(this.selectedIssue.key),
        this.backendService.getTransitions(this.selectedIssue.key)
      ]);

      if (generation !== this.requestGeneration) {
        return;
      }

      this.detailedIssue = {
        ...issue,
        transitions
      };
      this.transitions = transitions;
      this.loading = false;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.detailedIssue = undefined;
      this.transitions = [];
    } finally {
      if (generation === this.requestGeneration) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    }
  }

  public getActiveIssue(): JiraIssueSummary | undefined {
    return this.detailedIssue ?? this.selectedIssue;
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
