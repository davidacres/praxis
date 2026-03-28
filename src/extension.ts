import * as vscode from 'vscode';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerCommands } from './commands/registerCommands';
import { AppConfigStore } from './config/jiraConfig';
import { createPlanTemplate } from './file/planTemplate';
import { BoardColumnStore } from './state/boardColumnStore';
import { BoardStore } from './state/boardStore';
import { FilterStore } from './state/filterStore';
import type { BackendMode, IssueSummary } from './types';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { IssueNode, IssuesTreeProvider } from './views/issuesTreeProvider';

export interface TicketManagerExtensionApi {
  refresh(): Promise<void>;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  configStore: AppConfigStore;
  outputChannel: vscode.OutputChannel;
}

function logError(output: vscode.OutputChannel, error: unknown): void {
  output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<TicketManagerExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('Ticket Manager');
  const configStore = new AppConfigStore();
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const boardColumnStore = new BoardColumnStore(context);
  const boardColumnConfigPanel = new BoardColumnConfigPanel(boardColumnStore);
  const backendService = new BackendRouter(context, configStore, outputChannel);
  const issuesProvider = new IssuesTreeProvider(backendService, filterStore);
  const boardsProvider = new BoardsTreeProvider(backendService, boardStore);
  const detailsProvider = new DetailsViewProvider(backendService);
  let issueDetailPanelManager: IssueDetailPanelManager;
  const boardPanelManager = new BoardPanelManager(
    backendService,
    async issue => {
      await selectIssue(issue);
    },
    async () => {
      await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
      const active = detailsProvider.getActiveIssue();
      if (active) {
        const refreshedIssue = issuesProvider.getIssueByKey(active.key) ?? active;
        await detailsProvider.setIssue(refreshedIssue);
      } else {
        await detailsProvider.refresh();
      }
      await issueDetailPanelManager.refreshIfShowing(
        detailsProvider.getActiveIssue()?.key ?? ''
      );
    },
    boardColumnStore
  );
  issueDetailPanelManager = new IssueDetailPanelManager(backendService, async () => {
    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
    const active = detailsProvider.getActiveIssue();
    if (active) {
      const refreshedIssue = issuesProvider.getIssueByKey(active.key) ?? active;
      await detailsProvider.setIssue(refreshedIssue);
    } else {
      await detailsProvider.refresh();
    }
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(detailsProvider.getActiveIssue()?.key ?? '');
  });

  const myIssuesView = vscode.window.createTreeView('ticketManager.myIssues', {
    treeDataProvider: issuesProvider,
    showCollapseAll: true
  });
  const boardsView = vscode.window.createTreeView('ticketManager.boards', {
    treeDataProvider: boardsProvider,
    showCollapseAll: true
  });
  const issueDetailsView = vscode.window.createTreeView('ticketManager.issueDetails', {
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
    issueDetailPanelManager,
    boardColumnStore,
    boardColumnConfigPanel,
    boardColumnStore.onDidChange(() => {
      boardPanelManager.refreshColumnLayout();
    }),
    myIssuesView,
    boardsView,
    issueDetailsView
  );

  async function revealIssueDetailsInSidebar(options: { focus: boolean }): Promise<void> {
    const target = detailsProvider.getRevealTarget();
    if (!target) {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      await issueDetailsView.reveal(target, { expand: 2, focus: options.focus });
    } catch {
      // reveal can fail if the view is not ready
    }
  }

  async function setModeContext(mode: BackendMode | undefined): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'ticketManager.mode', mode ?? 'unconfigured');
  }

  async function ensureFilePlanConfigured(interactive: boolean): Promise<boolean> {
    const configuredUri = await configStore.getResolvedPlanFileUri();
    if (configuredUri) {
      try {
        await vscode.workspace.fs.stat(configuredUri);
        return true;
      } catch {
        // fall through to discovery/prompt
      }
    }

    const planCandidates = await configStore.findWorkspacePlanCandidates();
    if (planCandidates.length === 1) {
      await configStore.setPlanFilePath(planCandidates[0].fsPath);
      return true;
    }

    if (planCandidates.length > 1 && interactive) {
      const picked = await vscode.window.showQuickPick(
        planCandidates.map(candidate => ({
          label: candidate.fsPath,
          description: candidate.path,
          uri: candidate
        })),
        {
          title: 'Choose Plan File'
        }
      );
      if (picked) {
        await configStore.setPlanFilePath(picked.uri.fsPath);
        return true;
      }
    }

    if (!interactive) {
      return false;
    }

    const action = await vscode.window.showInformationMessage(
      configuredUri
        ? 'The configured plan file could not be found. Choose another file or create a new one.'
        : 'File mode needs a plan file. Choose an existing file or create a new one.',
      'Choose Existing',
      'Create New'
    );

    if (action === 'Choose Existing') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use Plan File',
        filters: {
          'Plan Files': ['jsonc', 'json']
        },
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      if (picked?.[0]) {
        await configStore.setPlanFilePath(picked[0].fsPath);
        return true;
      }
      return false;
    }

    if (action === 'Create New') {
      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Create Plan File',
        filters: {
          'Plan Files': ['jsonc']
        },
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'ticket-plan.jsonc')
          : undefined
      });
      if (saveUri) {
        await vscode.workspace.fs.writeFile(
          saveUri,
          Buffer.from(createPlanTemplate(vscode.workspace.workspaceFolders?.[0]?.name), 'utf8')
        );
        await configStore.setPlanFilePath(saveUri.fsPath);
        await vscode.window.showInformationMessage(`Created ${saveUri.fsPath}.`);
        return true;
      }
    }

    return false;
  }

  async function promptForBackendMode(): Promise<BackendMode | undefined> {
    const picked = await vscode.window.showQuickPick<
      { label: string; description: string; mode: BackendMode }
    >(
      [
        {
          label: 'Jira Connected',
          description: 'Connect to Jira through the configured MCP server.',
          mode: 'jira'
        },
        {
          label: 'Demo',
          description: 'Use built-in demo data.',
          mode: 'demo'
        },
        {
          label: 'File',
          description: 'Use a plan file from the current workspace.',
          mode: 'file'
        }
      ],
      {
        title: 'Choose Backend Mode',
        ignoreFocusOut: true
      }
    );

    return picked?.mode;
  }

  async function ensureStartupConfiguration(): Promise<void> {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      await setModeContext(configStore.getBackendMode());
      return;
    }

    let mode = configStore.getBackendMode();
    if (!mode) {
      mode = await promptForBackendMode();
      if (mode) {
        await configStore.setBackendMode(mode);
      }
    }

    await setModeContext(mode);

    if (mode === 'file') {
      await ensureFilePlanConfigured(true);
    }
  }

  async function selectIssue(
    issue: IssueSummary | undefined,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await filterStore.setLastSelectedIssueKey(issue?.key);
    await detailsProvider.setIssue(issue);
    boardPanelManager.setSelectedIssueKey(issue?.key);

    if (!issue) {
      issueDetailPanelManager.clear();
      return;
    }

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issue.key);
      await revealIssueDetailsInSidebar({ focus: false });
    } else {
      await revealIssueDetailsInSidebar({ focus: true });
    }
  }

  const refreshAndRestoreSelection = async (): Promise<void> => {
    if (!configStore.getBackendMode()) {
      await setModeContext(undefined);
      return;
    }

    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
    const lastSelectedKey = filterStore.getLastSelectedIssueKey();
    if (lastSelectedKey) {
      const issue = issuesProvider.getIssueByKey(lastSelectedKey);
      if (issue) {
        await detailsProvider.setIssue(issue);
        await revealIssueDetailsInSidebar({ focus: false });
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
      boardColumnConfigPanel,
      issuesProvider,
      boardsProvider,
      detailsProvider,
      boardPanelManager,
      issueDetailPanelManager,
      revealIssueDetailsTree: () => revealIssueDetailsInSidebar({ focus: false }),
      ensureFilePlanConfigured,
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
      if (!event.affectsConfiguration('ticketManager')) {
        return;
      }

      void (async () => {
        try {
          await setModeContext(configStore.getBackendMode());
          if (
            context.extensionMode !== vscode.ExtensionMode.Test &&
            configStore.getBackendMode() === 'file'
          ) {
            await ensureFilePlanConfigured(true);
          }
          await filterStore.setLastSelectedIssueKey(undefined);
          await boardStore.setLastSelectedBoardId(undefined);
          await detailsProvider.setIssue(undefined);
          boardPanelManager.clear();
          issueDetailPanelManager.clear();
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
          await selectIssue(selectedIssueNode.issue, { openFullPanel: true });
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
    await ensureStartupConfiguration();
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
    issueDetailPanelManager,
    configStore,
    outputChannel
  };
}

export async function deactivate(): Promise<void> {
  // Disposal is handled through VS Code subscriptions.
}
