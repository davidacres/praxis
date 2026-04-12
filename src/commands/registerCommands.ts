import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import { BoardStore } from '../state/boardStore';
import { FilterStore } from '../state/filterStore';
import type {
  AssigneeMode,
  BackendMode,
  Board,
  CreateIssueInput,
  Project,
  IssueSummary,
  WorkflowTransition
} from '../types';
import { BoardColumnConfigPanel } from '../views/boardColumnConfigPanel';
import { BoardPanelManager } from '../views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from '../views/boardsTreeProvider';
import { DetailsViewProvider } from '../views/detailsViewProvider';
import { IssueDetailPanelManager } from '../views/issueDetailPanelManager';
import { IssueNode, IssuesTreeProvider, LoadMoreNode } from '../views/issuesTreeProvider';
import { NewProjectWizardPanel } from '../views/newProjectWizardPanel';
import { SetupSidebarViewProvider } from '../views/setupSidebarViewProvider';
import { SetupWizardPanel } from '../views/setupWizardPanel';
import {
  generateTicketPlanFromMarkdownFeatures,
  resolveSuggestedPlansFolderUri
} from '../import/markdownFeaturePlanImporter';
import { identifyPlanFolder } from '../livefolder/markdownPlanParser';
import { toStoredFolderPath } from '../livefolder/pathUtils';
import {
  getParentRule,
  isAllowedParentType
} from '../issues/issueHierarchy';
import type { CopilotAgentService } from '../ai/copilotAgentService';
import { resolveCopilotCliOverride } from '../ai/copilotSdkRuntime';
import type { CopilotSessionPanelManager } from '../views/copilotSessionPanel';
import type { AiSessionManager } from '../ai/aiSessionManager';

interface CommandDependencies {
  context: vscode.ExtensionContext;
  configStore: AppConfigStore;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  boardColumnConfigPanel: BoardColumnConfigPanel;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  newProjectWizardPanel: NewProjectWizardPanel;
  setupWizardPanel: SetupWizardPanel;
  setupSidebarViewProvider: SetupSidebarViewProvider;
  /** Focus the Issue Details tree and expand the current issue root (no editor steal). */
  revealIssueDetailsTree: () => Promise<void>;
  ensureFilePlanConfigured: (interactive: boolean) => Promise<boolean>;
  output: vscode.OutputChannel;
  reportError?: (error: unknown, scope?: string) => void;
  onConnectionCheck?: (
    result: Awaited<ReturnType<IssueTrackerService['checkConnection']>>
  ) => void;
  copilotAgentService?: CopilotAgentService;
  copilotSessionPanelManager?: CopilotSessionPanelManager;
  aiSessionManager?: AiSessionManager;
}

function resolveIssue(
  detailsProvider: DetailsViewProvider,
  arg: unknown
): IssueSummary | undefined {
  if (arg instanceof IssueNode) {
    return arg.issue;
  }

  return detailsProvider.getActiveIssue();
}

function resolveIssueKey(detailsProvider: DetailsViewProvider, arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg.trim().length > 0) {
    return arg.trim();
  }
  return resolveIssue(detailsProvider, arg)?.key;
}

function resolveBoard(
  boardsProvider: BoardsTreeProvider,
  arg: unknown,
  boardStore: BoardStore
) {
  if (arg instanceof BoardNode) {
    return arg.board;
  }

  const selectedBoardId = boardStore.getLastSelectedBoardId();
  return selectedBoardId ? boardsProvider.getBoardById(selectedBoardId) : undefined;
}

