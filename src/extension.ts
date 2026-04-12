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
import type {
  AiProvider,
  BackendMode,
  Board,
  IssueDetails,
  IssueSummary,
  UpdateIssueInput
} from './types';
import {
  respondToCopilotComment,
  reviewTicketWithClaude,
  reviewTicketWithCopilot,
  reviewTicketWithOpenAi,
  runLocalPeerReview
} from './ai/aiReviewService';
import {
  AI_PROVIDER_LABELS,
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider,
  sortAiOptionsByDefaultProvider
} from './ai/aiProviderSetup';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardsSidebarViewProvider } from './views/boardsSidebarViewProvider';
import { BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { EpicsSidebarViewProvider } from './views/epicsSidebarViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { LocalPeerReviewPanel } from './views/localPeerReviewPanel';
import { NewProjectWizardPanel } from './views/newProjectWizardPanel';
import { SetupWizardPanel } from './views/setupWizardPanel';
import { IssueDetailsSidebarViewProvider } from './views/issueDetailsSidebarViewProvider';
import { IssuesSidebarViewProvider } from './views/issuesSidebarViewProvider';
import { IssuesTreeProvider } from './views/issuesTreeProvider';
import { SetupSidebarViewProvider } from './views/setupSidebarViewProvider';
import { TicketManagerStatusBar } from './views/ticketManagerStatusBar';
import { CopilotAgentService, type CopilotAgentLogger } from './ai/copilotAgentService';
import { CopilotSessionPanelManager } from './views/copilotSessionPanel';
import { ActiveSessionsSidebarViewProvider } from './views/activeSessionsSidebarViewProvider';
import type { AgentTaskDefinition } from './ai/agentTypes';
import { resolveCopilotCliOverride } from './ai/copilotSdkRuntime';
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

interface AiOptionPick {
  provider: AiProvider;
  label: string;
  description: string;
  agentName?: string;
  credential?: string;
}

interface AiAssignmentMenuOption {
  provider: AiProvider;
  label: string;
}

function logError(output: vscode.OutputChannel, error: unknown, scope?: string): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  output.appendLine(scope ? `[${scope}] ${message}` : message);
}

