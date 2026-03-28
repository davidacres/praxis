import type {
  BackendMode,
  FilterMetadata,
  JiraBoard,
  JiraBoardColumn,
  JiraBoardDetails,
  JiraBoardFilters,
  JiraConnectionCheck,
  JiraFilters,
  JiraIssueDetails,
  JiraIssueSummary,
  JiraProject,
  JiraTransition,
  PagedIssues
} from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { JiraConfigStore } from '../config/jiraConfig';

type DemoAssigneeKind = 'me' | 'other' | 'none';

interface DemoIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  issueType: string;
  projectKey: string;
  projectName: string;
  assigneeKind: DemoAssigneeKind;
  assigneeDisplayName?: string;
  priority: string;
  updated: string;
  description: string;
  parent?: string;
  failTransition?: boolean;
}

interface DemoBoard {
  id: string;
  name: string;
  type: 'scrum' | 'kanban';
  projectKey: string;
  projectName: string;
  locationName: string;
  issueKeys: string[];
}

function statusCategoryName(status: string): string {
  switch (status) {
    case 'Done':
      return 'done';
    case 'In Progress':
    case 'Blocked':
      return 'indeterminate';
    default:
      return 'todo';
  }
}

function transitionSet(status: string): JiraTransition[] {
  switch (status) {
    case 'To Do':
      return [
        { id: 'start-progress', name: 'Start Progress', toStatus: 'In Progress' },
        { id: 'mark-done', name: 'Done', toStatus: 'Done' }
      ];
    case 'In Progress':
      return [
        { id: 'mark-done', name: 'Done', toStatus: 'Done' },
        { id: 'block', name: 'Block', toStatus: 'Blocked' }
      ];
    case 'Blocked':
      return [{ id: 'resume', name: 'Resume', toStatus: 'In Progress' }];
    default:
      return [];
  }
}

function createSeedIssues(): DemoIssue[] {
  return [
    {
      id: 'demo-1',
      key: 'APP-100',
      summary: 'Core app epic',
      status: 'In Progress',
      issueType: 'Epic',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'High',
      updated: '2026-03-27T20:00:00.000Z',
      description: 'Primary epic for the application platform work.'
    },
    {
      id: 'demo-2',
      key: 'APP-101',
      summary: 'Implement dependency-injected backend router',
      status: 'To Do',
      issueType: 'Story',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'High',
      updated: '2026-03-27T20:10:00.000Z',
      description: 'Add the service abstraction so the UI can swap providers.',
      parent: 'APP-100'
    },
    {
      id: 'demo-3',
      key: 'APP-102',
      summary: 'Wire demo provider into the extension',
      status: 'In Progress',
      issueType: 'Task',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'other',
      assigneeDisplayName: 'Jordan Builder',
      priority: 'Medium',
      updated: '2026-03-27T20:20:00.000Z',
      description: 'Make demo mode work without a backend service.',
      parent: 'APP-100'
    },
    {
      id: 'demo-4',
      key: 'APP-103',
      summary: 'Simulate workflow validation edge case',
      status: 'Blocked',
      issueType: 'Task',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'Low',
      updated: '2026-03-27T20:30:00.000Z',
      description: 'This demo issue rejects one transition to mimic workflow restrictions.',
      parent: 'APP-100',
      failTransition: true
    },
    {
      id: 'demo-5',
      key: 'OPS-200',
      summary: 'Triage production incident',
      status: 'To Do',
      issueType: 'Bug',
      projectKey: 'OPS',
      projectName: 'Operations',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'Critical',
      updated: '2026-03-27T21:00:00.000Z',
      description: 'Investigate the latest customer-facing incident.'
    }
  ];
}

/** Demo workflow columns — shown even when no issues are in a status. */
const DEMO_BOARD_STATUS_ORDER = ['To Do', 'In Progress', 'Blocked', 'Done'] as const;

function createSeedBoards(): DemoBoard[] {
  return [
    {
      id: 'board-app',
      name: 'Application Board',
      type: 'scrum',
      projectKey: 'APP',
      projectName: 'Application Platform',
      locationName: 'Application Platform',
      issueKeys: ['APP-101', 'APP-102', 'APP-103']
    },
    {
      id: 'board-ops',
      name: 'Operations Board',
      type: 'kanban',
      projectKey: 'OPS',
      projectName: 'Operations',
      locationName: 'Operations',
      issueKeys: ['OPS-200']
    },
    {
      id: 'board-overview',
      name: 'Platform Overview',
      type: 'scrum',
      projectKey: 'APP',
      projectName: 'Application Platform',
      locationName: 'Application Platform',
      issueKeys: ['APP-100']
    }
  ];
}

