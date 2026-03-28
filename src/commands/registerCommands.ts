import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { JiraConfigStore } from '../config/jiraConfig';
import { BoardStore } from '../state/boardStore';
import { FilterStore } from '../state/filterStore';
import type { BackendMode, AssigneeMode, GroupingMode, JiraIssueSummary, JiraTransition } from '../types';
import { BoardPanelManager } from '../views/boardPanelManager';
import { BoardNode, BoardsTreeProvider } from '../views/boardsTreeProvider';
import { DetailsViewProvider } from '../views/detailsViewProvider';
import { IssueNode, IssuesTreeProvider, LoadMoreNode } from '../views/issuesTreeProvider';

interface CommandDependencies {
  context: vscode.ExtensionContext;
  configStore: JiraConfigStore;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  output: vscode.OutputChannel;
}

function resolveIssue(
  detailsProvider: DetailsViewProvider,
  arg: unknown
): JiraIssueSummary | undefined {
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
}

async function clearUiSelection(deps: CommandDependencies): Promise<void> {
  await deps.filterStore.setLastSelectedIssueKey(undefined);
  await deps.boardStore.setLastSelectedBoardId(undefined);
  await deps.detailsProvider.setIssue(undefined);
  deps.boardPanelManager.clear();
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
    void vscode.window.showInformationMessage('Select a Jira issue first.');
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
  transitions: JiraTransition[]
): Array<vscode.QuickPickItem & { transition: JiraTransition }> {
  return transitions.map(transition => ({
    label: transition.name,
    description: transition.toStatus,
    transition
  }));
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraMini.refresh', async () => {
      await refreshViews(deps);
    }),
    vscode.commands.registerCommand('jiraMini.configureConnection', async () => {
      try {
        const result = await deps.configStore.configureConnection(deps.context);
        if (!result.saved) {
          return;
        }

        await deps.backendService.reset();
        await clearUiSelection(deps);
        await refreshViews(deps);
        await vscode.window.showInformationMessage(`Saved Jira connection: ${result.description}`);
      } catch (error) {
        deps.output.appendLine(`[config] ${error instanceof Error ? error.stack ?? error.message : error}`);
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }
    }),
    vscode.commands.registerCommand('jiraMini.checkConnection', async () => {
      const result = await deps.backendService.checkConnection();
      await showConnectionResult(result);
    }),
    vscode.commands.registerCommand('jiraMini.setBackendMode', async () => {
      const currentMode = deps.configStore.getBackendMode();
      const picked = await vscode.window.showQuickPick<
        { label: string; description: string; mode: BackendMode }
      >(
        [
          {
            label: 'Jira MCP',
            description: 'Use the configured Jira MCP connection.',
            mode: 'jira'
          },
          {
            label: 'Demo Mode',
            description: 'Use built-in demo data with no backend required.',
            mode: 'demo'
          }
        ],
        {
          title: 'Jira Mini: Backend Mode',
          placeHolder: currentMode === 'demo' ? 'Demo Mode' : 'Jira MCP'
        }
      );

      if (!picked) {
        return;
      }

      await setBackendMode(deps, picked.mode);
      await vscode.window.showInformationMessage(
        picked.mode === 'demo'
          ? 'Jira Mini is now using demo mode.'
          : 'Jira Mini is now using the Jira MCP backend.'
      );
    }),
    vscode.commands.registerCommand('jiraMini.importWorkspaceMcpConfig', async () => {
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
    vscode.commands.registerCommand('jiraMini.importUserMcpConfig', async () => {
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
    vscode.commands.registerCommand('jiraMini.openBoard', async (arg?: unknown) => {
      const board = resolveBoard(deps.boardsProvider, arg, deps.boardStore);
      if (!board) {
        await vscode.window.showInformationMessage('Select a Jira board first.');
        return;
      }

      await deps.boardStore.setLastSelectedBoardId(board.id);
      await deps.boardPanelManager.openBoard(board);
    }),
    vscode.commands.registerCommand('jiraMini.setBoardProjects', async () => {
      const filters = deps.boardStore.getFilters();
      const projects = await deps.backendService.getProjects();

      if (projects.length === 0) {
        await vscode.window.showWarningMessage('No Jira projects are accessible.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        projects.map(project => ({
          label: project.key,
          description: project.name,
          picked: filters.projectKeys.includes(project.key)
        })),
        {
          title: 'Jira Mini: Board Projects',
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
    vscode.commands.registerCommand('jiraMini.setBoardTypes', async () => {
      const filters = deps.boardStore.getFilters();
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'scrum', picked: filters.types.includes('scrum') },
          { label: 'kanban', picked: filters.types.includes('kanban') }
        ],
        {
          title: 'Jira Mini: Board Types',
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
    vscode.commands.registerCommand('jiraMini.setBoardSearchText', async () => {
      const filters = deps.boardStore.getFilters();
      const searchText = await vscode.window.showInputBox({
        title: 'Jira Mini: Board Search',
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
    vscode.commands.registerCommand('jiraMini.clearBoardFilters', async () => {
      await deps.boardStore.clearFilters();
    }),
    vscode.commands.registerCommand('jiraMini.setProjects', async () => {
      const filters = deps.filterStore.getFilters();
      const projects = await deps.backendService.getProjects();

      if (projects.length === 0) {
        await vscode.window.showWarningMessage('No Jira projects are accessible.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        projects.map(project => ({
          label: project.key,
          description: project.name,
          picked: filters.projectKeys.includes(project.key)
        })),
        {
          title: 'Jira Mini: Projects',
          canPickMany: true
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        projectKeys: picked.map(item => item.label),
        epicKey: undefined
      });
    }),
    vscode.commands.registerCommand('jiraMini.setStatuses', async () => {
      const filters = deps.filterStore.getFilters();
      const metadata = await deps.backendService.getFilterMetadata(filters);
      const knownStatuses = unique([
        ...metadata.statuses,
        ...deps.issuesProvider.getCurrentIssues().map(issue => issue.status),
        ...filters.statuses
      ]);

      if (knownStatuses.length === 0) {
        await vscode.window.showInformationMessage('No Jira statuses are available for the current filters.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        toQuickPickItems(knownStatuses, filters.statuses),
        {
          title: 'Jira Mini: Status Filter',
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
    vscode.commands.registerCommand('jiraMini.setIssueTypes', async () => {
      const filters = deps.filterStore.getFilters();
      const metadata = await deps.backendService.getFilterMetadata(filters);
      const knownIssueTypes = unique([
        ...metadata.issueTypes,
        ...deps.issuesProvider.getCurrentIssues().map(issue => issue.issueType),
        ...filters.issueTypes
      ]);

      if (knownIssueTypes.length === 0) {
        await vscode.window.showInformationMessage(
          'No Jira issue types are available for the current filters.'
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        toQuickPickItems(knownIssueTypes, filters.issueTypes),
        {
          title: 'Jira Mini: Issue Type Filter',
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
    vscode.commands.registerCommand('jiraMini.setSearchText', async () => {
      const filters = deps.filterStore.getFilters();
      const searchText = await vscode.window.showInputBox({
        title: 'Jira Mini: Search Text',
        prompt: 'Search Jira issue text using JQL text search.',
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
    vscode.commands.registerCommand('jiraMini.toggleAssigneeMode', async () => {
      const filters = deps.filterStore.getFilters();
      const picked = await vscode.window.showQuickPick<
        { label: string; description: string; value: AssigneeMode }
      >(
        [
          {
            label: 'Assigned to me',
            description: 'Use currentUser() in the Jira query.',
            value: 'me'
          },
          {
            label: 'All accessible issues',
            description: 'Remove the assignee restriction.',
            value: 'all'
          }
        ],
        {
          title: 'Jira Mini: Assignee Scope',
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
    vscode.commands.registerCommand('jiraMini.setEpicScope', async () => {
      const filters = deps.filterStore.getFilters();
      const epicSearchText = await vscode.window.showInputBox({
        title: 'Jira Mini: Epic Search',
        prompt: 'Optional text used to narrow the available epic list.',
        ignoreFocusOut: true
      });

      if (epicSearchText === undefined) {
        return;
      }

      const epics = await deps.backendService.getEpics(
        {
          ...filters,
          epicKey: undefined
        },
        epicSearchText
      );

      if (epics.length === 0) {
        await vscode.window.showInformationMessage('No epics match the current Jira filters.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        epics.map(epic => ({
          label: epic.key,
          description: epic.summary,
          detail: epic.projectKey,
          picked: filters.epicKey === epic.key
        })),
        {
          title: 'Jira Mini: Epic Scope'
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.updateFilters({
        epicKey: picked.label
      });
    }),
    vscode.commands.registerCommand('jiraMini.clearEpicScope', async () => {
      await deps.filterStore.updateFilters({
        epicKey: undefined
      });
    }),
    vscode.commands.registerCommand('jiraMini.clearFilters', async () => {
      await deps.filterStore.clearFilters();
      await deps.detailsProvider.setIssue(undefined);
    }),
    vscode.commands.registerCommand('jiraMini.setGrouping', async () => {
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
            description: 'Group issues by Jira status.',
            value: 'status'
          },
          {
            label: 'None',
            description: 'Show a flat list.',
            value: 'none'
          }
        ],
        {
          title: 'Jira Mini: Grouping'
        }
      );

      if (!picked) {
        return;
      }

      await deps.filterStore.setGrouping(picked.value);
    }),
    vscode.commands.registerCommand('jiraMini.changeStatus', async (arg?: unknown) => {
      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        await vscode.window.showInformationMessage('Select a Jira issue first.');
        return;
      }

      try {
        const transitions = await deps.backendService.getTransitions(issue.key);
        if (transitions.length === 0) {
          const action = await vscode.window.showWarningMessage(
            `No transitions are available for ${issue.key}.`,
            'Open in Jira'
          );
          if (action === 'Open in Jira') {
            await openIssueInBrowser(deps, arg);
          }
          return;
        }

        const picked = await vscode.window.showQuickPick(toTransitionQuickPickItems(transitions), {
          title: `Jira Mini: Change Status (${issue.key})`
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
          'Open in Jira'
        );
        if (action === 'Open in Jira') {
          await openIssueInBrowser(deps, arg);
        }
      }
    }),
    vscode.commands.registerCommand('jiraMini.openInBrowser', async (arg?: unknown) => {
      await openIssueInBrowser(deps, arg);
    }),
    vscode.commands.registerCommand('jiraMini.copyKey', async (arg?: unknown) => {
      const issue = resolveIssue(deps.detailsProvider, arg);
      if (!issue) {
        await vscode.window.showInformationMessage('Select a Jira issue first.');
        return;
      }

      await vscode.env.clipboard.writeText(issue.key);
      await vscode.window.showInformationMessage(`Copied ${issue.key} to the clipboard.`);
    }),
    vscode.commands.registerCommand('jiraMini.loadMore', async (arg?: unknown) => {
      if (arg instanceof LoadMoreNode || arg === undefined) {
        await deps.issuesProvider.loadMore();
      }
    })
  ];
}
