import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, IssueSummary, WorkflowTransition } from '../types';

export interface DetailsProviderSnapshot {
  loading: boolean;
  errorMessage?: string;
  selectedIssue?: IssueSummary;
  detailedIssue?: IssueDetails;
  transitions: WorkflowTransition[];
}

abstract class DetailsNode {
  public constructor(
    public readonly id: string,
    public readonly contextValue: string
  ) {}
}

export class IssueRootNode extends DetailsNode {
  public constructor(
    public readonly issueKey: string,
    public readonly summary: string
  ) {
    super(`issue-root:${issueKey}`, 'issueRoot');
  }
}

class IssueKeyNode extends DetailsNode {
  public constructor(public readonly issueKey: string) {
    super(`issue-key:${issueKey}`, 'issueKey');
  }
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

class DescriptionBlockNode extends DetailsNode {
  public constructor(public readonly preview: string) {
    super('description-block', 'descriptionBlock');
  }
}

class TransitionGroupNode extends DetailsNode {
  public constructor(public readonly transitions: WorkflowTransition[]) {
    super('transitions', 'transitions');
  }
}

class TransitionNode extends DetailsNode {
  public constructor(public readonly transition: WorkflowTransition) {
    super(`transition:${transition.id}`, 'transition');
  }
}

type Node =
  | IssueRootNode
  | IssueKeyNode
  | DetailsMessageNode
  | DetailsFieldNode
  | DescriptionBlockNode
  | TransitionGroupNode
  | TransitionNode;

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
  private selectedIssue?: IssueSummary;
  private detailedIssue?: IssueDetails;
  private transitions: WorkflowTransition[] = [];
  private requestGeneration = 0;
  private revealTarget?: IssueRootNode;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(private readonly backendService: IssueTrackerService) {}

  public getTreeItem(element: Node): vscode.TreeItem {
    if (element instanceof DetailsMessageNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
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

    if (element instanceof IssueRootNode) {
      const item = new vscode.TreeItem(
        element.summary,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `issue-root:${element.issueKey}`;
      item.description = element.issueKey;
      item.tooltip = `${element.issueKey}\n${element.summary}`;
      item.contextValue = element.contextValue;
      item.iconPath = new vscode.ThemeIcon('list-tree');
      return item;
    }

    if (element instanceof IssueKeyNode) {
      const item = new vscode.TreeItem(element.issueKey, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.description = 'Open full details';
      item.tooltip = `${element.issueKey}: open full issue details in an editor tab`;
      item.iconPath = new vscode.ThemeIcon('link');
      item.command = {
        command: 'ticketManager.openIssueFullDetails',
        title: 'Open full issue details',
        arguments: [element.issueKey]
      };
      return item;
    }

    if (element instanceof DetailsFieldNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.description = element.value;
      item.tooltip = `${element.label}: ${element.value}`;
      item.iconPath = element.icon;
      return item;
    }

    if (element instanceof DescriptionBlockNode) {
      const item = new vscode.TreeItem(
        'Description',
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.description = element.preview;
      item.tooltip = 'Preview — expand for full text, or use the issue key link for the full tab';
      item.iconPath = new vscode.ThemeIcon('comment');
      return item;
    }

    if (element instanceof TransitionGroupNode) {
      const item = new vscode.TreeItem(
        `Transitions (${element.transitions.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.iconPath = new vscode.ThemeIcon('list-tree');
      return item;
    }

    const item = new vscode.TreeItem(
      element.transition.name,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = element.id;
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

    if (element instanceof DescriptionBlockNode) {
      const full = this.detailedIssue?.description?.trim() ?? '';
      return [
        new DetailsFieldNode(
          'description-full',
          'Full text',
          full.length > 0 ? full : '(empty)',
          new vscode.ThemeIcon('symbol-string')
        )
      ];
    }

    if (element instanceof IssueRootNode) {
      return this.buildIssueChildren();
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

    if (!this.revealTarget) {
      this.revealTarget = new IssueRootNode(
        this.detailedIssue.key,
        this.detailedIssue.summary
      );
    }

    return [this.revealTarget];
  }

  private buildIssueChildren(): Node[] {
    if (!this.detailedIssue) {
      return [];
    }

    const nodes: Node[] = [
      new IssueKeyNode(this.detailedIssue.key),
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
      nodes.push(new DescriptionBlockNode(descriptionSnippet));
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

  public getRevealTarget(): IssueRootNode | undefined {
    return this.revealTarget;
  }

  public async setIssue(issue: IssueSummary | undefined): Promise<void> {
    this.selectedIssue = issue;
    this.detailedIssue = undefined;
    this.transitions = [];
    this.errorMessage = undefined;
    this.revealTarget = undefined;

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
    this.revealTarget = undefined;
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
      this.revealTarget = new IssueRootNode(this.selectedIssue.key, this.detailedIssue.summary);
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.detailedIssue = undefined;
      this.transitions = [];
      this.revealTarget = undefined;
    } finally {
      if (generation === this.requestGeneration) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    }
  }

  public getActiveIssue(): IssueSummary | undefined {
    return this.detailedIssue ?? this.selectedIssue;
  }

  public getSnapshot(): DetailsProviderSnapshot {
    return {
      loading: this.loading,
      errorMessage: this.errorMessage,
      selectedIssue: this.selectedIssue,
      detailedIssue: this.detailedIssue,
      transitions: [...this.transitions]
    };
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
