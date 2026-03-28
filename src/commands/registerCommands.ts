import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import { BoardStore } from '../state/boardStore';
import { FilterStore } from '../state/filterStore';
import type {
  AssigneeMode,
  BackendMode,
  GroupingMode,
  IssueSummary,
  WorkflowTransition
} from '../types';
import { BoardColumnConfigPanel } from '../views/boardColumnConfigPanel';
import { BoardPanelManager } from '../views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from '../views/boardsTreeProvider';
import { DetailsViewProvider } from '../views/detailsViewProvider';
import { IssueDetailPanelManager } from '../views/issueDetailPanelManager';
import { IssueNode, IssuesTreeProvider, LoadMoreNode } from '../views/issuesTreeProvider';

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
  /** Focus the Issue Details tree and expand the current issue root (no editor steal). */
  revealIssueDetailsTree: () => Promise<void>;
  ensureFilePlanConfigured: (interactive: boolean) => Promise<boolean>;
  output: vscode.OutputChannel;
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
        deps.output.appendLine(`[config] ${error instanceof Error ? error.stack ?? error.message : error}`);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.checkConnection', async () => {
      const result = await deps.backendService.checkConnection();
      await showConnectionResult(result);
    }),
    vscode.commands.registerCommand('ticketManager.setBackendMode', async () => {
      const currentMode = deps.configStore.getBackendMode();
      const picked = await vscode.window.showQuickPick<
        { label: string; description: string; mode: BackendMode }
      >(
        [
          {
            label: 'Jira Connected',
            description: 'Use the configured Jira MCP connection.',
            mode: 'jira'
          },
          {
            label: 'Demo',
            description: 'Use built-in demo data with no backend required.',
            mode: 'demo'
          },
          {
            label: 'File',
            description: 'Use a workspace plan file for projects, boards, and issues.',
            mode: 'file'
          }
        ],
        {
          title: 'Backend Mode',
          placeHolder:
            currentMode === 'demo'
              ? 'Demo'
              : currentMode === 'file'
                ? 'File'
                : currentMode === 'jira'
                  ? 'Jira Connected'
                  : undefined
        }
      );

      if (!picked) {
        return;
      }

      await setBackendMode(deps, picked.mode);
      await vscode.window.showInformationMessage(
        picked.mode === 'demo'
          ? 'The app is now using demo mode.'
          : picked.mode === 'file'
            ? 'The app is now using file mode.'
            : 'The app is now using Jira Connected mode.'
      );
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
        deps.output.appendLine(`[workspace-mcp] ${error instanceof Error ? error.stack ?? error.message : error}`);
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
        deps.output.appendLine(`[user-mcp] ${error instanceof Error ? error.stack ?? error.message : error}`);
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
        deps.output.appendLine(
          `[board-columns] ${error instanceof Error ? error.stack ?? error.message : error}`
        );
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
    vscode.commands.registerCommand('ticketManager.setGrouping', async () => {
      const picked = await vscode.window.showQuickPick<
        { label: string; description: string; value: GroupingMode }
      >(
        [
          {
            label: 'Project',
            description: 'Group issues by project.',
            value: 'project'
          },
          {
            label: 'Status',
            description: 'Group issues by status.',
            value: 'status'
          },
          {
            label: 'None',
            description: 'Show a flat list.',
            value: 'none'
          }
        ],
        {
          title: 'Grouping'
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.setGrouping(picked.value);
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
        deps.output.appendLine(`[transition] ${error instanceof Error ? error.stack ?? error.message : error}`);
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
        deps.output.appendLine(
          `[issue-details] ${error instanceof Error ? error.stack ?? error.message : error}`
        );
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
    })
  ];
}
