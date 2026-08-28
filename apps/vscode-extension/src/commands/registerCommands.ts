import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IssueTrackerService } from '@praxis/core';
import { AppConfigStore } from '../config/jiraConfig';
import { BoardStore } from '@praxis/core';
import { FilterStore } from '@praxis/core';
import type {
  AssigneeMode,
  BackendMode,
  Board,
  CreateIssueInput,
  IssueFilters,
  Project,
  IssueSummary,
  WorkflowTransition
} from '@praxis/core';
import { BoardColumnConfigPanel } from '../views/boardColumnConfigPanel';
import { BoardPanelManager } from '../views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from '../views/boardsTreeProvider';
import { DetailsViewProvider } from '../views/detailsViewProvider';
import { IssueDetailPanelManager } from '../views/issueDetailPanelManager';
import { IssueNode, IssuesTreeProvider, LoadMoreNode } from '../views/issuesTreeProvider';
import { NewProjectWizardPanel } from '../views/newProjectWizardPanel';
import { SetupSidebarViewProvider } from '../views/setupSidebarViewProvider';
import { SetupWizardPanel } from '../views/setupWizardPanel';
import { UserWorkspaceBoardWizardPanel } from '../views/userWorkspaceBoardWizardPanel';
import { TaskDesignerPanelManager } from '../views/taskDesignerPanelManager';
import {
  generateTicketPlanFromMarkdownFeatures,
  resolveSuggestedPlansFolderUri
} from '../import/markdownFeaturePlanImporter';
import { discoverPlanFolders, identifyPlanFolder } from '@praxis/core';
import { toStoredFolderPath } from '@praxis/core';
import {
  getParentRule,
  isAllowedParentType
} from '@praxis/core';
import type { VercelAgentService } from '@praxis/core';
import { promptForAgentWorkflowSelection } from '../ai/agentWorkflowPicker';
import { stageIssueAttachments } from '@praxis/core';
import type { CopilotSessionPanelManager } from '../views/copilotSessionPanel';
import type { AiSessionManager } from '@praxis/core';
import type { ConnectionStore } from '@praxis/core';
import type { BackendRouter } from '../backends/backendRouter';

interface CommandDependencies {
  context: vscode.ExtensionContext;
  configStore: AppConfigStore;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  connectionStore?: ConnectionStore;
  boardColumnConfigPanel: BoardColumnConfigPanel;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  newProjectWizardPanel: NewProjectWizardPanel;
  setupWizardPanel: SetupWizardPanel;
  userWorkspaceBoardWizardPanel: UserWorkspaceBoardWizardPanel;
  setupSidebarViewProvider: SetupSidebarViewProvider;
  taskDesignerPanelManager: TaskDesignerPanelManager;
  revealSetupView?: () => Promise<void>;
  /** Focus the Issue Details tree and expand the current issue root (no editor steal). */
  revealIssueDetailsTree: () => Promise<void>;
  openCreateIssueForm?: (defaults?: Partial<CreateIssueInput>) => Promise<boolean>;
  output: vscode.OutputChannel;
  reportError?: (error: unknown, scope?: string) => void;
  onConnectionCheck?: (
    result: Awaited<ReturnType<IssueTrackerService['checkConnection']>>
  ) => void;
  vercelAgentService?: VercelAgentService;
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
  if (
    arg &&
    typeof arg === 'object' &&
    'id' in arg &&
    'name' in arg &&
    typeof (arg as { id?: unknown }).id === 'string' &&
    typeof (arg as { name?: unknown }).name === 'string'
  ) {
    return arg as Board;
  }

  if (arg instanceof BoardNode) {
    return arg.board;
  }

  const selectedBoardId = boardStore.getLastSelectedBoardId();
  if (!selectedBoardId) {
    return undefined;
  }

  const trackedRef = boardStore.getLastSelectedTrackedBoard();
  if (trackedRef?.boardId === selectedBoardId) {
    const trackedMatch = boardsProvider
      .getCurrentBoards()
      .find(board => board.id === selectedBoardId && board.connectionId === trackedRef.connectionId);
    if (trackedMatch) {
      return trackedMatch;
    }
  }

  return boardsProvider.getBoardById(selectedBoardId);
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
    const identified = await identifyPlanFolder(chosen[0].fsPath);
    selectedPlansUri = vscode.Uri.file(identified.plansRootPath);
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
      prompt: 'Display name for the project in Praxis.',
      value: 'Example HIS Integration'
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
    saveLabel: 'Save imported ticket data',
    filters: { 'Ticket data files': ['jsonc', 'json'] },
    defaultUri: vscode.Uri.joinPath(folders[0].uri, 'ticket-data.imported.jsonc')
  });
  if (!saveUri) {
    return;
  }

  await vscode.workspace.fs.writeFile(saveUri, new TextEncoder().encode(result.jsonc));
  const { featuresImported, storiesImported, tasksImported, bugsImported } = result.stats;
  const importParts = [`${featuresImported} features`, `${storiesImported} stories`];
  if (tasksImported > 0) {
    importParts.push(`${tasksImported} tasks`);
  }
  if (bugsImported > 0) {
    importParts.push(`${bugsImported} bugs`);
  }
  const importSummary = importParts.join(', ');
  deps.output.appendLine(
    `[import] ${importSummary} → ${saveUri.fsPath}`
  );

  const goFile = await vscode.window.showInformationMessage(
    `Imported ${importSummary} from markdown into ${saveUri.fsPath}.`,
    'Open Folder'
  );

  if (goFile === 'Open Folder') {
    await vscode.commands.executeCommand('revealFileInOS', saveUri);
  }

  await deps.backendService.reset();
  await clearUiSelection(deps);
  await refreshViews(deps);
}