async function runMarkdownFeaturePlanImport(deps: CommandDependencies): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    await vscode.window.showErrorMessage('Open a workspace folder first, then run this command again.');
    return;
  }

  const suggested = await resolveSuggestedPlansFolderUri();
  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Select folder to search for plans',
    defaultUri: suggested ?? folders[0].uri
  });
  if (!chosen?.[0]) {
    return;
  }

  let selectedPlansUri: vscode.Uri;
  try {
    const identified = await identifyPlanFolder(chosen[0]);
    selectedPlansUri = identified.plansRootUri;
    if (selectedPlansUri.toString() !== chosen[0].toString()) {
      deps.output.appendLine(`[import] Resolved selected folder to ${selectedPlansUri.fsPath}`);
    }
  } catch (error) {
    reportCommandError(deps, 'import', error);
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  const projectKey = (
    await vscode.window.showInputBox({
      title: 'Project key',
      prompt: 'Short key for imported issues (e.g. THI).',
      value: 'THI',
      validateInput: value => {
        const v = value.trim();
        return /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(v)
          ? undefined
          : 'Use letters, numbers, or underscore; 1–15 characters, start with a letter.';
      }
    })
  )?.trim();
  if (!projectKey) {
    return;
  }

  const projectName = (
    await vscode.window.showInputBox({
      title: 'Project name',
      prompt: 'Display name for the project in Ticket Manager.',
      value: 'Traka HIS Integration'
    })
  )?.trim();
  if (!projectName) {
    return;
  }

  const currentUser =
    (
      await vscode.window.showInputBox({
        title: 'Default assignee',
        prompt: 'Used as assignee on each imported feature and story.',
        value: 'Alex Agent'
      })
    )?.trim() || 'Alex Agent';

  let result: Awaited<ReturnType<typeof generateTicketPlanFromMarkdownFeatures>>;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Importing markdown feature plan',
        cancellable: false
      },
      async progress => {
        return generateTicketPlanFromMarkdownFeatures(selectedPlansUri, {
          projectKey,
          projectName,
          currentUser,
          onProgress: message => {
            progress.report({ message });
            deps.output.appendLine(`[import] ${message}`);
          }
        });
      }
    );
  } catch (error) {
    reportCommandError(deps, 'import', error);
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  const saveUri = await vscode.window.showSaveDialog({
    saveLabel: 'Save imported plan',
    filters: { 'Plan files': ['jsonc', 'json'] },
    defaultUri: vscode.Uri.joinPath(folders[0].uri, 'ticket-plan.imported.jsonc')
  });
  if (!saveUri) {
    return;
  }

  await vscode.workspace.fs.writeFile(saveUri, new TextEncoder().encode(result.jsonc));
  await deps.configStore.setPlanFilePath(saveUri.fsPath);
  deps.output.appendLine(
    `[import] ${result.stats.featuresImported} features, ${result.stats.storiesImported} stories → ${saveUri.fsPath}`
  );

  const goFile = await vscode.window.showInformationMessage(
    `Imported ${result.stats.featuresImported} features and ${result.stats.storiesImported} stories from markdown into ${saveUri.fsPath}.`,
    'Switch to File mode'
  );

  if (goFile === 'Switch to File mode') {
    await setBackendMode(deps, 'file');
    await vscode.window.showInformationMessage('Backend mode is now File. The imported plan is active.');
  } else {
    await deps.backendService.reset();
    await clearUiSelection(deps);
    await refreshViews(deps);
  }
}

async function refreshViews(deps: CommandDependencies): Promise<void> {
  await Promise.all([deps.issuesProvider.refresh(), deps.boardsProvider.refresh()]);
  const activeIssue = deps.detailsProvider.getActiveIssue();
  if (activeIssue) {
    const refreshedIssue = deps.issuesProvider.getIssueByKey(activeIssue.key) ?? activeIssue;
    await deps.detailsProvider.setIssue(refreshedIssue);
    deps.boardPanelManager.setSelectedIssueKey(refreshedIssue.key);
  } else {
    await deps.detailsProvider.refresh();
    deps.boardPanelManager.setSelectedIssueKey(undefined);
  }

  await deps.boardPanelManager.refresh();
  await deps.issueDetailPanelManager.refreshIfShowing(
    deps.detailsProvider.getActiveIssue()?.key ?? ''
  );
}

async function clearUiSelection(deps: CommandDependencies): Promise<void> {
  await deps.filterStore.setLastSelectedIssueKey(undefined);
  await deps.boardStore.setLastSelectedBoardId(undefined);
  await deps.detailsProvider.setIssue(undefined);
  deps.boardPanelManager.clear();
  deps.issueDetailPanelManager.clear();
}

async function setBackendMode(
  deps: CommandDependencies,
  mode: BackendMode
): Promise<void> {
  await deps.configStore.setBackendMode(mode);
  if (mode === 'file') {
    await deps.ensureFilePlanConfigured(true);
  }
  await deps.backendService.reset();
  await clearUiSelection(deps);
  await refreshViews(deps);
}

