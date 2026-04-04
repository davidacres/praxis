import * as vscode from 'vscode';
import { AiSessionManager } from './ai/aiSessionManager';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerCommands } from './commands/registerCommands';
import { AppConfigStore } from './config/jiraConfig';
import { createPlanTemplate } from './file/planTemplate';
import { BoardColumnStore } from './state/boardColumnStore';
import { BoardStore } from './state/boardStore';
import { FilterStore } from './state/filterStore';
import type { AiProvider, BackendMode, Board, IssueSummary, UpdateIssueInput } from './types';
import {
  respondToCopilotComment,
  reviewTicketWithClaude,
  reviewTicketWithCopilot,
  reviewTicketWithOpenAi
} from './ai/aiReviewService';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardsSidebarViewProvider } from './views/boardsSidebarViewProvider';
import { BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { EpicsSidebarViewProvider } from './views/epicsSidebarViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { NewProjectWizardPanel } from './views/newProjectWizardPanel';
import { SetupWizardPanel } from './views/setupWizardPanel';
import { IssueDetailsSidebarViewProvider } from './views/issueDetailsSidebarViewProvider';
import { IssuesSidebarViewProvider } from './views/issuesSidebarViewProvider';
import { IssuesTreeProvider } from './views/issuesTreeProvider';
import { SetupSidebarViewProvider } from './views/setupSidebarViewProvider';
import { getParentRule } from './issues/issueHierarchy';

export interface TicketManagerExtensionApi {
  refresh(): Promise<void>;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  boardColumnStore: BoardColumnStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  configStore: AppConfigStore;
  aiSessionManager: AiSessionManager;
  outputChannel: vscode.OutputChannel;
}

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  'openai': 'OpenAI',
  'claude': 'Claude (Anthropic)',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'Copilot'
};

interface AiOptionPick {
  provider: AiProvider;
  label: string;
  description: string;
  agentName?: string;
  credential?: string;
}

function logError(output: vscode.OutputChannel, error: unknown): void {
  output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
}