async function loadAllIssuesForMigration(
  service: IssueTrackerService,
  pageSize: number
): Promise<IssueSummary[]> {
  const filters: IssueFilters = {
    projectKeys: [],
    statuses: [],
    issueTypes: [],
    searchText: '',
    assigneeMode: 'all',
    parentKey: undefined,
    grouping: 'none'
  };

  const issues: IssueSummary[] = [];
  let startAt = 0;
  while (true) {
    const page = await service.getIssues(filters, startAt, pageSize);
    issues.push(...page.issues);
    if (!page.hasMore || page.issues.length === 0) {
      break;
    }
    startAt += page.issues.length;
  }

  return issues;
}

async function runLiveFolderToJiraMcpMigration(deps: CommandDependencies): Promise<void> {
  if (deps.backendService.mode !== 'livefolder') {
    await vscode.window.showWarningMessage(
      'Switch to Live Folder mode before running Live Folder to Jira migration.'
    );
    return;
  }

  const connectionCheck = await deps.backendService.checkConnection();
  if (connectionCheck.status !== 'ok') {
    const reason = connectionCheck.message?.trim() || 'no connection available';
    await vscode.window.showErrorMessage(
      `Jira MCP connection check failed (${reason}); configure the MCP server, then run the migration again.`
    );
    return;
  }

  const allIssues = await loadAllIssuesForMigration(deps.backendService, deps.backendService.getDefaultPageSize());
  const features = allIssues
    .filter(issue => issue.issueType === 'Feature')
    .sort((left, right) => left.summary.localeCompare(right.summary));

  if (features.length === 0) {
    await vscode.window.showWarningMessage('No Live Folder features were found to migrate.');
    return;
  }

  const selectedIssue = deps.detailsProvider.getActiveIssue();
  const defaultFeature =
    selectedIssue?.issueType === 'Feature'
      ? features.find(feature => feature.key === selectedIssue.key)
      : undefined;

  const feature =
    defaultFeature ??
    (features.length === 1
      ? features[0]
      : (
          await vscode.window.showQuickPick(
            features.map(candidate => ({
              label: candidate.summary,
              description: candidate.key,
              detail: candidate.description,
              feature: candidate
            })),
            {
              title: 'Feature to migrate'
            }
          )
        )?.feature);

  if (!feature) {
    return;
  }

  const projects = await deps.backendService.getProjects();
  if (projects.length === 0) {
    await vscode.window.showWarningMessage('No Jira projects are available through the current MCP connection.');
    return;
  }

  const targetProject = await pickCreateProject(projects, feature.projectKey);
  if (!targetProject) {
    return;
  }

  const epicMode = await vscode.window.showQuickPick(
    [
      {
        label: 'Create new epic',
        description: 'Create a Jira Epic from this Live Folder feature.',
        value: 'new'
      },
      {
        label: 'Attach to existing epic',
        description: 'Enter an existing Jira Epic key and create child issues under it.',
        value: 'existing'
      }
    ],
    {
      title: 'Epic target'
    }
  );
  if (!epicMode) {
    return;
  }

  let epicKey: string | undefined;
  if (epicMode.value === 'new') {
    const epicSummary = (
      await vscode.window.showInputBox({
        title: 'Epic summary',
        prompt: 'Summary for the Jira Epic created from this feature.',
        value: feature.summary,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'Epic summary is required.')
      })
    )?.trim();
    if (!epicSummary) {
      return;
    }
    const createdEpic = await deps.backendService.createIssue({
      projectKey: targetProject.key,
      issueType: 'Epic',
      summary: epicSummary,
      description: feature.description
    });
    epicKey = createdEpic.key;
  } else {
    epicKey = (
      await vscode.window.showInputBox({
        title: 'Existing Epic key',
        prompt: 'Enter the Jira Epic key to attach the migrated issues to.',
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'Epic key is required.')
      })
    )?.trim();
    if (!epicKey) {
      return;
    }
    await deps.backendService.getIssue(epicKey);
  }

  await deps.configStore.setJiraMcpEpicKey(epicKey);

  const childIssues = allIssues
    .filter(issue => issue.parentKey === feature.key)
    .filter(issue => issue.issueType !== 'Feature');

  let createdCount = 0;
  const failures: string[] = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Migrating ${feature.key} to Jira`,
      cancellable: false
    },
    async progress => {
      for (let index = 0; index < childIssues.length; index += 1) {
        const issue = childIssues[index];
        progress.report({
          message: `Creating ${issue.issueType} ${index + 1}/${childIssues.length}`,
          increment: childIssues.length > 0 ? 100 / childIssues.length : 100
        });
        try {
          await deps.backendService.createIssue({
            projectKey: targetProject.key,
            issueType: issue.issueType,
            summary: issue.summary,
            description: issue.description,
            parentKey: epicKey
          });
          createdCount += 1;
        } catch (error) {
          failures.push(
            `${issue.key}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  );

  deps.output.appendLine(
    `[migration] Feature ${feature.key} -> epic ${epicKey}; created ${createdCount}/${childIssues.length} child issues.`
  );
  for (const failure of failures) {
    deps.output.appendLine(`[migration] ${failure}`);
  }

  const switchChoice = await vscode.window.showInformationMessage(
    failures.length === 0
      ? `Migrated ${feature.key} to ${epicKey}. Created ${createdCount} child issues.`
      : `Migrated ${feature.key} to ${epicKey} with ${failures.length} issue creation failure(s). See Praxis output for details.`,
    'Switch to Jira MCP',
    'Stay on Live Folder'
  );

  if (switchChoice === 'Switch to Jira MCP') {
    await setBackendMode(deps, 'jiracloud');
    await vscode.window.showInformationMessage('Backend mode is now Jira MCP.');
  }
}