function extractCopilotRequest(body: string, extraMentionName?: string): string | undefined {
  const names = ['copilot'];
  if (extraMentionName) {
    names.push(extraMentionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const pattern = new RegExp(`(?:^|\\s)@(?:${names.join('|')})\\b[:,]?\\s*`, 'i');
  const mentionMatch = body.match(pattern);
  if (!mentionMatch) {
    return undefined;
  }

  const start = mentionMatch.index!;
  const cleaned = `${body.slice(0, start)}${body.slice(start + mentionMatch[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Please help with this ticket.';
}

let deactivateHandler: (() => Promise<void>) | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<TicketManagerExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('Ticket Manager');
  const configStore = new AppConfigStore();
  const aiSessionManager = new AiSessionManager(context.workspaceState);
  const copilotAgentLogger: CopilotAgentLogger = {
    appendLine(message: string): void {
      outputChannel.appendLine(message);
    }
  };
  const copilotAgentService = new CopilotAgentService(aiSessionManager, copilotAgentLogger);
  const copilotSessionPanelManager = new CopilotSessionPanelManager(
    aiSessionManager,
    copilotAgentService,
    async issueKey => {
      await abandonAiSession(issueKey);
    },
    async issueKey => {
      await resumeCopilotSession(issueKey);
    },
    async issueKey => {
      await startNewCopilotSession(issueKey);
    }
  );
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const boardColumnStore = new BoardColumnStore(context);
  const boardColumnConfigPanel = new BoardColumnConfigPanel(boardColumnStore);
  const newProjectWizardPanel = new NewProjectWizardPanel();
  const setupWizardPanel = new SetupWizardPanel();
  const setupSidebarViewProvider = new SetupSidebarViewProvider();
  const backendService = new BackendRouter(context, configStore, outputChannel);
  const ticketManagerStatusBar = new TicketManagerStatusBar(
    configStore,
    backendService,
    aiSessionManager
  );
  const workingDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let suppressCloseWarning = false;
  let lastCloseWarningSignature: string | undefined;
  const permissionPromptSignatures = new Map<string, string>();
  const permissionPromptInFlight = new Set<string>();

  function reportError(error: unknown, scope?: string): void {
    logError(outputChannel, error, scope);
    ticketManagerStatusBar.recordError(error);
  }

  function isCopilotSdkConfigured(): boolean {
    return configStore.getConfiguredAiProviders().includes('copilot-cli');
  }

  function buildCommentPlaceholder(): string {
    const custom = configStore.getAiMentionName().trim();
    if (custom) {
      return `Write a comment (mention @copilot or @${custom} for a reply)`;
    }
    return 'Write a comment (mention @copilot for a reply)';
  }

  function updateCommentPlaceholders(): void {
    const placeholder = buildCommentPlaceholder();
    issueDetailPanelManager.setCommentPlaceholder(placeholder);
    issueDetailsSidebarViewProvider?.setCommentPlaceholder(placeholder);
  }

  async function revealActiveSessionsView(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      await vscode.commands.executeCommand('ticketManager.activeSessions.focus');
    } catch {
      // View focus can fail while the workbench is closing or not ready yet.
    }
  }

  function getLatestPermissionRequestSummary(issueKey: string): string | undefined {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      return undefined;
    }

    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      if (event.type === 'permission_requested') {
        return event.summary;
      }
    }
    return undefined;
  }

  function buildPermissionPromptSnapshot(issueKey: string): {
    signature?: string;
    detail?: string;
  } {
    const descriptions = copilotAgentService
      .getPendingPermissionDescriptions(issueKey)
      .filter(description => description.trim().length > 0);
    if (descriptions.length > 0) {
      const additionalCount = descriptions.length - 1;
      return {
        signature: descriptions.join('\n'),
        detail:
          additionalCount > 0
            ? `${descriptions[0]}\n\n${additionalCount} more queued request${additionalCount === 1 ? '' : 's'} pending.`
            : descriptions[0]
      };
    }

    const fallback = getLatestPermissionRequestSummary(issueKey);
    return fallback
      ? {
          signature: `fallback:${fallback}`,
          detail: fallback
        }
      : {};
  }

  async function openAiSession(issueKey: string): Promise<void> {
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    copilotSessionPanelManager.open(issueKey);
  }

  function clearPermissionPromptTracking(issueKey: string): void {
    permissionPromptSignatures.delete(issueKey);
    permissionPromptInFlight.delete(issueKey);
  }

  async function promptForPendingPermission(issueKey: string): Promise<void> {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record || record.state !== 'awaiting_approval' || !copilotAgentService.hasActiveTask(issueKey)) {
      clearPermissionPromptTracking(issueKey);
      return;
    }

    const snapshot = buildPermissionPromptSnapshot(issueKey);
    if (
      !snapshot.signature ||
      permissionPromptInFlight.has(issueKey) ||
      permissionPromptSignatures.get(issueKey) === snapshot.signature
    ) {
      return;
    }

    permissionPromptSignatures.set(issueKey, snapshot.signature);
    permissionPromptInFlight.add(issueKey);

    try {
      const selection = await vscode.window.showWarningMessage(
        `${issueKey} is waiting for permission.`,
        {
          modal: true,
          detail: snapshot.detail
            ? `${snapshot.detail}\n\nChoose how Ticket Manager should respond.`
            : 'The agent is requesting permission to proceed.'
        },
        'Approve Once',
        'Approve for Task',
        'Deny',
        'Open Session'
      );

      if (selection === 'Approve Once') {
        copilotAgentService.respondToPermission(issueKey, 'allow_once');
      } else if (selection === 'Approve for Task') {
        copilotAgentService.respondToPermission(issueKey, 'allow_always');
      } else if (selection === 'Deny') {
        copilotAgentService.respondToPermission(issueKey, 'deny');
      } else if (selection === 'Open Session') {
        await openAiSession(issueKey);
      }
    } finally {
      permissionPromptInFlight.delete(issueKey);
      const latestRecord = aiSessionManager.getAgentSession(issueKey);
      if (latestRecord?.state === 'awaiting_approval' && copilotAgentService.hasActiveTask(issueKey)) {
        void promptForPendingPermission(issueKey);
      }
    }
  }

  function getCopilotCliPathOverride(options?: { showWarning?: boolean }): string | undefined {
    const { cliPath, warning } = resolveCopilotCliOverride(configStore.getAiCopilotCliPath());
    if (warning) {
      outputChannel.appendLine(`[Copilot SDK] ${warning}`);
      if (options?.showWarning) {
        void vscode.window.showWarningMessage(warning);
      }
    }
    return cliPath;
  }

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

  const issuesProvider = new IssuesTreeProvider(backendService, filterStore, aiSessionManager);
  const boardsProvider = new BoardsTreeProvider(backendService, boardStore);
  const detailsProvider = new DetailsViewProvider(backendService);
  let issuesSidebarViewProvider: IssuesSidebarViewProvider;
  let epicsSidebarViewProvider: EpicsSidebarViewProvider;
  let boardsSidebarViewProvider: BoardsSidebarViewProvider;
  let issueDetailsSidebarViewProvider: IssueDetailsSidebarViewProvider;
  let activeSessionsSidebarViewProvider: ActiveSessionsSidebarViewProvider;
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
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
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
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(detailsProvider.getActiveIssue()?.key ?? '');
  });
  updateCommentPlaceholders();

  const localPeerReviewPanel = new LocalPeerReviewPanel(async (issue) => {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error('No AI providers configured. Run Ticket Manager: Configure AI.');
    }
    let chosen = options[0];
    if (options.length > 1) {
      const picked = await vscode.window.showQuickPick(
        options.map(opt => ({ label: opt.label, description: opt.description, option: opt })),
        { title: `Run Local Peer Review with` }
      );
      if (!picked) {
        throw new Error('Review cancelled.');
      }
      chosen = picked.option;
    }
    return runLocalPeerReview(issue, {
      provider: chosen.provider,
      credential: chosen.credential,
      agentName: chosen.agentName ?? chosen.label,
      cliPath: getCopilotCliPathOverride(),
      workingDirectory
    });
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
    localPeerReviewPanel,
    boardColumnStore,
    boardColumnConfigPanel,
    newProjectWizardPanel,
    aiSessionManager.onDidChangeAgentSession(record => {
      if (record.state === 'awaiting_approval' && copilotAgentService.hasActiveTask(record.issueKey)) {
        void promptForPendingPermission(record.issueKey);
        return;
      }

      clearPermissionPromptTracking(record.issueKey);
    }),
    vscode.window.onDidChangeWindowState(windowState => {
      if (windowState.focused) {
        return;
      }

      const activeIssueKeys = copilotAgentService.getActiveTaskIssueKeys().sort();
      if (activeIssueKeys.length === 0 || suppressCloseWarning) {
        if (activeIssueKeys.length === 0) {
          lastCloseWarningSignature = undefined;
        }
        return;
      }

      const signature = activeIssueKeys.join('|');
      if (signature === lastCloseWarningSignature) {
        return;
      }
      lastCloseWarningSignature = signature;

      const sessionSummary = activeIssueKeys.length === 1
        ? `${activeIssueKeys[0]} has an active AI session`
        : `${activeIssueKeys.length} active AI sessions are running`;
      void vscode.window.showWarningMessage(
        `${sessionSummary}. Closing VS Code will pause them so you can resume later.`,
        'Show Sessions',
        'Do Not Warn Again'
      ).then(selection => {
        if (selection === 'Show Sessions') {
          void revealActiveSessionsView();
        } else if (selection === 'Do Not Warn Again') {
          suppressCloseWarning = true;
        }
      });
    }),
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
    const options: Array<{ label: string; description: string; mode: BackendMode }> = [
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
    ];
    if (!vscode.workspace.workspaceFolders?.length) {
      options.splice(2, 0, {
        label: 'User Workspace',
        description: 'Store boards outside VS Code workspaces and add plan folders as boards.',
        mode: 'userworkspace'
      });
    }

    const picked = await vscode.window.showQuickPick<
      { label: string; description: string; mode: BackendMode }
    >(
      options,
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
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issue?.key);

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
    reportError(error);
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
    const copilotRequest = extractCopilotRequest(body, configStore.getAiMentionName());
    if (copilotRequest) {
      const cliPath = getCopilotCliPathOverride();
      if (!isCopilotSdkConfigured()) {
        void vscode.window.showWarningMessage(
          'Comment added, but GitHub Copilot SDK is not configured for @copilot replies. Run Ticket Manager: Configure AI.'
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
          reportError(error);
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
    const options = [
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

    return sortAiOptionsByDefaultProvider(options, configStore.getAiDefaultProvider());
  }

  function getAiAssignmentMenuOptions(): AiAssignmentMenuOption[] {
    return getConfiguredAiOptions().map(option => ({
      provider: option.provider,
      label: option.label
    }));
  }

  function refreshAiAssignmentMenus(): void {
    const options = getAiAssignmentMenuOptions();
    boardPanelManager.setAiAssignOptions(options);
    issuesSidebarViewProvider?.setAiAssignOptions(options);
  }

  function isTerminalAgentState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  async function findTransitionIdForStatus(
    issueKey: string,
    targetStatus: string
  ): Promise<string | undefined> {
    const issue = await backendService.getIssue(issueKey);
    if (
      issue.status.trim().toLowerCase() === targetStatus.trim().toLowerCase() ||
      issue.statusCategory?.toLowerCase() === 'done'
    ) {
      return undefined;
    }
    const transitions = issue.transitions?.length
      ? issue.transitions
      : await backendService.getTransitions(issueKey);
    return transitions.find(
      transition => transition.toStatus?.trim().toLowerCase() === targetStatus.trim().toLowerCase()
    )?.id;
  }

  async function promptForAiAssignmentOption(issueKey: string): Promise<AiOptionPick | undefined> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      await vscode.window.showWarningMessage(
        'No AI providers are configured. Add API keys, a Cursor CLI path, or enable GitHub Copilot SDK in Settings → Ticket Manager → AI.'
      );
      return undefined;
    }

    if (options.length === 1) {
      return options[0];
    }

    const picked = await vscode.window.showQuickPick(
      options.map(option => ({
        label: option.label,
        description: option.description,
        option
      })),
      {
        title: `Assign ${issueKey} to AI Agent`
      }
    );
    return picked?.option;
  }

  async function refreshIssueAiPresentation(issueKey: string): Promise<void> {
    await issuesSidebarViewProvider.refresh();
    await activeSessionsSidebarViewProvider?.refresh();
    if (detailsProvider.getActiveIssue()?.key === issueKey) {
      const activeIssue = detailsProvider.getActiveIssue();
      if (activeIssue) {
        activeIssue.aiAssignment = aiSessionManager.getSession(issueKey);
        await detailsProvider.setIssue(activeIssue);
      }
    }
    await issueDetailPanelManager.refreshIfShowing(issueKey);
  }

  async function abandonAiSession(
    issueKey: string,
    options?: { showMessage?: boolean; clearAssignee?: boolean }
  ): Promise<void> {
    const showMessage = options?.showMessage ?? true;
    const clearAssignee = options?.clearAssignee ?? true;
    const session = aiSessionManager.getSession(issueKey);
    const agentRecord = aiSessionManager.getAgentSession(issueKey);
    if (!session && !agentRecord) {
      if (showMessage) {
        void vscode.window.showInformationMessage(`${issueKey} has no active AI session.`);
      }
      return;
    }

    if (agentRecord && !isTerminalAgentState(agentRecord.state)) {
      if (copilotAgentService.hasActiveTask(issueKey)) {
        await copilotAgentService.abortTask(issueKey);
      } else {
        aiSessionManager.updateAgentState(issueKey, 'aborted');
      }
    }

    aiSessionManager.removeSession(issueKey);

    if (clearAssignee) {
      try {
        const issue = await backendService.getIssue(issueKey);
        const assignedLabel =
          session?.label?.trim() ||
          (session ? AI_PROVIDER_LABELS[session.provider] : AI_PROVIDER_LABELS['copilot-cli']);
        if (issue.assignee?.trim() === assignedLabel) {
          await updateIssueAndRefresh(issueKey, { assignee: null });
        } else {
          await refreshIssueAiPresentation(issueKey);
        }
      } catch {
        await refreshIssueAiPresentation(issueKey);
      }
    } else {
      await refreshIssueAiPresentation(issueKey);
    }

    if (showMessage) {
      void vscode.window.showInformationMessage(`AI session abandoned for ${issueKey}.`);
    }
  }

  async function assignIssueToAi(issueKey: string, chosen: AiOptionPick): Promise<void> {
    const existing = aiSessionManager.getSession(issueKey);
    const existingAgentRecord = aiSessionManager.getAgentSession(issueKey);
    const existingStatus =
      existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state)
        ? existingAgentRecord.state
        : existing?.status;
    if (existing || (existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state))) {
      const overwrite = await vscode.window.showWarningMessage(
        `${issueKey} is already assigned to an AI agent (${existingStatus ?? 'active'}). Replace?`,
        'Replace',
        'Cancel'
      );
      if (overwrite !== 'Replace') {
        return;
      }
      await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    }

    const assignment = aiSessionManager.createSession(issueKey, chosen.provider, chosen.label);
    const activeIssue = detailsProvider.getActiveIssue();
    if (activeIssue?.key === issueKey) {
      activeIssue.aiAssignment = assignment;
    }

    try {
      const transitionId = await findTransitionIdForStatus(issueKey, 'In Progress');
      await updateIssueAndRefresh(issueKey, { assignee: chosen.label }, transitionId);
      await refreshIssueAiPresentation(issueKey);
    } catch (error) {
      aiSessionManager.removeSession(issueKey);
      if (activeIssue?.key === issueKey) {
        activeIssue.aiAssignment = undefined;
      }
      await refreshIssueAiPresentation(issueKey);
      throw error;
    }

    void vscode.window.showInformationMessage(
      `${issueKey} assigned to ${chosen.label} (session: ${assignment.sessionId.slice(0, 8)})`
    );
  }

  async function assignIssueToAiByProvider(issueKey: string, provider: AiProvider): Promise<void> {
    const chosen = getConfiguredAiOptions().find(option => option.provider === provider);
    if (!chosen) {
      await vscode.window.showWarningMessage(
        `The AI provider ${AI_PROVIDER_LABELS[provider] ?? provider} is no longer configured.`
      );
      return;
    }

    await assignIssueToAi(issueKey, chosen);
  }

  async function assignIssueToMe(issueKey: string): Promise<void> {
    const label = await backendService.getSelfAssigneeLabel();
    if (!label) {
      void vscode.window.showWarningMessage(
        'Could not resolve the current user for assignment. For Jira, use Edit to set an assignee manually.'
      );
      return;
    }
    await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    await updateIssueAndRefresh(issueKey, { assignee: label });
  }

  async function loadPlanContext(issueKey: string): Promise<string | undefined> {
    try {
      const planUri = await configStore.getResolvedPlanFileUri();
      if (!planUri) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(planUri);
      const text = Buffer.from(bytes).toString('utf8');
      // Quick extraction: find the issue key in the plan text and grab surrounding context
      const lines = text.split('\n');
      const matchIndex = lines.findIndex(line => line.includes(`"${issueKey}"`));
      if (matchIndex < 0) {
        return undefined;
      }
      // Grab a window of lines around the match (the plan item block)
      const start = Math.max(0, matchIndex - 2);
      const end = Math.min(lines.length, matchIndex + 20);
      return lines.slice(start, end).join('\n').trim();
    } catch {
      return undefined;
    }
  }

  async function promptForCopilotTaskDefinition(
    issue: IssueDetails,
    previous?: AgentTaskDefinition
  ): Promise<AgentTaskDefinition | undefined> {
    const planContext = await loadPlanContext(issue.key);
    const defaultGoal = previous?.goal ??
      `${issue.summary}${issue.description ? '\\n' + issue.description.slice(0, 200) : ''}` +
      (planContext ? `\\n\\nPlan context:\\n${planContext.slice(0, 300)}` : '');

    const goal = await vscode.window.showInputBox({
      title: 'Goal',
      prompt: planContext
        ? 'What should the agent accomplish? (plan context included)'
        : 'What should the agent accomplish?',
      value: defaultGoal,
      ignoreFocusOut: true
    });
    if (!goal) {
      return undefined;
    }

    const scope = await vscode.window.showInputBox({
      title: 'Scope',
      prompt: 'What files/areas should the agent focus on?',
      value: previous?.scope ?? 'This issue and related files',
      ignoreFocusOut: true
    });
    if (scope === undefined) {
      return undefined;
    }

    const definitionOfDone = await vscode.window.showInputBox({
      title: 'Definition of Done',
      prompt: 'When is this task considered complete?',
      value:
        previous?.definitionOfDone ??
        'All acceptance criteria met, code compiles, tests pass',
      ignoreFocusOut: true
    });
    if (definitionOfDone === undefined) {
      return undefined;
    }

    return {
      goal,
      scope: scope || 'This issue and related files',
      definitionOfDone: definitionOfDone || 'Task complete',
      maxSteps: previous?.maxSteps,
      timeoutMs: previous?.timeoutMs,
      nonGoals: previous?.nonGoals
    };
  }

  async function startNewCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'GitHub Copilot SDK is not configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    try {
      const existingRecord = aiSessionManager.getAgentSession(issueKey);
      if (copilotAgentService.hasActiveTask(issueKey)) {
        const replace = await vscode.window.showWarningMessage(
          `${issueKey} already has a live Copilot session. Start a new one instead?`,
          'Start New',
          'Cancel'
        );
        if (replace !== 'Start New') {
          return;
        }
        await copilotAgentService.abortTask(issueKey);
      }

      const issue = await backendService.getIssue(issueKey);
      const taskDefinition = await promptForCopilotTaskDefinition(issue, existingRecord?.taskDefinition);
      if (!taskDefinition) {
        return;
      }

      await copilotAgentService.startTask(issue, taskDefinition, {
        cliPath: getCopilotCliPathOverride({ showWarning: true }),
        workingDirectory
      });
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `Copilot session started for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'startNewCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to start a new Copilot session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function resumeCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'GitHub Copilot SDK is not configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      void vscode.window.showWarningMessage(`No resumable Copilot session was found for ${issueKey}.`);
      return;
    }

    if (copilotAgentService.hasActiveTask(issueKey)) {
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      copilotSessionPanelManager.open(issueKey);
      return;
    }

    try {
      await copilotAgentService.resumeTask(issueKey, {
        cliPath: getCopilotCliPathOverride({ showWarning: true }),
        workingDirectory
      });
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `Copilot session resumed for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'resumeCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to resume Copilot session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function reviewIssueWithAi(issueKey: string): Promise<void> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error(
        'No AI providers are configured. Add an OpenAI key, Claude key, Cursor CLI path, or enable GitHub Copilot SDK in Settings.'
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
        getCopilotCliPathOverride(),
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
    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      epicsSidebarViewProvider.refresh(),
      activeSessionsSidebarViewProvider?.refresh() ?? Promise.resolve()
    ]);

    const refreshedIssue =
      issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await filterStore.setLastSelectedIssueKey(issueKey);
    await detailsProvider.setIssue(refreshedIssue);
    boardPanelManager.setSelectedIssueKey(issueKey);
    issuesSidebarViewProvider.setSelectedIssueKey(issueKey);
    epicsSidebarViewProvider.setSelectedIssueKey(issueKey);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(issueKey);

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issueKey);
      await revealIssueDetailsInSidebar({ focus: false });
    }
  }

  boardPanelManager.setCardActions({
    assignToMe: async issueKey => {
      await assignIssueToMe(issueKey);
    },
    assignToAi: async (issueKey, provider) => {
      await assignIssueToAiByProvider(issueKey, provider);
    },
    editIssue,
    deleteIssue
  });

  const refreshAndRestoreSelection = async (): Promise<void> => {
    if (!configStore.getBackendMode()) {
      await setModeContext(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      return;
    }

    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      activeSessionsSidebarViewProvider?.refresh() ?? Promise.resolve()
    ]);
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
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(lastSelectedKey);
    } else {
      boardPanelManager.setSelectedIssueKey(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
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
      onAssignToMe: async issueKey => {
        await assignIssueToMe(issueKey);
      },
      onAssignToAi: async (issueKey, provider) => {
        await assignIssueToAiByProvider(issueKey, provider);
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
  refreshAiAssignmentMenus();
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
      },
      onSetSearchText: async (_searchText) => {
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
        await filterStore.setEpicStatuses(statuses);
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
  updateCommentPlaceholders();
  activeSessionsSidebarViewProvider = new ActiveSessionsSidebarViewProvider(
    backendService,
    aiSessionManager,
    issueKey => copilotAgentService.hasActiveTask(issueKey),
    {
      onOpenSession: async issueKey => {
        activeSessionsSidebarViewProvider.setSelectedIssueKey(issueKey);
        copilotSessionPanelManager.open(issueKey);
      },
      onResumeSession: async issueKey => {
        await resumeCopilotSession(issueKey);
      },
      onStartNewSession: async issueKey => {
        await startNewCopilotSession(issueKey);
      },
      onAbandonSession: async issueKey => {
        await abandonAiSession(issueKey);
      }
    }
  );

  function resolveIssueKeyFromArgOrActive(arg?: unknown): string | undefined {
    if (typeof arg === 'string' && arg.trim().length > 0) {
      return arg.trim();
    }
    if (
      arg &&
      typeof arg === 'object' &&
      'issueKey' in arg &&
      typeof (arg as { issueKey?: unknown }).issueKey === 'string'
    ) {
      return (arg as { issueKey: string }).issueKey;
    }
    return detailsProvider.getActiveIssue()?.key;
  }

  await refreshSearchActionContexts();

  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.createEpic', async () => {
      try {
        await createEpic();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssues', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssuesActive', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpics', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpicsActive', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoards', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoardsActive', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToMe', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await assignIssueToMe(issueKey);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToAi', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        const picked = await promptForAiAssignmentOption(issueKey);
        if (!picked) {
          return;
        }

        await assignIssueToAi(issueKey, picked);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.unassignAi', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await abandonAiSession(issueKey, { showMessage: true, clearAssignee: true });
      } catch (error) {
        reportError(error);
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
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.localPeerReview', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        const issue = await backendService.getIssue(issueKey);
        await localPeerReviewPanel.open(issue);
      } catch (error) {
        await vscode.window.showErrorMessage(
          `LPR failed: ${error instanceof Error ? error.message : String(error)}`
        );
        reportError(error, 'localPeerReview');
      }
    }),
    vscode.commands.registerCommand('ticketManager.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:local-dev.ticket-manager ticketManager'
      );
    }),
    vscode.commands.registerCommand('ticketManager.configureAi', async () => {
      try {
        const result = await promptToConfigureDefaultAiProvider();
        refreshAiAssignmentMenus();
        await ticketManagerStatusBar.refresh();
        if (result.status !== 'cancelled') {
          await vscode.window.showInformationMessage(describeAiConfigurationResult(result));
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        reportError(error);
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
      setupSidebarViewProvider,
      issuesProvider,
      boardsProvider,
      detailsProvider,
      boardPanelManager,
      issueDetailPanelManager,
      revealIssueDetailsTree: () => revealIssueDetailsInSidebar({ focus: false }),
      ensureFilePlanConfigured,
      output: outputChannel,
      onConnectionCheck: result => {
        ticketManagerStatusBar.recordConnectionResult(result);
      },
      reportError,
      copilotAgentService,
      copilotSessionPanelManager,
      aiSessionManager
    }),
    vscode.window.registerWebviewViewProvider('ticketManager.myIssues', issuesSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.epics', epicsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.boards', boardsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.activeSessions', activeSessionsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.issueDetails', issueDetailsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.setup', setupSidebarViewProvider),
    setupSidebarViewProvider,
    issuesSidebarViewProvider,
    epicsSidebarViewProvider,
    boardsSidebarViewProvider,
    activeSessionsSidebarViewProvider,
    issueDetailsSidebarViewProvider,
    ticketManagerStatusBar,
    copilotAgentService,
    copilotSessionPanelManager,
    aiSessionManager,
    filterStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
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
          activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
        } catch (error) {
          reportError(error);
        }
      })();
    }),
    boardStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
      boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
      void boardsProvider.refresh().catch(error => reportError(error));
    }),
    ...(context.extensionMode !== vscode.ExtensionMode.Test
      ? [
          vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('ticketManager')) {
              return;
            }

            if (
              event.affectsConfiguration('ticketManager.ai') &&
              !event.affectsConfiguration('ticketManager.backendMode') &&
              !event.affectsConfiguration('ticketManager.connectionType') &&
              !event.affectsConfiguration('ticketManager.httpUrl') &&
              !event.affectsConfiguration('ticketManager.stdioCommand') &&
              !event.affectsConfiguration('ticketManager.stdioArgs') &&
              !event.affectsConfiguration('ticketManager.stdioCwd') &&
              !event.affectsConfiguration('ticketManager.planFilePath') &&
              !event.affectsConfiguration('ticketManager.liveFolderPath') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectKey') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectName') &&
              !event.affectsConfiguration('ticketManager.workspaceMcpServerName') &&
              !event.affectsConfiguration('ticketManager.userMcpServerRef')
            ) {
              refreshAiAssignmentMenus();
              void ticketManagerStatusBar.refresh().catch(error => reportError(error));
              return;
            }

            void (async () => {
              try {
                refreshAiAssignmentMenus();
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
                await ticketManagerStatusBar.refresh();
              } catch (error) {
                reportError(error);
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
    await ticketManagerStatusBar.refresh();
  } catch (error) {
    reportError(error);
  }

  deactivateHandler = async () => {
    await copilotAgentService.pauseAllTasks(
      'Session paused because VS Code is closing. Reopen VS Code and resume to continue.'
    );
  };

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
  const handler = deactivateHandler;
  deactivateHandler = undefined;
  await handler?.();
}