async function openIssueInBrowser(
  deps: CommandDependencies,
  arg?: unknown
): Promise<void> {
  const issue = resolveIssue(deps.detailsProvider, arg);
  if (!issue) {
    void vscode.window.showInformationMessage('Select an issue first.');
    return;
  }

  const url = await deps.backendService.getBrowseUrl(issue);
  if (!url) {
    void vscode.window.showWarningMessage(`No browser URL is available for ${issue.key}.`);
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function showConnectionResult(
  result: Awaited<ReturnType<IssueTrackerService['checkConnection']>>
): Promise<void> {
  if (result.status === 'ok') {
    await vscode.window.showInformationMessage(result.message);
    return;
  }

  if (result.status === 'warning') {
    await vscode.window.showWarningMessage(result.message);
    return;
  }

  await vscode.window.showErrorMessage(result.message);
}

function reportCommandError(
  deps: CommandDependencies,
  scope: string,
  error: unknown
): void {
  if (deps.reportError) {
    deps.reportError(error, scope);
    return;
  }

  deps.output.appendLine(`[${scope}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}

function getCopilotCliPathOverride(
  deps: Pick<CommandDependencies, 'configStore' | 'output'>,
  options?: { showWarning?: boolean }
): string | undefined {
  const { cliPath, warning } = resolveCopilotCliOverride(deps.configStore.getAiCopilotCliPath());
  if (warning) {
    deps.output.appendLine(`[Copilot SDK] ${warning}`);
    if (options?.showWarning) {
      void vscode.window.showWarningMessage(warning);
    }
  }
  return cliPath;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toQuickPickItems(
  values: string[],
  selectedValues: string[]
): vscode.QuickPickItem[] {
  return values.map(value => ({
    label: value,
    picked: selectedValues.includes(value)
  }));
}

function toTransitionQuickPickItems(
  transitions: WorkflowTransition[]
): Array<vscode.QuickPickItem & { transition: WorkflowTransition }> {
  return transitions.map(transition => ({
    label: transition.name,
    description: transition.toStatus,
    transition
  }));
}

const DEFAULT_CREATABLE_TYPES: Record<BackendMode, string[]> = {
  jira: ['Epic', 'Story', 'Task', 'Subtask', 'Bug'],
  demo: ['Feature', 'Story', 'Task', 'Subtask', 'Bug'],
  file: ['Feature', 'Story', 'Task', 'Subtask', 'Bug'],
  github: ['Feature', 'Story', 'Task', 'Subtask', 'Bug'],
  gitlab: ['Feature', 'Story', 'Task', 'Subtask', 'Bug'],
  livefolder: ['Feature', 'Story', 'Task', 'Bug'],
  userworkspace: ['Feature', 'Story', 'Task', 'Bug']
};

function suggestUserWorkspaceProjectName(folderPath: string): string {
  const folderName = path.basename(folderPath).trim();
  if (!folderName) {
    return 'User Workspace Project';
  }
  return folderName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function suggestUserWorkspaceProjectKey(folderPath: string): string {
  const folderName = path.basename(folderPath).trim();
  const compact = folderName.replace(/[^A-Za-z0-9]+/g, '');
  if (compact && /^[A-Za-z]/.test(compact)) {
    return compact.slice(0, 15).toUpperCase();
  }
  const initials = folderName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .toUpperCase();
  if (initials && /^[A-Z]/.test(initials)) {
    return initials.slice(0, 15);
  }
  return 'PLANS';
}

async function promptForUserWorkspaceBoardInput(): Promise<{
  name: string;
  projectKey: string;
  projectName: string;
  liveFolderPath: string;
} | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Select Folder to Search for Plans'
  });
  if (!uris?.[0]) {
    return undefined;
  }

  const identified = await identifyPlanFolder(uris[0]);
  const liveFolderPath = toStoredFolderPath(identified.plansRootUri.fsPath);
  if (liveFolderPath !== toStoredFolderPath(uris[0].fsPath)) {
    void vscode.window.showInformationMessage(`Found plans folder at ${liveFolderPath}.`);
  }

  const projectKey = (
    await vscode.window.showInputBox({
      title: 'Project key',
      prompt: 'Short key for issues on this board.',
      value: suggestUserWorkspaceProjectKey(liveFolderPath),
      ignoreFocusOut: true,
      validateInput: value => {
        const trimmed = value.trim();
        return /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(trimmed)
          ? undefined
          : 'Use letters, numbers, or underscore; 1-15 characters, start with a letter.';
      }
    })
  )?.trim();
  if (!projectKey) {
    return undefined;
  }

  const projectName = (
    await vscode.window.showInputBox({
      title: 'Project name',
      prompt: 'Display name for this board project.',
      value: suggestUserWorkspaceProjectName(liveFolderPath),
      ignoreFocusOut: true,
      validateInput: value =>
        value.trim().length > 0 ? undefined : 'Project name is required.'
    })
  )?.trim();
  if (!projectName) {
    return undefined;
  }

  const name = (
    await vscode.window.showInputBox({
      title: 'Board name',
      prompt: 'Name for the board shown in Ticket Manager.',
      value: projectName,
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length > 0 ? undefined : 'Board name is required.')
    })
  )?.trim();
  if (!name) {
    return undefined;
  }

  return {
    name,
    projectKey: projectKey.toUpperCase(),
    projectName,
    liveFolderPath
  };
}

function resolveCreateBoard(deps: CommandDependencies, arg: unknown): Board | undefined {
  if (arg instanceof BoardNode) {
    return arg.board;
  }

  return deps.boardPanelManager.getActiveBoard();
}

async function pickCreateProject(
  projects: Project[],
  defaultProjectKey?: string
): Promise<Project | undefined> {
  const defaultProject = defaultProjectKey
    ? projects.find(project => project.key === defaultProjectKey)
    : undefined;
  if (defaultProject) {
    return defaultProject;
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

async function getKnownIssueTypes(
  deps: CommandDependencies,
  projectKey: string
): Promise<string[]> {
  const filters = deps.filterStore.getFilters();
  const currentIssueTypes = deps.issuesProvider
    .getCurrentIssues()
    .filter(issue => issue.projectKey === projectKey)
    .map(issue => issue.issueType);

  let metadataIssueTypes: string[] = [];
  try {
    const metadata = await deps.backendService.getFilterMetadata({
      ...filters,
      projectKeys: [projectKey],
      statuses: [],
      issueTypes: [],
      searchText: '',
      parentKey: undefined
    });
    metadataIssueTypes = metadata.issueTypes;
  } catch {
    metadataIssueTypes = [];
  }

  return unique([
    ...metadataIssueTypes,
    ...currentIssueTypes,
    ...DEFAULT_CREATABLE_TYPES[deps.backendService.mode]
  ]);
}

async function promptForCreateIssueInput(
  deps: CommandDependencies,
  arg?: unknown
): Promise<CreateIssueInput | undefined> {
  const board = resolveCreateBoard(deps, arg);
  const selectedIssue = resolveIssue(deps.detailsProvider, arg);
  const filters = deps.filterStore.getFilters();
  const projects = await deps.backendService.getProjects();
  if (projects.length === 0) {
    await vscode.window.showWarningMessage('No projects are available.');
    return undefined;
  }

  const project = await pickCreateProject(
    projects,
    board?.projectKey ??
      selectedIssue?.projectKey ??
      (filters.projectKeys.length === 1 ? filters.projectKeys[0] : undefined)
  );
  if (!project) {
    return undefined;
  }

  const knownIssueTypes = await getKnownIssueTypes(deps, project.key);
  if (knownIssueTypes.length === 0) {
    await vscode.window.showWarningMessage(
      `No issue types are available for ${project.key}.`
    );
    return undefined;
  }

  const pickedType = await vscode.window.showQuickPick(
    knownIssueTypes.map(issueType => ({
      label: issueType
    })),
    {
      title: 'Issue Type'
    }
  );
  if (!pickedType) {
    return undefined;
  }

  const summary = await vscode.window.showInputBox({
    title: 'Issue Summary',
    prompt: `Enter a short summary for the new ${pickedType.label.toLowerCase()}.`,
    ignoreFocusOut: true,
    validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
  });
  if (summary === undefined) {
    return undefined;
  }

  const description = await vscode.window.showInputBox({
    title: 'Description',
    prompt: 'Optional description for the new issue.',
    ignoreFocusOut: true
  });
  if (description === undefined) {
    return undefined;
  }

  const parentRule = getParentRule(pickedType.label, deps.backendService.mode);
  const defaultParentKey =
    selectedIssue &&
    selectedIssue.projectKey === project.key &&
    isAllowedParentType(selectedIssue.issueType, pickedType.label, deps.backendService.mode)
      ? selectedIssue.key
      : undefined;

  let parentKey: string | undefined;
  if (parentRule.canHaveParent) {
    const pickedParentKey = await vscode.window.showInputBox({
      title: `${parentRule.defaultLabel} Key`,
      prompt: parentRule.requiresParent
        ? `${parentRule.helperText} Enter the ${parentRule.defaultLabel.toLowerCase()} key.`
        : `${parentRule.helperText} Leave blank for a top-level item.`,
      value: defaultParentKey ?? '',
      ignoreFocusOut: true,
      validateInput: value =>
        parentRule.requiresParent && value.trim().length === 0
          ? `${parentRule.defaultLabel} is required.`
          : undefined
    });
    if (pickedParentKey === undefined) {
      return undefined;
    }
    parentKey = pickedParentKey.trim() || undefined;
  }

  return {
    projectKey: project.key,
    issueType: pickedType.label,
    summary: summary.trim(),
    description: description.trim() || undefined,
    parentKey,
    boardId: board?.projectKey === project.key ? board.id : undefined
  };
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('ticketManager.refresh', async () => {
      await refreshViews(deps);
    }),
    vscode.commands.registerCommand('ticketManager.configureConnection', async () => {
      try {
        const result = await deps.configStore.configureConnection(deps.context);
        if (!result.saved) {
          return;
        }

        await deps.backendService.reset();
        await clearUiSelection(deps);
        await refreshViews(deps);
        await vscode.window.showInformationMessage(`Saved connection: ${result.description}`);
      } catch (error) {
        reportCommandError(deps, 'config', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.checkConnection', async () => {
      try {
        const result = await deps.backendService.checkConnection();
        deps.onConnectionCheck?.(result);
        await showConnectionResult(result);
      } catch (error) {
        reportCommandError(deps, 'check-connection', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.setBackendMode', async () => {
      // Reset configured context so the setup sidebar becomes visible
      await vscode.commands.executeCommand('setContext', 'ticketManager.configured', false);
      await vscode.commands.executeCommand('setContext', 'ticketManager.mode', 'unconfigured');
      deps.setupSidebarViewProvider.resetToModeSelection();
      // Reveal the setup view in the sidebar
      await vscode.commands.executeCommand('ticketManager.setup.focus');
    }),
    vscode.commands.registerCommand('ticketManager.importMarkdownFeaturePlan', async () => {
      await runMarkdownFeaturePlanImport(deps);
    }),
    vscode.commands.registerCommand('ticketManager.importWorkspaceMcpConfig', async () => {
      try {
        const result = await deps.configStore.importWorkspaceMcpConfig(deps.context);
        if (!result.saved) {
          return;
        }

        await deps.backendService.reset();
        await clearUiSelection(deps);
        await refreshViews(deps);
        await vscode.window.showInformationMessage(`Using ${result.description}.`);
      } catch (error) {
        reportCommandError(deps, 'workspace-mcp', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.importUserMcpConfig', async () => {
      try {
        const result = await deps.configStore.importUserMcpConfig(deps.context);
        if (!result.saved) {
          return;
        }

        await deps.backendService.reset();
        await clearUiSelection(deps);
        await refreshViews(deps);
        await vscode.window.showInformationMessage(`Using ${result.description}.`);
      } catch (error) {
        reportCommandError(deps, 'user-mcp', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.configureBoardColumns', async (arg?: unknown) => {
      const board =
        resolveBoard(deps.boardsProvider, arg, deps.boardStore) ??
        deps.boardPanelManager.getActiveBoard();
      if (!board) {
        await vscode.window.showInformationMessage(
          'Select a board in the Boards list or open a board tab first.'
        );
        return;
      }

      try {
        const details = await deps.backendService.getBoardDetails(board);
        await deps.boardColumnConfigPanel.open(board, details);
      } catch (error) {
        reportCommandError(deps, 'board-columns', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.openBoard', async (arg?: unknown) => {
      const board = resolveBoard(deps.boardsProvider, arg, deps.boardStore);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      await deps.boardStore.setLastSelectedBoardId(board.id);
      await deps.boardPanelManager.openBoard(board);
    }),
    vscode.commands.registerCommand('ticketManager.createIssue', async (arg?: unknown) => {
      try {
        if (deps.backendService.mode === 'file' && !(await deps.ensureFilePlanConfigured(true))) {
          return;
        }

        const draft = await promptForCreateIssueInput(deps, arg);
        if (!draft) {
          return;
        }

        const createdIssue = await deps.backendService.createIssue(draft);
        await refreshViews(deps);
        const refreshedIssue = deps.issuesProvider.getIssueByKey(createdIssue.key) ?? createdIssue;
        await deps.filterStore.setLastSelectedIssueKey(createdIssue.key);
        await deps.detailsProvider.setIssue(refreshedIssue);
        deps.boardPanelManager.setSelectedIssueKey(createdIssue.key);
        await deps.revealIssueDetailsTree();
        await vscode.window.showInformationMessage(
          draft.parentKey
            ? `Created ${createdIssue.key} under ${draft.parentKey}.`
            : `Created ${createdIssue.key}.`
        );
      } catch (error) {
        reportCommandError(deps, 'create-issue', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.createBoard', async () => {
      try {
        if (deps.backendService.mode === 'userworkspace') {
          const draft = await promptForUserWorkspaceBoardInput();
          if (!draft) {
            return;
          }
          await deps.backendService.createBoard(draft);
          await refreshViews(deps);
          await vscode.window.showInformationMessage(`Created board "${draft.name}".`);
          return;
        }

        if (deps.backendService.mode === 'jira') {
          await vscode.window.showWarningMessage(
            'Creating boards is not supported in Jira Connected mode.'
          );
          return;
        }

        if (deps.backendService.mode === 'livefolder') {
          await vscode.window.showWarningMessage(
            'Creating boards is not supported in Live Folder mode. Use Create User Workspace for multiple plan-folder boards.'
          );
          return;
        }

        if (deps.backendService.mode === 'file' && !(await deps.ensureFilePlanConfigured(true))) {
          return;
        }

        const projects = await deps.backendService.getProjects();
        if (projects.length === 0) {
          await vscode.window.showWarningMessage('No projects are available.');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          projects.map(project => ({
            label: project.key,
            description: project.name,
            project
          })),
          { title: 'Project for new board', ignoreFocusOut: true }
        );
        if (!picked) {
          return;
        }

        const name = await vscode.window.showInputBox({
          title: 'Board name',
          prompt: 'Enter a name for the new board.',
          ignoreFocusOut: true,
          validateInput: value => (value.trim().length > 0 ? undefined : 'Board name is required.')
        });
        if (name === undefined) {
          return;
        }

        await deps.backendService.createBoard({
          name: name.trim(),
          projectKey: picked.project.key
        });
        await refreshViews(deps);
        await vscode.window.showInformationMessage(`Created board "${name.trim()}".`);
      } catch (error) {
        reportCommandError(deps, 'create-board', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.setBoardProjects', async () => {
      const filters = deps.boardStore.getFilters();
      const projects = await deps.backendService.getProjects();

      if (projects.length === 0) {
        await vscode.window.showWarningMessage('No projects are available.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        projects.map(project => ({
          label: project.key,
          description: project.name,
          picked: filters.projectKeys.includes(project.key)
        })),
        {
          title: 'Board Projects',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.boardStore.updateFilters({
        projectKeys: picked.map(item => item.label)
      });
    }),
    vscode.commands.registerCommand('ticketManager.setBoardTypes', async () => {
      const filters = deps.boardStore.getFilters();
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'scrum', picked: filters.types.includes('scrum') },
          { label: 'kanban', picked: filters.types.includes('kanban') }
        ],
        {
          title: 'Board Types',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.boardStore.updateFilters({
        types: picked.map(item => item.label)
      });
    }),
    vscode.commands.registerCommand('ticketManager.setBoardSearchText', async () => {
      const filters = deps.boardStore.getFilters();
      const searchText = await vscode.window.showInputBox({
        title: 'Board Search',
        prompt: 'Filter boards by name, project, or location.',
        value: filters.searchText,
        ignoreFocusOut: true
      });

      if (searchText === undefined) {
        return;
      }

      await deps.boardStore.updateFilters({
        searchText
      });
    }),
    vscode.commands.registerCommand('ticketManager.clearBoardFilters', async () => {
      await deps.boardStore.clearFilters();
    }),
    vscode.commands.registerCommand('ticketManager.setProjects', async () => {
      const filters = deps.filterStore.getFilters();
      const projects = await deps.backendService.getProjects();

      if (projects.length === 0) {
        await vscode.window.showWarningMessage('No projects are available.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        projects.map(project => ({
          label: project.key,
          description: project.name,
          picked: filters.projectKeys.includes(project.key)
        })),
        {
          title: 'Projects',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        projectKeys: picked.map(item => item.label),
        parentKey: undefined
      });
    }),
    vscode.commands.registerCommand('ticketManager.setStatuses', async () => {
      const filters = deps.filterStore.getFilters();
      const metadata = await deps.backendService.getFilterMetadata(filters);
      const knownStatuses = unique([
        ...metadata.statuses,
        ...deps.issuesProvider.getCurrentIssues().map(issue => issue.status),
        ...filters.statuses
      ]);

      if (knownStatuses.length === 0) {
        await vscode.window.showInformationMessage('No statuses are available for the current filters.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        toQuickPickItems(knownStatuses, filters.statuses),
        {
          title: 'Status Filter',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        statuses: picked.map(item => item.label)
      });
    }),
    vscode.commands.registerCommand('ticketManager.setIssueTypes', async () => {
      const filters = deps.filterStore.getFilters();
      const metadata = await deps.backendService.getFilterMetadata(filters);
      const knownIssueTypes = unique([
        ...metadata.issueTypes,
        ...deps.issuesProvider.getCurrentIssues().map(issue => issue.issueType),
        ...filters.issueTypes
      ]);

      if (knownIssueTypes.length === 0) {
        await vscode.window.showInformationMessage(
          'No issue types are available for the current filters.'
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        toQuickPickItems(knownIssueTypes, filters.issueTypes),
        {
          title: 'Issue Type Filter',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        issueTypes: picked.map(item => item.label)
      });
    }),
    vscode.commands.registerCommand('ticketManager.setSearchText', async () => {
      const filters = deps.filterStore.getFilters();
      const searchText = await vscode.window.showInputBox({
        title: 'Search Text',
        prompt: 'Search issue text.',
        value: filters.searchText,
        ignoreFocusOut: true
      });

      if (searchText === undefined) {
        return;
      }

      await deps.filterStore.updateFilters({
        searchText
      });
    }),
    vscode.commands.registerCommand('ticketManager.toggleAssigneeMode', async () => {
      const filters = deps.filterStore.getFilters();
      const picked = await vscode.window.showQuickPick<
        { label: string; description: string; value: AssigneeMode }
      >(
        [
          {
            label: 'Assigned to me',
            description: 'Only include work assigned to the current user when supported.',
            value: 'me'
          },
          {
            label: 'All accessible issues',
            description: 'Remove the assignee restriction.',
            value: 'all'
          }
        ],
        {
          title: 'Assignee Scope',
          placeHolder: filters.assigneeMode === 'me' ? 'Assigned to me' : 'All accessible issues'
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        assigneeMode: picked.value
      });
    }),
    vscode.commands.registerCommand('ticketManager.setParentScope', async () => {
      const filters = deps.filterStore.getFilters();
      const parentSearchText = await vscode.window.showInputBox({
        title: 'Parent Item Search',
        prompt: 'Optional text used to narrow the available parent item list.',
        ignoreFocusOut: true
      });

      if (parentSearchText === undefined) {
        return;
      }

      const parentItems = await deps.backendService.getParentItems(
        {
          ...filters,
          parentKey: undefined
        },
        parentSearchText
      );

      if (parentItems.length === 0) {
        await vscode.window.showInformationMessage('No parent items match the current filters.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        parentItems.map(item => ({
          label: item.key,
          description: item.summary,
          detail: item.projectKey,
          picked: filters.parentKey === item.key
        })),
        {
          title: 'Parent Item Scope'
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        parentKey: picked.label
      });
    }),
    vscode.commands.registerCommand('ticketManager.clearParentScope', async () => {
      await deps.filterStore.updateFilters({
        parentKey: undefined
      });
    }),
    vscode.commands.registerCommand('ticketManager.clearFilters', async () => {
      await deps.filterStore.clearFilters();
      await deps.detailsProvider.setIssue(undefined);
    }),
    vscode.commands.registerCommand('ticketManager.changeStatus', async (arg?: unknown) => {
      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        await vscode.window.showInformationMessage('Select an issue first.');
        return;
      }

      try {
        const transitions = await deps.backendService.getTransitions(issue.key);
        if (transitions.length === 0) {
          const action = await vscode.window.showWarningMessage(
            `No transitions are available for ${issue.key}.`,
            'Open External Link'
          );
          if (action === 'Open External Link') {
            await openIssueInBrowser(deps, arg);
          }
          return;
        }

        const picked = await vscode.window.showQuickPick(toTransitionQuickPickItems(transitions), {
          title: `Change Status (${issue.key})`
        });

        if (!picked) {
          return;
        }

        await deps.backendService.transitionIssue(issue.key, picked.transition.id);
        await refreshViews(deps);
        const refreshedIssue = deps.issuesProvider.getIssueByKey(issue.key) ?? issue;
        await deps.detailsProvider.setIssue(refreshedIssue);
        await vscode.window.showInformationMessage(
          `${issue.key} moved to ${picked.transition.toStatus ?? picked.transition.name}.`
        );
      } catch (error) {
        reportCommandError(deps, 'transition', error);
        const action = await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
          'Open External Link'
        );
        if (action === 'Open External Link') {
          await openIssueInBrowser(deps, arg);
        }
      }
    }),
    vscode.commands.registerCommand('ticketManager.openIssueFullDetails', async (issueKey?: unknown) => {
      const key =
        typeof issueKey === 'string' && issueKey.trim().length > 0
          ? issueKey.trim()
          : deps.detailsProvider.getActiveIssue()?.key;
      if (!key) {
        await vscode.window.showInformationMessage('Select an issue first.');
        return;
      }

      try {
        const full = await deps.backendService.getIssue(key);
        await deps.filterStore.setLastSelectedIssueKey(key);
        await deps.detailsProvider.setIssue(full);
        deps.boardPanelManager.setSelectedIssueKey(key);
        await deps.revealIssueDetailsTree();
        await deps.issueDetailPanelManager.open(key);
      } catch (error) {
        reportCommandError(deps, 'issue-details', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.openInBrowser', async (arg?: unknown) => {
      await openIssueInBrowser(deps, arg);
    }),
    vscode.commands.registerCommand('ticketManager.copyKey', async (arg?: unknown) => {
      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        await vscode.window.showInformationMessage('Select an issue first.');
        return;
      }

      await vscode.env.clipboard.writeText(issue.key);
      await vscode.window.showInformationMessage(`Copied ${issue.key} to the clipboard.`);
    }),
    vscode.commands.registerCommand('ticketManager.loadMore', async (arg?: unknown) => {
      if (arg instanceof LoadMoreNode || arg === undefined) {
        await deps.issuesProvider.loadMore();
      }
    }),
    vscode.commands.registerCommand('ticketManager.newProject', () => {
      const enabled = vscode.workspace.getConfiguration('ticketManager').get<boolean>('enableNewProject', false);
      if (!enabled) {
        vscode.window.showInformationMessage(
          'The New Project wizard is a preview feature. Enable it in Settings → Ticket Manager → Enable New Project.',
          'Open Settings'
        ).then(choice => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'ticketManager.enableNewProject');
          }
        });
        return;
      }
      deps.newProjectWizardPanel.open();
    }),
    vscode.commands.registerCommand('ticketManager.openSetup', () => {
      void deps.setupWizardPanel.open();
    }),

    // ── Copilot Agent Delegation Commands ──────────────────────

    vscode.commands.registerCommand('ticketManager.delegateToCopilot', async (arg?: unknown) => {
      if (!deps.copilotAgentService || !deps.copilotSessionPanelManager || !deps.aiSessionManager) {
        vscode.window.showWarningMessage('Copilot Agent delegation is not configured.');
        return;
      }

      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        vscode.window.showWarningMessage('Select an issue first.');
        return;
      }

      // Check for existing active session
      const existing = deps.aiSessionManager.getAgentSession(issue.key);
      if (existing && !['completed', 'failed', 'aborted'].includes(existing.state)) {
        const pick = await vscode.window.showQuickPick(
          ['View existing session', 'Abort and start new'],
          { title: `${issue.key} already has an active agent session` }
        );
        if (!pick) {
          return;
        }
        if (pick === 'View existing session') {
          deps.copilotSessionPanelManager.open(issue.key);
          return;
        }
        await deps.copilotAgentService.abortTask(issue.key);
      }

      // Gather task definition via Quick Input
      const goal = await vscode.window.showInputBox({
        title: 'Goal',
        prompt: 'What should the agent accomplish?',
        value: `${issue.summary}${issue.description ? '\n' + issue.description.slice(0, 200) : ''}`,
        ignoreFocusOut: true
      });
      if (!goal) {
        return;
      }

      const scope = await vscode.window.showInputBox({
        title: 'Scope',
        prompt: 'What files/areas should the agent focus on?',
        value: 'This issue and related files',
        ignoreFocusOut: true
      });
      if (scope === undefined) {
        return;
      }

      const definitionOfDone = await vscode.window.showInputBox({
        title: 'Definition of Done',
        prompt: 'When is this task considered complete?',
        value: 'All acceptance criteria met, code compiles, tests pass',
        ignoreFocusOut: true
      });
      if (definitionOfDone === undefined) {
        return;
      }

      const cliPath = getCopilotCliPathOverride(deps, { showWarning: true });
      if (!deps.configStore.getConfiguredAiProviders().includes('copilot-cli')) {
        vscode.window.showErrorMessage(
          'GitHub Copilot SDK is not configured. Run Ticket Manager: Configure AI.'
        );
        return;
      }

      try {
        const details = await deps.backendService.getIssue(issue.key);
        const taskDef = {
          goal,
          scope: scope || 'This issue and related files',
          definitionOfDone: definitionOfDone || 'Task complete'
        };

        const workingDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await deps.copilotAgentService.startTask(details, taskDef, {
          cliPath,
          workingDirectory: workingDir
        });

        deps.copilotSessionPanelManager.open(issue.key);
        vscode.window.showInformationMessage(`Copilot agent started for ${issue.key}`);
      } catch (error) {
        reportCommandError(deps, 'delegateToCopilot', error);
        vscode.window.showErrorMessage(
          `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('ticketManager.viewAgentSession', (arg?: unknown) => {
      if (!deps.copilotSessionPanelManager) {
        return;
      }
      const issueKey = resolveIssueKey(deps.detailsProvider, arg);
      if (!issueKey) {
        vscode.window.showWarningMessage('Select an issue first.');
        return;
      }
      deps.copilotSessionPanelManager.open(issueKey);
    }),

    vscode.commands.registerCommand('ticketManager.abortAgentSession', async (arg?: unknown) => {
      if (!deps.copilotAgentService) {
        return;
      }
      const issueKey = resolveIssueKey(deps.detailsProvider, arg);
      if (!issueKey) {
        vscode.window.showWarningMessage('Select an issue first.');
        return;
      }
      await deps.copilotAgentService.abortTask(issueKey);
      vscode.window.showInformationMessage(`Agent session aborted for ${issueKey}.`);
    })
  ];
}