async function linkJiraMcpEpicToWorkspace(deps: CommandDependencies): Promise<void> {
  const connectionCheck = await deps.backendService.checkConnection();
  if (connectionCheck.status !== 'ok') {
    await vscode.window.showErrorMessage(
      'Jira MCP connection is not available. Configure the MCP server first, then link an epic to this workspace.'
    );
    return;
  }

  const currentEpicKey = deps.configStore.getJiraMcpEpicKey();
  const epicKey = await vscode.window.showInputBox({
    title: 'Linked Jira Epic Key',
    prompt:
      'Enter the Jira Epic key to associate with this workspace. Leave blank to clear the current link.',
    value: currentEpicKey,
    ignoreFocusOut: true
  });
  if (epicKey === undefined) {
    return;
  }

  const trimmedEpicKey = epicKey.trim();
  if (!trimmedEpicKey) {
    await deps.configStore.setJiraMcpEpicKey(undefined);
    await vscode.window.showInformationMessage('Cleared the linked Jira epic for this workspace.');
    return;
  }

  const epic = await deps.backendService.getIssue(trimmedEpicKey);
  if (epic.issueType !== 'Epic') {
    throw new Error(`${trimmedEpicKey} is a ${epic.issueType}, not an Epic.`);
  }

  await deps.configStore.setJiraMcpEpicKey(trimmedEpicKey);
  await vscode.window.showInformationMessage(
    `Linked this workspace to Jira epic ${trimmedEpicKey}.`
  );
}

async function linkJiraMcpBoardQueryToWorkspace(deps: CommandDependencies): Promise<void> {
  const connectionCheck = await deps.backendService.checkConnection();
  if (connectionCheck.status !== 'ok') {
    await vscode.window.showErrorMessage(
      'Jira MCP connection is not available. Configure the MCP server first, then set a board JQL query for this workspace.'
    );
    return;
  }

  const currentBoardJql = deps.configStore.getJiraMcpBoardJql();
  const boardJql = await vscode.window.showInputBox({
    title: 'Linked Jira Board JQL',
    prompt:
      'Enter a Jira JQL query to expose as a board in Jira MCP mode. Leave blank to clear the current board query.',
    value: currentBoardJql,
    ignoreFocusOut: true
  });
  if (boardJql === undefined) {
    return;
  }

  const trimmedBoardJql = boardJql.trim();
  if (!trimmedBoardJql) {
    await deps.configStore.setJiraMcpBoardJql(undefined);
    await vscode.window.showInformationMessage('Cleared the linked Jira board query for this workspace.');
    return;
  }

  await deps.configStore.setJiraMcpBoardJql(trimmedBoardJql);
  await vscode.window.showInformationMessage('Linked this workspace to a Jira JQL board query.');
}