function extractCopilotRequest(body: string): string | undefined {
  const mentionMatch = body.match(/(?:^|\s)@copilot\b[:,]?\s*/i);
  if (!mentionMatch) {
    return undefined;
  }

  const cleaned = `${body.slice(0, mentionMatch.index)}${body.slice((mentionMatch.index ?? 0) + mentionMatch[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Please help with this ticket.';
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<TicketManagerExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('Ticket Manager');
  const configStore = new AppConfigStore();
  const aiSessionManager = new AiSessionManager(context.workspaceState);
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const boardColumnStore = new BoardColumnStore(context);
  const boardColumnConfigPanel = new BoardColumnConfigPanel(boardColumnStore);
  const newProjectWizardPanel = new NewProjectWizardPanel();
  const setupWizardPanel = new SetupWizardPanel();
  const setupSidebarViewProvider = new SetupSidebarViewProvider();
  const backendService = new BackendRouter(context, configStore, outputChannel);
  const workingDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Set mode context early so when-clauses on views evaluate correctly
  // before VS Code tries to resolve them.
  // !ticketManager.configured is true when the key is false OR doesn't exist,
  // which means the setup view shows by default before activate() even runs.
  const initialMode = configStore.getBackendMode();
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.mode',
    initialMode ?? 'unconfigured'
  );
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.configured',
    !!initialMode
  );

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
    newProjectWizardPanel,
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
    await vscode.commands.executeCommand('setContext', 'ticketManager.configured', !!mode);
  }

  async function refreshSearchActionContexts(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.issuesSearchActive',
        filterStore.getFilters().searchText.trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.epicsSearchActive',
        epicsSidebarViewProvider?.getSearchText().trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.boardsSearchActive',
        boardStore.getFilters().searchText.trim().length > 0
      )
    ]);
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
        },
        {
          label: 'Live Folder',
          description: 'Two-way sync with a markdown plans folder.',
          mode: 'livefolder'
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

    const mode = configStore.getBackendMode();
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

  async function searchIssues(): Promise<void> {
    const filters = filterStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Issues',
      prompt: 'Filter the My Issues list by issue text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await filterStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  async function searchEpics(): Promise<void> {
    const searchText = await vscode.window.showInputBox({
      title: 'Search EPICs',
      prompt: 'Filter the EPICs list by issue text.',
      value: epicsSidebarViewProvider.getSearchText(),
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await epicsSidebarViewProvider.setSearchText(searchText);
    await refreshSearchActionContexts();
  }

  async function searchBoards(): Promise<void> {
    const filters = boardStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Boards',
      prompt: 'Filter the Boards list by board text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await boardStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  function getEpicIssueType(mode: BackendMode): string {
    return mode === 'jira' ? 'Epic' : 'Feature';
  }

  async function reportActionError(error: unknown): Promise<void> {
    logError(outputChannel, error);
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }

  async function resolveBoardById(boardId: string): Promise<Board | undefined> {
    return (
      boardsProvider.getBoardById(boardId) ??
      (await backendService.getBoards(boardStore.getFilters())).find(candidate => candidate.id === boardId)
    );
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

  async function editIssue(issueKey: string): Promise<void> {
    try {
      const issue = await backendService.getIssue(issueKey);
      const label = issue.issueType?.trim() || 'Issue';
      const summary = await vscode.window.showInputBox({
        title: `Edit ${label} (${issue.key})`,
        prompt: 'Update the summary.',
        value: issue.summary,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
      });
      if (summary === undefined) {
        return;
      }

      const description = await vscode.window.showInputBox({
        title: `Description (${issue.key})`,
        prompt: 'Update the description.',
        value: issue.description ?? '',
        ignoreFocusOut: true
      });
      if (description === undefined) {
        return;
      }

      const parentRule = getParentRule(issue.issueType, backendService.mode);
      let parentKey: string | null = null;
      if (parentRule.canHaveParent) {
        const currentParentDescription = issue.parentIssue
          ? `${issue.parentIssue.key} ${issue.parentIssue.summary ?? ''}`.trim()
          : undefined;
        const pickedParentKey = await vscode.window.showInputBox({
          title: `${parentRule.defaultLabel} (${issue.key})`,
          prompt: currentParentDescription
            ? `Current ${issue.parentIssue?.issueType ?? parentRule.defaultLabel}: ${currentParentDescription}`
            : parentRule.helperText,
          value: issue.parentKey ?? '',
          ignoreFocusOut: true,
          validateInput: value =>
            parentRule.requiresParent && value.trim().length === 0
              ? `${parentRule.defaultLabel} is required.`
              : undefined
        });
        if (pickedParentKey === undefined) {
          return;
        }
        parentKey = pickedParentKey.trim() || null;
      }

      await updateIssueAndRefresh(
        issueKey,
        {
          summary: summary.trim(),
          description,
          parentKey
        },
        undefined,
        { openFullPanel: true }
      );
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editEpic(issueKey: string): Promise<void> {
    await editIssue(issueKey);
  }

  async function deleteIssue(issueKey: string): Promise<void> {
    try {
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
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      const name = await vscode.window.showInputBox({
        title: `Edit Board (${board.name})`,
        prompt: 'Update the board name.',
        value: board.name,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length === 0 ? 'Board name is required.' : undefined)
      });
      if (name === undefined) {
        return;
      }

      const updatedBoard = await backendService.updateBoard(boardId, {
        name: name.trim()
      });
      await boardsProvider.refresh();

      if (
        boardStore.getLastSelectedBoardId() === boardId ||
        boardPanelManager.getActiveBoard()?.id === boardId
      ) {
        await boardStore.setLastSelectedBoardId(boardId);
        boardsSidebarViewProvider.setSelectedBoardId(boardId);
        await boardPanelManager.openBoard(updatedBoard);
      }
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function deleteBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete board ${board.name}?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') {
        return;
      }

      await backendService.deleteBoard(boardId);
      if (
        boardStore.getLastSelectedBoardId() === boardId ||
        boardPanelManager.getActiveBoard()?.id === boardId
      ) {
        await boardStore.setLastSelectedBoardId(undefined);
        boardsSidebarViewProvider.setSelectedBoardId(undefined);
        boardPanelManager.clear();
      }

      await boardsProvider.refresh();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function updateIssueAndRefresh(
    issueKey: string,
    input: UpdateIssueInput,
    transitionId?: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const normalizedInput: UpdateIssueInput = {};
    if (typeof input.summary === 'string') {
      normalizedInput.summary = input.summary;
    }
    if (typeof input.description === 'string') {
      normalizedInput.description = input.description;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'parentKey')) {
      normalizedInput.parentKey = input.parentKey?.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      normalizedInput.assignee = input.assignee?.trim() || null;
    }
    if (typeof input.priority === 'string') {
      normalizedInput.priority = input.priority;
    }
    if (typeof input.issueType === 'string') {
      normalizedInput.issueType = input.issueType;
    }

    await backendService.updateIssue(issueKey, normalizedInput);
    if (transitionId) {
      await backendService.transitionIssue(issueKey, transitionId);
    }
    await syncIssueAfterMutation(issueKey, options);
  }

  async function addCommentAndRefresh(issueKey: string, body: string): Promise<void> {
    await backendService.addComment(issueKey, body);
    const copilotRequest = extractCopilotRequest(body);
    if (copilotRequest) {
      const cliPath = configStore.getAiCopilotCliPath().trim();
      if (!cliPath) {
        void vscode.window.showWarningMessage(
          'Comment added, but no Copilot CLI path is configured for @copilot replies.'
        );
      } else {
        try {
          const issue = await backendService.getIssue(issueKey);
          const response = await respondToCopilotComment(
            issue,
            cliPath,
            copilotRequest,
            workingDirectory
          );
          await backendService.addComment(issueKey, response);
        } catch (error) {
          logError(outputChannel, error);
          void vscode.window.showWarningMessage(
            `Comment added, but @copilot could not respond: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    await syncIssueAfterMutation(issueKey);
  }

  function getConfiguredAiOptions(): AiOptionPick[] {
    const registeredAgents = configStore.getConfiguredAiAgents();
    const providers = configStore.getConfiguredAiProviders();
    const configuredProviders = new Set(registeredAgents.map(agent => agent.provider));

    return [
      ...registeredAgents.map(agent => ({
        provider: agent.provider,
        label: agent.name,
        description: AI_PROVIDER_LABELS[agent.provider] ?? agent.provider,
        agentName: agent.name,
        credential: agent.apiKey
      })),
      ...providers
        .filter(provider => !configuredProviders.has(provider))
        .map(provider => ({
          provider,
          label: AI_PROVIDER_LABELS[provider] ?? provider,
          description: provider
        }))
    ];
  }

  async function reviewIssueWithAi(issueKey: string): Promise<void> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error(
        'No AI providers are configured. Add an OpenAI key, Claude key, or Copilot CLI path in Settings.'
      );
    }

    let chosen = options[0];
    if (options.length > 1) {
      const picked = await vscode.window.showQuickPick(
        options.map(option => ({
          label: option.label,
          description: option.description,
          option
        })),
        { title: `Review ${issueKey} with AI` }
      );
      if (!picked) {
        return; // user cancelled
      }
      chosen = picked.option;
    }

    const issue = await backendService.getIssue(issueKey);

    let reviewText: string;
    if (chosen.provider === 'openai') {
      const apiKey = chosen.credential ?? configStore.getAiOpenaiApiKey().trim();
      const agentName = chosen.agentName ?? AI_PROVIDER_LABELS.openai;
      reviewText = await reviewTicketWithOpenAi(issue, apiKey, agentName);
    } else if (chosen.provider === 'claude') {
      const apiKey = chosen.credential ?? configStore.getAiClaudeApiKey().trim();
      const agentName = chosen.agentName ?? AI_PROVIDER_LABELS.claude;
      reviewText = await reviewTicketWithClaude(issue, apiKey, agentName);
    } else if (chosen.provider === 'copilot-cli') {
      reviewText = await reviewTicketWithCopilot(
        issue,
        configStore.getAiCopilotCliPath(),
        chosen.agentName ?? AI_PROVIDER_LABELS['copilot-cli'],
        workingDirectory
      );
    } else {
      throw new Error(`AI review is not supported for provider: ${chosen.provider}`);
    }

    await backendService.addComment(issueKey, reviewText);
    await syncIssueAfterMutation(issueKey);
  }

  async function transitionIssueAndRefresh(issueKey: string, transitionId: string): Promise<void> {
    await backendService.transitionIssue(issueKey, transitionId);
    await syncIssueAfterMutation(issueKey);
  }

  async function syncIssueAfterMutation(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh(), epicsSidebarViewProvider.refresh()]);

    const refreshedIssue =
      issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await filterStore.setLastSelectedIssueKey(issueKey);
    await detailsProvider.setIssue(refreshedIssue);
    boardPanelManager.setSelectedIssueKey(issueKey);
    issuesSidebarViewProvider.setSelectedIssueKey(issueKey);
    epicsSidebarViewProvider.setSelectedIssueKey(issueKey);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(issueKey);

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issueKey);
      await revealIssueDetailsInSidebar({ focus: false });
    }
  }

  boardPanelManager.setCardActions({
    assignToMe: async issueKey => {
      const label = await backendService.getSelfAssigneeLabel();
      if (!label) {
        void vscode.window.showWarningMessage(
          'Could not resolve the current user for assignment. For Jira, use Edit to set an assignee manually.'
        );
        return;
      }
      await updateIssueAndRefresh(issueKey, { assignee: label });
    },
    editIssue,
    deleteIssue
  });

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
    aiSessionManager,
    {
      onSelectIssue: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onEditIssue: async issueKey => {
        await editIssue(issueKey);
      },
      onDeleteIssue: async issueKey => {
        await deleteIssue(issueKey);
      },
      onSetSearchText: async (searchText) => {
        await filterStore.updateFilters({ searchText });
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
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
      onSelectEpic: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
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
  boardsSidebarViewProvider = new BoardsSidebarViewProvider(
    boardStore,
    boardsProvider,
    boardColumnStore,
    () => backendService.mode,
    {
      onSelectBoard: async boardId => {
        await selectBoard(boardsProvider.getBoardById(boardId));
      },
      onEditBoard: async boardId => {
        await editBoard(boardId);
      },
      onDeleteBoard: async boardId => {
        await deleteBoard(boardId);
      }
    }
  );
  issueDetailsSidebarViewProvider = new IssueDetailsSidebarViewProvider(
    backendService,
    detailsProvider,
    aiSessionManager,
    () => configStore.getAiAgentNames(),
    {
      onSaveIssueEdits: async (issueKey, input, transitionId) => {
        await updateIssueAndRefresh(issueKey, input, transitionId);
      },
      onAddComment: async (issueKey, body) => {
        await addCommentAndRefresh(issueKey, body);
      },
      onRequestAiReview: async (issueKey) => {
        await reviewIssueWithAi(issueKey);
      }
    }
  );
  await refreshSearchActionContexts();

  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.createEpic', async () => {
      try {
        await createEpic();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssues', async () => {
      try {
        await searchIssues();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssuesActive', async () => {
      try {
        await searchIssues();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpics', async () => {
      try {
        await searchEpics();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpicsActive', async () => {
      try {
        await searchEpics();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoards', async () => {
      try {
        await searchBoards();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoardsActive', async () => {
      try {
        await searchBoards();
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToAi', async () => {
      try {
        const issue = detailsProvider.getActiveIssue();
        if (!issue) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        const existing = aiSessionManager.getSession(issue.key);
        if (existing) {
          const overwrite = await vscode.window.showWarningMessage(
            `${issue.key} is already assigned to an AI agent (${existing.status}). Replace?`,
            'Replace',
            'Cancel'
          );
          if (overwrite !== 'Replace') {
            return;
          }
        }

        // Prefer registered agents (with names); fall back to raw provider list
        const quickPickItems = getConfiguredAiOptions().map(option => ({
          label: option.label,
          description: option.description,
          provider: option.provider,
          agentName: option.agentName
        }));
        if (quickPickItems.length === 0) {
          await vscode.window.showWarningMessage(
            'No AI providers are configured. Add API keys in Settings → Ticket Manager → AI.'
          );
          return;
        }

        const picked = await vscode.window.showQuickPick(quickPickItems, {
          title: `Assign ${issue.key} to AI Agent`
        });
        if (!picked) {
          return;
        }

        const assignment = aiSessionManager.createSession(issue.key, picked.provider);
        issue.aiAssignment = assignment;

        // If the agent has a registered name, also update the assignee field on the ticket
        if (picked.agentName) {
          await updateIssueAndRefresh(issue.key, { assignee: picked.agentName });
        } else {
          await detailsProvider.setIssue(issue);
          issuesSidebarViewProvider.setSelectedIssueKey(issue.key);
        }

        const displayName = picked.agentName ?? (AI_PROVIDER_LABELS[picked.provider] ?? picked.provider);
        await vscode.window.showInformationMessage(
          `${issue.key} assigned to ${displayName} (session: ${assignment.sessionId.slice(0, 8)})`
        );
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.unassignAi', async () => {
      try {
        const issue = detailsProvider.getActiveIssue();
        if (!issue) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        const session = aiSessionManager.getSession(issue.key);
        if (!session) {
          await vscode.window.showInformationMessage(`${issue.key} has no AI assignment.`);
          return;
        }

        aiSessionManager.removeSession(issue.key);
        issue.aiAssignment = undefined;
        await detailsProvider.setIssue(issue);
        issuesSidebarViewProvider.setSelectedIssueKey(issue.key);
        await vscode.window.showInformationMessage(`AI assignment removed from ${issue.key}.`);
      } catch (error) {
        logError(outputChannel, error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.reviewWithAi', async () => {
      try {
        const issue = detailsProvider.getActiveIssue();
        if (!issue) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${issue.key} with AI…`,
            cancellable: false
          },
          async () => {
            await reviewIssueWithAi(issue.key);
          }
        );
        await vscode.window.showInformationMessage(`AI review posted as a comment on ${issue.key}.`);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
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
      newProjectWizardPanel,
      setupWizardPanel,
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
    vscode.window.registerWebviewViewProvider('ticketManager.setup', setupSidebarViewProvider),
    setupSidebarViewProvider,
    issuesSidebarViewProvider,
    epicsSidebarViewProvider,
    boardsSidebarViewProvider,
    issueDetailsSidebarViewProvider,
    filterStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => logError(outputChannel, error));
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
      void refreshSearchActionContexts().catch(error => logError(outputChannel, error));
      boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
      void boardsProvider.refresh().catch(error => logError(outputChannel, error));
    }),
    ...(context.extensionMode !== vscode.ExtensionMode.Test
      ? [
          vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('ticketManager')) {
              return;
            }

            void (async () => {
              try {
                await setModeContext(configStore.getBackendMode());
                if (configStore.getBackendMode() === 'file') {
                  await ensureFilePlanConfigured(true);
                }
                await filterStore.setLastSelectedIssueKey(undefined);
                await boardStore.setLastSelectedBoardId(undefined);
                await detailsProvider.setIssue(undefined);
                boardsSidebarViewProvider.setSelectedBoardId(undefined);
                await epicsSidebarViewProvider.setSearchText('');
                await refreshSearchActionContexts();
                boardPanelManager.clear();
                issueDetailPanelManager.clear();
                await backendService.reset();
                await refreshAndRestoreSelection();
              } catch (error) {
                logError(outputChannel, error);
              }
            })();
          })
        ]
      : [])
  );

  try {
    await ensureStartupConfiguration();
    if (configStore.getBackendMode()) {
      await refreshAndRestoreSelection();
    }
  } catch (error) {
    logError(outputChannel, error);
  }

  return {
    refresh: refreshAndRestoreSelection,
    backendService,
    filterStore,
    boardStore,
    boardColumnStore,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    issueDetailPanelManager,
    configStore,
    aiSessionManager,
    outputChannel
  };
}

export async function deactivate(): Promise<void> {
  // Disposal is handled through VS Code subscriptions.
}