function toIssueSummary(issue: DemoIssue): JiraIssueSummary {
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: statusCategoryName(issue.status),
    issueType: issue.issueType,
    projectKey: issue.projectKey,
    projectName: issue.projectName,
    assignee: issue.assigneeKind === 'none' ? undefined : issue.assigneeDisplayName,
    priority: issue.priority,
    updated: issue.updated,
    browseUrl: `https://example.com/jira-mini-demo/${issue.key}`,
    description: issue.description,
    raw: issue
  };
}

function toBoard(board: DemoBoard): JiraBoard {
  return {
    id: board.id,
    name: board.name,
    type: board.type,
    projectKey: board.projectKey,
    projectName: board.projectName,
    locationName: board.locationName,
    raw: board
  };
}

function sortIssuesByUpdated(issues: JiraIssueSummary[]): JiraIssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftUpdated = left.updated ?? '';
    const rightUpdated = right.updated ?? '';
    return rightUpdated.localeCompare(leftUpdated) || left.key.localeCompare(right.key);
  });
}

function statusCategoryRank(statusCategory?: string): number {
  switch (statusCategory?.toLowerCase()) {
    case 'todo':
      return 0;
    case 'indeterminate':
      return 1;
    case 'done':
      return 2;
    default:
      return 3;
  }
}