async function refreshViews(deps: CommandDependencies): Promise<void> {
  await Promise.all([deps.issuesProvider.refresh(), deps.boardsProvider.refresh()]);
  const activeIssue = deps.detailsProvider.getActiveIssue();
  if (activeIssue) {
    const refreshedIssue = deps.issuesProvider.getIssueByKey(activeIssue.key);
    if (refreshedIssue) {
      await deps.detailsProvider.setIssue(refreshedIssue);
      deps.boardPanelManager.setSelectedIssueKey(refreshedIssue.key);
    } else {
      await deps.detailsProvider.setIssue(undefined);
      deps.boardPanelManager.setSelectedIssueKey(undefined);
      deps.issueDetailPanelManager.clear();
    }
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

function getVercelGatewayStartOptions(
  deps: Pick<CommandDependencies, 'configStore'>
): { apiKey?: string; gatewayUrl?: string } {
  return {
    apiKey: deps.configStore.getAiVercelGatewayApiKey() || undefined,
    gatewayUrl: deps.configStore.getAiVercelGatewayUrl() || undefined
  };
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
  jiracloud: ['Epic', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'],
  demo: ['Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'],
  github: ['Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'],
  gitlab: ['Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'],
  livefolder: ['Feature', 'Idea', 'Story', 'Task', 'Bug'],
  userworkspace: ['Feature', 'Idea', 'Story', 'Task', 'Bug']
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

/**
 * Resolve a picked folder to a plans root. If the folder is not already a
 * plans tree, create an empty `features/` directory so Live Folder loading
 * accepts it as a brand-new board root.
 */
async function resolveOrInitializePlansRoot(selectedUri: vscode.Uri): Promise<string> {
  try {
    const identified = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Looking for a plans folder…',
        cancellable: false
      },
      async progress => {
        return identifyPlanFolder(selectedUri.fsPath, message => progress.report({ message }));
      }
    );
    return toStoredFolderPath(identified.plansRootPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const choice = await vscode.window.showWarningMessage(
      `No existing plans were found under that folder. Use it as a new empty plans root?\n\n${detail}`,
      { modal: true },
      'Use folder',
      'Cancel'
    );
    if (choice !== 'Use folder') {
      throw new Error('Board creation cancelled.');
    }

    const featuresUri = vscode.Uri.joinPath(selectedUri, 'features');
    await vscode.workspace.fs.createDirectory(featuresUri);

    // Re-identify now that features/ exists.
    const identified = await identifyPlanFolder(selectedUri.fsPath);
    return toStoredFolderPath(identified.plansRootPath);
  }
}

async function promptForUserWorkspaceBoardInput(): Promise<Array<{
  name: string;
  projectKey: string;
  projectName: string;
  liveFolderPath: string;
}> | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use Folder',
    title: 'Select Folder for the Board (plans root or parent)'
  });
  if (!uris?.[0]) {
    return undefined;
  }

  let liveFolderPaths: string[];
  try {
    const matches = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Looking for plans folders…',
        cancellable: false
      },
      async progress => discoverPlanFolders(uris[0].fsPath, message => progress.report({ message }))
    );
    liveFolderPaths = matches.length > 0
      ? matches.map(match => toStoredFolderPath(match.plansRootPath))
      : [await resolveOrInitializePlansRoot(uris[0])];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Board creation cancelled.') {
      void vscode.window.showInformationMessage(message);
      return undefined;
    }
    throw error;
  }

  if (liveFolderPaths.length > 1) {
    void vscode.window.showInformationMessage(
      `Found ${liveFolderPaths.length} plans folders. A board will be created for each one.`
    );
  } else if (liveFolderPaths[0] !== toStoredFolderPath(uris[0].fsPath)) {
    void vscode.window.showInformationMessage(`Using plans folder at ${liveFolderPaths[0]}.`);
  }

  // Folder dialogs steal focus from webview-hosted commands; yield so the
  // following input boxes actually appear instead of resolving as cancelled.
  await new Promise<void>(resolve => setTimeout(resolve, 50));

  const drafts: Array<{
    name: string;
    projectKey: string;
    projectName: string;
    liveFolderPath: string;
  }> = [];
  for (const liveFolderPath of liveFolderPaths) {
    const projectKey = (
      await vscode.window.showInputBox({
        title: `Create Board — Project key (${liveFolderPath})`,
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
      void vscode.window.showInformationMessage('Board creation cancelled (project key not set).');
      return undefined;
    }

    const projectName = (
      await vscode.window.showInputBox({
        title: `Create Board — Project name (${liveFolderPath})`,
        prompt: 'Display name for this board project.',
        value: suggestUserWorkspaceProjectName(liveFolderPath),
        ignoreFocusOut: true,
        validateInput: value =>
          value.trim().length > 0 ? undefined : 'Project name is required.'
      })
    )?.trim();
    if (!projectName) {
      void vscode.window.showInformationMessage('Board creation cancelled (project name not set).');
      return undefined;
    }

    const name = (
      await vscode.window.showInputBox({
        title: `Create Board — Board name (${liveFolderPath})`,
        prompt: 'Name for the board shown in Praxis.',
        value: projectName,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'Board name is required.')
      })
    )?.trim();
    if (!name) {
      void vscode.window.showInformationMessage('Board creation cancelled (board name not set).');
      return undefined;
    }

    drafts.push({ name, projectKey: projectKey.toUpperCase(), projectName, liveFolderPath });
  }

  return drafts;
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
  const argumentRecord = arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : undefined;
  const defaultIssueType = typeof argumentRecord?.issueType === 'string'
    ? argumentRecord.issueType.trim()
    : undefined;
  const board = resolveCreateBoard(deps, arg);
  const selectedIssue = resolveIssue(deps.detailsProvider, arg);
  const filters = deps.filterStore.getFilters();
  const projects = await deps.backendService.getProjects();
  if (projects.length === 0) {
    await vscode.window.showWarningMessage('No projects are available.');
    return undefined;
  }

  const contextProjectKey =
    board?.projectKey ??
    selectedIssue?.projectKey ??
    (filters.projectKeys.length === 1 ? filters.projectKeys[0] : undefined);
  const contextProject = contextProjectKey
    ? projects.find(project => project.key === contextProjectKey)
    : undefined;
  const issueTypeProjectKey =
    contextProject?.key ??
    (projects.length === 1 ? projects[0].key : undefined);

  const knownIssueTypes = issueTypeProjectKey
    ? await getKnownIssueTypes(deps, issueTypeProjectKey)
    : unique([...DEFAULT_CREATABLE_TYPES[deps.backendService.mode]]);
  if (knownIssueTypes.length === 0) {
    await vscode.window.showWarningMessage(
      issueTypeProjectKey
        ? `No issue types are available for ${issueTypeProjectKey}.`
        : 'No issue types are available.'
    );
    return undefined;
  }

  const pickedType = defaultIssueType && knownIssueTypes.includes(defaultIssueType)
    ? { label: defaultIssueType }
    : await vscode.window.showQuickPick(
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

  const project = await pickCreateProject(
    projects,
    contextProject?.key ?? (projects.length === 1 ? projects[0].key : undefined)
  );
  if (!project) {
    return undefined;
  }

  const parentRule = getParentRule(pickedType.label, deps.backendService.mode);
  const linkedEpicKey =
    deps.backendService.mode === 'jiracloud' && parentRule.allowedParentTypes.includes('Epic')
      ? deps.configStore.getJiraMcpEpicKey()
      : undefined;
  const defaultParentKey =
    selectedIssue &&
    selectedIssue.projectKey === project.key &&
    isAllowedParentType(selectedIssue.issueType, pickedType.label, deps.backendService.mode)
      ? selectedIssue.key
      : linkedEpicKey || undefined;

  let parentKey: string | undefined;
  let newParentSummary: string | undefined;
  if (parentRule.canHaveParent) {
    const inlineCreateMode =
      deps.backendService.mode === 'livefolder' || deps.backendService.mode === 'userworkspace';
    if (parentRule.requiresParent) {
      // A required parent must be PICKED, not typed: keys like LIVE-F01 are
      // undiscoverable, and a wrong guess only surfaces as a backend error
      // after the whole form is filled in.
      let parentItems: IssueSummary[] = [];
      try {
        parentItems = await deps.backendService.getParentItems(
          { ...filters, projectKeys: [project.key], parentKey: undefined },
          undefined
        );
      } catch {
        parentItems = [];
      }

      interface ParentPick extends vscode.QuickPickItem {
        parentKey?: string;
        createNew?: boolean;
      }
      const createNewItem: ParentPick = {
        label: `$(plus) Create new ${parentRule.defaultLabel.toLowerCase()}…`,
        description: 'Type a name and it will be created as the parent.',
        createNew: true
      };
      const picks: ParentPick[] = [
        ...(inlineCreateMode ? [createNewItem] : []),
        ...parentItems.map(item => ({
          label: item.key,
          description: item.summary,
          parentKey: item.key,
          picked: item.key === defaultParentKey
        }))
      ];
      const picked = await vscode.window.showQuickPick(picks, {
        title: `${parentRule.defaultLabel} (required)`,
        placeHolder: parentRule.helperText
      });
      if (!picked) {
        return undefined;
      }
      if (picked.createNew) {
        const featureName = await vscode.window.showInputBox({
          title: `New ${parentRule.defaultLabel} Summary`,
          prompt: `A new ${parentRule.defaultLabel.toLowerCase()} with this name is created first, and the ${pickedType.label.toLowerCase()} is added under it.`,
          ignoreFocusOut: true,
          validateInput: value =>
            value.trim().length === 0 ? `${parentRule.defaultLabel} name is required.` : undefined
        });
        if (featureName === undefined) {
          return undefined;
        }
        newParentSummary = featureName.trim();
      } else {
        parentKey = picked.parentKey;
      }
    } else {
      const pickedParentKey = await vscode.window.showInputBox({
        title: `${parentRule.defaultLabel} Key`,
        prompt: `${parentRule.helperText} Leave blank for a top-level item.`,
        value: defaultParentKey ?? '',
        ignoreFocusOut: true
      });
      if (pickedParentKey === undefined) {
        return undefined;
      }
      parentKey = pickedParentKey.trim() || undefined;
    }
  }

  return {
    projectKey: project.key,
    issueType: pickedType.label,
    summary: summary.trim(),
    description: description.trim() || undefined,
    parentKey,
    newParentSummary,
    boardId: board && board.projectKey === project.key ? board.id : undefined
  };
}

function resolveCreateIssueDefaults(
  deps: CommandDependencies,
  arg?: unknown
): Partial<CreateIssueInput> {
  const argumentRecord = arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : undefined;
  const board = resolveCreateBoard(deps, arg);
  const selectedIssue = resolveIssue(deps.detailsProvider, arg);
  const issueType = typeof argumentRecord?.issueType === 'string'
    ? argumentRecord.issueType.trim()
    : undefined;

  return {
    projectKey: board?.projectKey ?? selectedIssue?.projectKey,
    issueType,
    parentKey: selectedIssue?.key,
    boardId: board?.id
  };
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('praxis.refresh', async () => {
      await refreshViews(deps);
    }),
    vscode.commands.registerCommand('praxis.configureConnection', async () => {
      try {
        const choice = await vscode.window.showInformationMessage(
          'Jira MCP is configured via `.vscode/mcp.json`. Edit your MCP servers file to add or update a Jira server, then reopen this connection.',
          'Open Documentation'
        );
        if (choice === 'Open Documentation') {
          await vscode.env.openExternal(
            vscode.Uri.parse('https://code.visualstudio.com/docs/copilot/chat/mcp-servers')
          );
        }
      } catch (error) {
        reportCommandError(deps, 'config', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.checkConnection', async () => {
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
    vscode.commands.registerCommand('praxis.setBackendMode', async () => {
      // Reset configured context so the setup sidebar becomes visible
      await vscode.commands.executeCommand('setContext', 'praxis.configured', false);
      await vscode.commands.executeCommand('setContext', 'praxis.mode', 'unconfigured');
      deps.setupSidebarViewProvider.resetToModeSelection();
      // Reveal the setup view in the active sidebar mode
      if (deps.revealSetupView) {
        await deps.revealSetupView();
        return;
      }
      await vscode.commands.executeCommand('praxis.setup.focus');
    }),
    vscode.commands.registerCommand('praxis.importMarkdownFeaturePlan', async () => {
      await runMarkdownFeaturePlanImport(deps);
    }),
    vscode.commands.registerCommand('praxis.migrateLiveFolderToJiraMcp', async () => {
      try {
        await runLiveFolderToJiraMcpMigration(deps);
      } catch (error) {
        reportCommandError(deps, 'livefolder-jira-cloud-migration', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.linkJiraMcpEpic', async () => {
      try {
        await linkJiraMcpEpicToWorkspace(deps);
      } catch (error) {
        reportCommandError(deps, 'link-jira-cloud-epic', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.linkJiraMcpBoardQuery', async () => {
      try {
        await linkJiraMcpBoardQueryToWorkspace(deps);
      } catch (error) {
        reportCommandError(deps, 'link-jira-cloud-board-query', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.configureBoardColumns', async (arg?: unknown) => {
      const board =
        resolveBoard(deps.boardsProvider, arg, deps.boardStore) ??
        deps.boardPanelManager.getActiveBoard();
      if (!board) {
        await vscode.commands.executeCommand('praxis.openConnectionsManager');
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
    vscode.commands.registerCommand('praxis.openBoard', async (arg?: unknown) => {
      const board = resolveBoard(deps.boardsProvider, arg, deps.boardStore);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      await deps.boardStore.setLastSelectedBoardId(board.id);
      await deps.boardPanelManager.openBoard(board);
    }),
    vscode.commands.registerCommand('praxis.createIssue', async (arg?: unknown) => {
      try {
        if (await deps.openCreateIssueForm?.(resolveCreateIssueDefaults(deps, arg))) {
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
        // Open the full detail page for the new issue, matching the behaviour
        // of praxis.issueDetails rather than only revealing the sidebar.
        await deps.issueDetailPanelManager.open(createdIssue.key);
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
    vscode.commands.registerCommand('praxis.createIdea', async () => {
      try {
        if (await deps.openCreateIssueForm?.({ issueType: 'Idea' })) {
          return;
        }

        await vscode.commands.executeCommand('praxis.createIssue', { issueType: 'Idea' });
      } catch (error) {
        reportCommandError(deps, 'create-idea', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.createBoard', async () => {
      try {
        const mode = deps.backendService.mode;
        const userWorkspaceConnection = deps.connectionStore
          ?.getConnections()
          .find(connection => connection.mode === 'userworkspace');

        if (mode === 'userworkspace' || userWorkspaceConnection) {
          const router = deps.backendService as BackendRouter;
          const activeId =
            typeof router.getActiveConnectionId === 'function'
              ? router.getActiveConnectionId()
              : undefined;
          const activeIsUserWorkspace =
            !!activeId &&
            deps.connectionStore?.getConnection(activeId)?.mode === 'userworkspace';
          const connectionId =
            (activeIsUserWorkspace ? activeId : undefined) ?? userWorkspaceConnection?.id;
          if (!connectionId) {
            throw new Error(
              'No User Workspace connection is available. Add one in Connections & Boards first.'
            );
          }

          const service =
            typeof router.serviceFor === 'function'
              ? await router.serviceFor(connectionId)
              : deps.backendService;
          const boardFilters = { projectKeys: [], types: [], searchText: '' };
          const existingBoards = await service.getBoards(boardFilters);
          const drafts = await deps.userWorkspaceBoardWizardPanel.open(
            existingBoards.map(board => board.locationName).filter((value): value is string => !!value),
            existingBoards.map(board => board.projectKey).filter((value): value is string => !!value)
          );
          if (!drafts || drafts.length === 0) {
            return;
          }

          const createdBoards: Board[] = [];
          let skippedBoards = 0;
          for (const draft of drafts) {
            const currentBoards = await service.getBoards(boardFilters);
            const normalizedPath = toStoredFolderPath(draft.liveFolderPath).toLowerCase();
            if (currentBoards.some(board =>
              board.locationName && toStoredFolderPath(board.locationName).toLowerCase() === normalizedPath
            )) {
              skippedBoards++;
              continue;
            }
            const created = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Creating board "${draft.name}"…`,
                cancellable: false
              },
              async () => service.createBoard(draft)
            );
            createdBoards.push(created);

            if (deps.connectionStore) {
              await deps.connectionStore.addTrackedBoard({
                connectionId,
                boardId: created.id,
                displayName: created.name
              });
            }
          }
          if (typeof router.setActiveConnection === 'function') {
            router.setActiveConnection(connectionId);
          }
          if (createdBoards.length > 0) {
            await deps.boardStore.setLastSelectedTrackedBoard({
              connectionId,
              boardId: createdBoards[createdBoards.length - 1].id
            });
          }
          await refreshViews(deps);
          await vscode.window.showInformationMessage(
            skippedBoards > 0
              ? `Created ${createdBoards.length} board${createdBoards.length === 1 ? '' : 's'}; skipped ${skippedBoards} already added.`
              : createdBoards.length === 1
              ? `Created board "${createdBoards[0].name}".`
              : `Created ${createdBoards.length} boards.`
          );
          return;
        }

        if (mode === 'jiracloud' || mode === 'gitlab') {
          // Track an existing remote board rather than inventing one locally.
          await vscode.commands.executeCommand('praxis.addBoard');
          return;
        }

        if (mode === 'livefolder') {
          await vscode.window.showWarningMessage(
            'Creating boards is not supported in Live Folder mode. Use a User Workspace connection for multiple plan-folder boards.'
          );
          return;
        }

        // Demo / other modes: open Connections & Boards to add or track boards.
        await vscode.commands.executeCommand('praxis.openConnectionsManager');
      } catch (error) {
        reportCommandError(deps, 'create-board', error);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('praxis.setBoardProjects', async () => {
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
    vscode.commands.registerCommand('praxis.setBoardTypes', async () => {
      const filters = deps.boardStore.getFilters();
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'scrum', picked: filters.types.includes('scrum') },
          { label: 'kanban', picked: filters.types.includes('kanban') },
          { label: 'epic', picked: filters.types.includes('epic') },
          { label: 'jql', picked: filters.types.includes('jql') }
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
    vscode.commands.registerCommand('praxis.setBoardSearchText', async () => {
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
    vscode.commands.registerCommand('praxis.clearBoardFilters', async () => {
      await deps.boardStore.clearFilters();
    }),
    vscode.commands.registerCommand('praxis.setProjects', async () => {
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
    vscode.commands.registerCommand('praxis.setStatuses', async () => {
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
    vscode.commands.registerCommand('praxis.setIssueTypes', async () => {
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
    vscode.commands.registerCommand('praxis.setSearchText', async () => {
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
    vscode.commands.registerCommand('praxis.toggleAssigneeMode', async () => {
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
    vscode.commands.registerCommand('praxis.setParentScope', async () => {
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
    vscode.commands.registerCommand('praxis.clearParentScope', async () => {
      await deps.filterStore.updateFilters({
        parentKey: undefined
      });
    }),
    vscode.commands.registerCommand('praxis.clearFilters', async () => {
      await deps.filterStore.clearFilters();
      await deps.detailsProvider.setIssue(undefined);
    }),
    vscode.commands.registerCommand('praxis.changeStatus', async (arg?: unknown) => {
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
    vscode.commands.registerCommand('praxis.openIssueFullDetails', async (issueKey?: unknown) => {
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
    vscode.commands.registerCommand('praxis.openInBrowser', async (arg?: unknown) => {
      await openIssueInBrowser(deps, arg);
    }),
    vscode.commands.registerCommand('praxis.copyKey', async (arg?: unknown) => {
      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        await vscode.window.showInformationMessage('Select an issue first.');
        return;
      }

      await vscode.env.clipboard.writeText(issue.key);
      await vscode.window.showInformationMessage(`Copied ${issue.key} to the clipboard.`);
    }),
    vscode.commands.registerCommand('praxis.loadMore', async (arg?: unknown) => {
      if (arg instanceof LoadMoreNode || arg === undefined) {
        await deps.issuesProvider.loadMore();
      }
    }),
    vscode.commands.registerCommand('praxis.newProject', () => {
      const enabled = vscode.workspace.getConfiguration('praxis').get<boolean>('enableNewProject', true);
      if (!enabled) {
        vscode.window.showInformationMessage(
          'The New Project wizard is a preview feature. Enable it in Settings → Praxis → Enable New Project.',
          'Open Settings'
        ).then(choice => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'praxis.enableNewProject');
          }
        });
        return;
      }
      deps.newProjectWizardPanel.open();
    }),
    vscode.commands.registerCommand('praxis.openSetup', () => {
      void deps.setupWizardPanel.open();
    }),
    vscode.commands.registerCommand('praxis.openTaskDesigner', () => {
      const board = deps.boardPanelManager.getActiveBoard() ?? resolveBoard(deps.boardsProvider, undefined, deps.boardStore);
      deps.taskDesignerPanelManager.open(
        board ? { id: board.id, name: board.name, connectionId: board.connectionId } : undefined
      );
    }),

    vscode.commands.registerCommand('praxis.assignWorkflowPack', async (arg?: unknown) => {
      if (!deps.aiSessionManager) {
        vscode.window.showWarningMessage('Workflow assignment is not configured.');
        return;
      }

      const issueKey = resolveIssueKey(deps.detailsProvider, arg);
      if (!issueKey) {
        vscode.window.showWarningMessage('Select an issue first.');
        return;
      }

      const workingDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const existingAssignment = deps.aiSessionManager.getIssueWorkflowAssignment(issueKey);
      const workflow = await promptForAgentWorkflowSelection({
        workspaceRoot: workingDir,
        previous: existingAssignment?.workflow,
        title: 'Assign Workflow Pack',
        placeHolder: 'Select the workflow pack to use for this issue'
      });
      if (workflow === null) {
        return;
      }

      if (!workflow) {
        deps.aiSessionManager.setIssueWorkflowAssignment(issueKey, undefined, {
          source: 'manual',
          reason: 'User explicitly selected "No workflow pack".'
        });
        vscode.window.showInformationMessage(
          `Recorded explicit "no workflow pack" choice for ${issueKey}. Delivery will proceed without a workflow directive.`
        );
        return;
      }

      deps.aiSessionManager.setIssueWorkflowAssignment(issueKey, workflow, {
        source: 'manual'
      });
      vscode.window.showInformationMessage(`Assigned workflow pack ${workflow.name} to ${issueKey}.`);
    }),

    // ── AI Agent Delegation Commands ──────────────────────

    vscode.commands.registerCommand('praxis.delegateToAiAgent', async (arg?: unknown) => {
      if (!deps.vercelAgentService || !deps.copilotSessionPanelManager || !deps.aiSessionManager) {
        vscode.window.showWarningMessage('AI Agent delegation is not configured.');
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
        await deps.vercelAgentService.abortTask(issue.key);
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

      const workingDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const issueWorkflowAssignment = deps.aiSessionManager.getIssueWorkflowAssignment(issue.key);
      const workflow = await promptForAgentWorkflowSelection({
        workspaceRoot: workingDir,
        previous: issueWorkflowAssignment?.workflow,
        title: 'Workflow Pack',
        placeHolder: 'Select an optional workflow pack for this AI agent task'
      });
      if (workflow === null) {
        return;
      }

      const gateway = getVercelGatewayStartOptions(deps);
      if (!deps.configStore.getConfiguredAiProviders().includes('vercel-gateway')) {
        vscode.window.showErrorMessage(
          'Vercel AI Gateway is not configured. Run Praxis: Configure AI.'
        );
        return;
      }

      try {
        const details = await deps.backendService.getIssue(issue.key);
        const attachments = await stageIssueAttachments({
          issue: details,
          backendService: deps.backendService,
          logger: deps.output
        });
        const taskDef = {
          goal,
          scope: scope || 'This issue and related files',
          definitionOfDone: definitionOfDone || 'Task complete',
          workflow,
          attachments: attachments.length > 0 ? attachments : undefined
        };

        await deps.vercelAgentService.startTask(details, taskDef, {
          ...gateway,
          workingDirectory: workingDir
        });

        deps.copilotSessionPanelManager.open(issue.key);
        vscode.window.showInformationMessage(`AI Agent started for ${issue.key}`);
      } catch (error) {
        reportCommandError(deps, 'delegateToCopilot', error);
        vscode.window.showErrorMessage(
          `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    // Deprecated alias kept for existing keybindings/menus.
    vscode.commands.registerCommand('praxis.delegateToCopilot', async (arg?: unknown) => {
      await vscode.commands.executeCommand('praxis.delegateToAiAgent', arg);
    }),

    vscode.commands.registerCommand('praxis.viewAgentSession', (arg?: unknown) => {
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

    vscode.commands.registerCommand('praxis.abortAgentSession', async (arg?: unknown) => {
      if (!deps.vercelAgentService) {
        return;
      }
      const issueKey = resolveIssueKey(deps.detailsProvider, arg);
      if (!issueKey) {
        vscode.window.showWarningMessage('Select an issue first.');
        return;
      }
      await deps.vercelAgentService.abortTask(issueKey);
      vscode.window.showInformationMessage(`Agent session aborted for ${issueKey}.`);
    })
  ];
}


