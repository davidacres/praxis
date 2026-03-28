import * as vscode from 'vscode';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerCommands } from './commands/registerCommands';
import { JiraConfigStore } from './config/jiraConfig';
import { BoardStore } from './state/boardStore';
import { FilterStore } from './state/filterStore';
import type { JiraIssueSummary } from './types';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { IssueNode, IssuesTreeProvider } from './views/issuesTreeProvider';

export interface JiraMiniExtensionApi {
  refresh(): Promise<void>;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  configStore: JiraConfigStore;
  outputChannel: vscode.OutputChannel;
}

function logError(output: vscode.OutputChannel, error: unknown): void {
  output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<JiraMiniExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('Jira Mini');
  const configStore = new JiraConfigStore();
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const backendService = new BackendRouter(context, configStore, outputChannel);
  const issuesProvider = new IssuesTreeProvider(backendService, filterStore);
  const boardsProvider = new BoardsTreeProvider(backendService, boardStore);
  const detailsProvider = new DetailsViewProvider(backendService);
  const boardPanelManager = new BoardPanelManager(backendService, async issue => {
    await selectIssue(issue);
  });

  const myIssuesView = vscode.window.createTreeView('jiraMini.myIssues', {
    treeDataProvider: issuesProvider,
    showCollapseAll: true
  });
  const boardsView = vscode.window.createTreeView('jiraMini.boards', {
    treeDataProvider: boardsProvider,
    showCollapseAll: true
  });
  const issueDetailsView = vscode.window.createTreeView('jiraMini.issueDetails', {
    treeDataProvider: detailsProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    outputChannel,
    filterStore,
    boardStore,
    backendService,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    myIssuesView,
    boardsView,
    issueDetailsView
  );

  async function selectIssue(issue: JiraIssueSummary | undefined): Promise<void> {
    await filterStore.setLastSelectedIssueKey(issue?.key);
    await detailsProvider.setIssue(issue);
    boardPanelManager.setSelectedIssueKey(issue?.key);
  }

  const refreshAndRestoreSelection = async (): Promise<void> => {
    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
    const lastSelectedKey = filterStore.getLastSelectedIssueKey();
    if (lastSelectedKey) {
      const issue = issuesProvider.getIssueByKey(lastSelectedKey);
      if (issue) {
        await detailsProvider.setIssue(issue);
      }
      boardPanelManager.setSelectedIssueKey(lastSelectedKey);
    } else {
      boardPanelManager.setSelectedIssueKey(undefined);
    }

    await boardPanelManager.refresh();
  };

  context.subscriptions.push(
    ...registerCommands({
      context,
      configStore,
      backendService,
      filterStore,
      boardStore,
      issuesProvider,
      boardsProvider,
      detailsProvider,
      boardPanelManager,
      output: outputChannel
    }),
    filterStore.onDidChange(() => {
      void (async () => {
        try {
          const activeIssue = detailsProvider.getActiveIssue();
          await issuesProvider.refresh();
          if (activeIssue) {
            const refreshedIssue = issuesProvider.getIssueByKey(activeIssue.key) ?? activeIssue;
            await detailsProvider.setIssue(refreshedIssue);
          }
          boardPanelManager.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
        } catch (error) {
          logError(outputChannel, error);
        }
      })();
    }),
    boardStore.onDidChange(() => {
      void boardsProvider.refresh().catch(error => logError(outputChannel, error));
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('jiraMini')) {
        return;
      }

      void (async () => {
        try {
          await filterStore.setLastSelectedIssueKey(undefined);
          await boardStore.setLastSelectedBoardId(undefined);
          await detailsProvider.setIssue(undefined);
          boardPanelManager.clear();
          await backendService.reset();
          await refreshAndRestoreSelection();
        } catch (error) {
          logError(outputChannel, error);
        }
      })();
    }),
    myIssuesView.onDidChangeSelection(event => {
      void (async () => {
        const selectedIssueNode = event.selection.find(
          (item): item is IssueNode => item instanceof IssueNode
        );

        if (selectedIssueNode) {
          await selectIssue(selectedIssueNode.issue);
          return;
        }

        if (event.selection.length === 0) {
          await selectIssue(undefined);
        }
      })().catch(error => logError(outputChannel, error));
    }),
    boardsView.onDidChangeSelection(event => {
      void (async () => {
        const selectedBoardNode = event.selection.find(
          (item): item is BoardNode => item instanceof BoardNode
        );

        if (selectedBoardNode) {
          await boardStore.setLastSelectedBoardId(selectedBoardNode.board.id);
          await boardPanelManager.openBoard(selectedBoardNode.board);
          return;
        }

        if (event.selection.length === 0) {
          await boardStore.setLastSelectedBoardId(undefined);
          boardPanelManager.clear();
        }
      })().catch(error => logError(outputChannel, error));
    })
  );

  try {
    await refreshAndRestoreSelection();
  } catch (error) {
    logError(outputChannel, error);
  }

  return {
    refresh: refreshAndRestoreSelection,
    backendService,
    filterStore,
    boardStore,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    configStore,
    outputChannel
  };
}

export async function deactivate(): Promise<void> {
  // Disposal is handled through VS Code subscriptions.
}
