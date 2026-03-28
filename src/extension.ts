import * as vscode from 'vscode';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerCommands } from './commands/registerCommands';
import { AppConfigStore } from './config/jiraConfig';
import { createPlanTemplate } from './file/planTemplate';
import { BoardColumnStore } from './state/boardColumnStore';
import { BoardStore } from './state/boardStore';
import { FilterStore } from './state/filterStore';
import type { BackendMode, Board, IssueSummary } from './types';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardsSidebarViewProvider } from './views/boardsSidebarViewProvider';
import { BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { EpicsSidebarViewProvider } from './views/epicsSidebarViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { IssueDetailsSidebarViewProvider } from './views/issueDetailsSidebarViewProvider';
import { IssuesSidebarViewProvider } from './views/issuesSidebarViewProvider';
import { IssuesTreeProvider } from './views/issuesTreeProvider';

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
  let issuesSidebarViewProvider: IssuesSidebarViewProvider;
  let epicsSidebarViewProvider: EpicsSidebarViewProvider;
  let boardsSidebarViewProvider: BoardsSidebarViewProvider;
  let issueDetailsSidebarViewProvider: IssueDetailsSidebarViewProvider;
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
      issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
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
    issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(detailsProvider.getActiveIssue()?.key ?? '');
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
    })
  );

  async function revealIssueDetailsInSidebar(options: { focus: boolean }): Promise<void> {
    if (!detailsProvider.getActiveIssue()) {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      if (options.focus) {
        await vscode.commands.executeCommand('ticketManager.issueDetails.focus');
      }
    } catch {
      // focusing can fail if the view is not ready
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
    issuesSidebarViewProvider.setSelectedIssueKey(issue?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(issue?.key);

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

  async function selectBoard(board: Board | undefined): Promise<void> {
    if (!board) {
      await boardStore.setLastSelectedBoardId(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      boardPanelManager.clear();
      return;
    }

    await boardStore.setLastSelectedBoardId(board.id);
    boardsSidebarViewProvider.setSelectedBoardId(board.id);
    await boardPanelManager.openBoard(board);
  }

  async function selectIssueByKey(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const issue = issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await selectIssue(issue, options);
  }

  function getEpicIssueType(mode: BackendMode): string {
    return mode === 'jira' ? 'Epic' : 'Feature';
  }

  async function pickProject(defaultProjectKey?: string) {
    const projects = await backendService.getProjects();
    if (projects.length === 0) {
      await vscode.window.showWarningMessage('No projects are available.');
      return undefined;
    }

    if (defaultProjectKey) {
      const defaultProject = projects.find(project => project.key === defaultProjectKey);
      if (defaultProject) {
        return defaultProject;
      }
    }

    if (projects.length === 1) {
      return projects[0];
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(project => ({
        label: project.key,
        description: project.name,
        project
      })),
      {
        title: 'Project'
      }
    );
    return picked?.project;
  }

  async function createEpic(): Promise<void> {
    if (backendService.mode === 'file' && !(await ensureFilePlanConfigured(true))) {
      return;
    }

    const filters = filterStore.getFilters();
    const defaultProjectKey =
      filters.projectKeys.length === 1
        ? filters.projectKeys[0]
        : detailsProvider.getActiveIssue()?.projectKey;
    const project = await pickProject(defaultProjectKey);
    if (!project) {
      return;
    }

    const summary = await vscode.window.showInputBox({
      title: 'Create EPIC',
      prompt: 'Enter a short summary for the new EPIC.',
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
    });
    if (summary === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: 'EPIC Description',
      prompt: 'Optional description for the EPIC.',
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }

    const created = await backendService.createIssue({
      projectKey: project.key,
      issueType: getEpicIssueType(backendService.mode),
      summary: summary.trim(),
      description: description.trim() || undefined
    });

    await refreshAndRestoreSelection();
    await selectIssueByKey(created.key, { openFullPanel: true });
  }

  async function editEpic(issueKey: string): Promise<void> {
    const issue = await backendService.getIssue(issueKey);
    const summary = await vscode.window.showInputBox({
      title: `Edit EPIC (${issue.key})`,
      prompt: 'Update the EPIC summary.',
      value: issue.summary,
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
    });
    if (summary === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: `EPIC Description (${issue.key})`,
      prompt: 'Update the EPIC description.',
      value: issue.description ?? '',
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }

    await backendService.updateIssue(issueKey, {
      summary: summary.trim(),
      description
    });
    await refreshAndRestoreSelection();
    await selectIssueByKey(issueKey, { openFullPanel: true });
  }

  async function deleteIssue(issueKey: string): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${issueKey}?`,
      { modal: true },
      'Delete'
    );
    if (confirmed !== 'Delete') {
      return;
    }

    if (filterStore.getFilters().parentKey === issueKey) {
      await filterStore.updateFilters({ parentKey: undefined });
    }
    if (filterStore.getLastSelectedIssueKey() === issueKey) {
      await filterStore.setLastSelectedIssueKey(undefined);
      await detailsProvider.setIssue(undefined);
      boardPanelManager.setSelectedIssueKey(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      issueDetailPanelManager.clear();
    }

    await backendService.deleteIssue(issueKey);
    await refreshAndRestoreSelection();
  }

  const refreshAndRestoreSelection = async (): Promise<void> => {
    if (!configStore.getBackendMode()) {
      await setModeContext(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
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
      issuesSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
      epicsSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
    } else {
      boardPanelManager.setSelectedIssueKey(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
    }

    boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());

    await boardPanelManager.refresh();
  };

  issuesSidebarViewProvider = new IssuesSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    {
      onSelectIssue: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onSetSearchText: async searchText => {
        await filterStore.updateFilters({ searchText });
      },
      onSetStatuses: async statuses => {
        await filterStore.updateFilters({ statuses });
      },
      onLoadMore: async () => {
        await issuesProvider.loadMore();
      }
    }
  );
  epicsSidebarViewProvider = new EpicsSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    {
      onSelectEpic: async issueKey => {
        await selectIssueByKey(issueKey, { openFullPanel: true });
      },
      onCreateEpic: async () => {
        await createEpic();
      },
      onEditEpic: async issueKey => {
        await editEpic(issueKey);
      },
      onDeleteEpic: async issueKey => {
        await deleteIssue(issueKey);
      }
    }
  );
  boardsSidebarViewProvider = new BoardsSidebarViewProvider(boardStore, boardsProvider, {
    onSelectBoard: async boardId => {
      await selectBoard(boardsProvider.getBoardById(boardId));
    }
  });
  issueDetailsSidebarViewProvider = new IssueDetailsSidebarViewProvider(detailsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.createEpic', async () => {
      try {
        await createEpic();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
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
    vscode.window.registerWebviewViewProvider('ticketManager.myIssues', issuesSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.epics', epicsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.boards', boardsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.issueDetails', issueDetailsSidebarViewProvider),
    issuesSidebarViewProvider,
    epicsSidebarViewProvider,
    boardsSidebarViewProvider,
    issueDetailsSidebarViewProvider,
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
          issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
        } catch (error) {
          logError(outputChannel, error);
        }
      })();
    }),
    boardStore.onDidChange(() => {
      boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
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
          boardsSidebarViewProvider.setSelectedBoardId(undefined);
          boardPanelManager.clear();
          issueDetailPanelManager.clear();
          await backendService.reset();
          await refreshAndRestoreSelection();
        } catch (error) {
          logError(outputChannel, error);
        }
      })();
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