function commonStatusRank(statusName: string): number {
  switch (statusName.toLowerCase()) {
    case 'to do':
      return 0;
    case 'selected for development':
      return 1;
    case 'in progress':
      return 2;
    case 'blocked':
      return 3;
    case 'done':
      return 4;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function buildBoardColumns(issues: JiraIssueSummary[]): JiraBoardColumn[] {
  const issuesByStatus = new Map<string, JiraIssueSummary[]>();
  const statusCategories = new Map<string, string | undefined>();

  for (const issue of issues) {
    const statusName = issue.status || 'Unknown';
    const existing = issuesByStatus.get(statusName) ?? [];
    existing.push(issue);
    issuesByStatus.set(statusName, existing);

    if (!statusCategories.has(statusName)) {
      statusCategories.set(statusName, issue.statusCategory);
    }
  }

  return [...issuesByStatus.entries()]
    .sort((left, right) => {
      const leftCategory = statusCategories.get(left[0]);
      const rightCategory = statusCategories.get(right[0]);
      return (
        statusCategoryRank(leftCategory) - statusCategoryRank(rightCategory) ||
        commonStatusRank(left[0]) - commonStatusRank(right[0]) ||
        left[0].localeCompare(right[0])
      );
    })
    .map(([statusName, statusIssues]) => ({
      id: `status:${statusName}`,
      name: statusName,
      statusCategory: statusCategories.get(statusName),
      issues: sortIssuesByUpdated(statusIssues)
    }));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export class DemoService implements IssueTrackerService {
  public readonly mode: BackendMode = 'demo';

  private issues: DemoIssue[] = createSeedIssues();
  private boards: DemoBoard[] = createSeedBoards();

  public constructor(private readonly configStore: JiraConfigStore) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.issues = createSeedIssues();
    this.boards = createSeedBoards();
  }

  public async checkConnection(): Promise<JiraConnectionCheck> {
    const projects = await this.getProjects();
    return {
      status: 'ok',
      message: `Demo mode active. ${projects.length} demo project(s) loaded.`,
      toolCount: 0,
      projectCount: projects.length,
      serverName: 'demo-mode'
    };
  }

  public async getProjects(): Promise<JiraProject[]> {
    return [
      {
        id: 'demo-project-app',
        key: 'APP',
        name: 'Application Platform'
      },
      {
        id: 'demo-project-ops',
        key: 'OPS',
        name: 'Operations'
      }
    ];
  }

  public async getIssues(filters: JiraFilters, startAt: number, pageSize: number): Promise<PagedIssues> {
    const matchingIssues = sortIssuesByUpdated(
      this.issues
        .filter(issue => this.matchesIssueFilters(issue, filters))
        .map(toIssueSummary)
    );
    const pagedIssues = matchingIssues.slice(startAt, startAt + pageSize);

    return {
      issues: pagedIssues,
      total: matchingIssues.length,
      hasMore: startAt + pageSize < matchingIssues.length
    };
  }

  public async getFilterMetadata(filters: JiraFilters): Promise<FilterMetadata> {
    const metadataFilters: JiraFilters = {
      ...filters,
      statuses: [],
      issueTypes: []
    };
    const page = await this.getIssues(metadataFilters, 0, 200);

    return {
      statuses: uniqueSorted(page.issues.map(issue => issue.status)),
      issueTypes: uniqueSorted(page.issues.map(issue => issue.issueType))
    };
  }

  public async getEpics(filters: JiraFilters, searchText?: string): Promise<JiraIssueSummary[]> {
    const query = searchText?.trim().toLowerCase();
    return sortIssuesByUpdated(
      this.issues
        .filter(issue => issue.issueType === 'Epic')
        .filter(issue => filters.projectKeys.length === 0 || filters.projectKeys.includes(issue.projectKey))
        .filter(issue => {
          if (!query) {
            return true;
          }
          const haystack = `${issue.key} ${issue.summary} ${issue.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .map(toIssueSummary)
    );
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: JiraBoardFilters): Promise<JiraBoard[]> {
    const query = filters.searchText.trim().toLowerCase();
    return this.boards
      .filter(board => filters.projectKeys.length === 0 || filters.projectKeys.includes(board.projectKey))
      .filter(board => filters.types.length === 0 || filters.types.includes(board.type))
      .filter(board => {
        if (!query) {
          return true;
        }

        const haystack = `${board.name} ${board.projectKey} ${board.projectName} ${board.locationName}`.toLowerCase();
        return haystack.includes(query);
      })
      .map(toBoard)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getBoardDetails(board: JiraBoard): Promise<JiraBoardDetails> {
    const matchingBoard = this.boards.find(candidate => candidate.id === board.id);
    if (!matchingBoard) {
      throw new Error(`Demo board ${board.name} was not found.`);
    }

    const issues = sortIssuesByUpdated(
      this.issues
        .filter(issue => matchingBoard.issueKeys.includes(issue.key))
        .map(toIssueSummary)
    );

    return {
      board: toBoard(matchingBoard),
      issues,
      columns: buildBoardColumns(issues),
      columnStatusOrder: [...DEMO_BOARD_STATUS_ORDER]
    };
  }

  public async getIssue(issueKey: string): Promise<JiraIssueDetails> {
    const issue = this.findIssue(issueKey);
    return {
      ...toIssueSummary(issue),
      transitions: transitionSet(issue.status)
    };
  }

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    return transitionSet(this.findIssue(issueKey).status);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const issue = this.findIssue(issueKey);
    const transition = transitionSet(issue.status).find(candidate => candidate.id === transitionId);
    if (!transition) {
      throw new Error(`Transition ${transitionId} is not valid for ${issueKey}.`);
    }

    if (issue.failTransition) {
      throw new Error(
        `Workflow rejected the transition for ${issueKey} because extra fields are required.`
      );
    }

    issue.status = transition.toStatus ?? issue.status;
    issue.updated = new Date().toISOString();
  }

  public async getBrowseUrl(issue: JiraIssueSummary): Promise<string | undefined> {
    return issue.browseUrl;
  }

  public dispose(): void {}

  private matchesIssueFilters(issue: DemoIssue, filters: JiraFilters): boolean {
    if (filters.projectKeys.length > 0 && !filters.projectKeys.includes(issue.projectKey)) {
      return false;
    }

    if (filters.assigneeMode === 'me' && issue.assigneeKind !== 'me') {
      return false;
    }

    if (filters.statuses.length > 0 && !filters.statuses.includes(issue.status)) {
      return false;
    }

    if (filters.issueTypes.length > 0 && !filters.issueTypes.includes(issue.issueType)) {
      return false;
    }

    if (filters.epicKey && issue.parent !== filters.epicKey) {
      return false;
    }

    if (filters.searchText.trim().length === 0) {
      return true;
    }

    const haystack = `${issue.key} ${issue.summary} ${issue.description}`.toLowerCase();
    return haystack.includes(filters.searchText.trim().toLowerCase());
  }

  private findIssue(issueKey: string): DemoIssue {
    const issue = this.issues.find(candidate => candidate.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} was not found in demo mode.`);
    }
    return issue;
  }
}
