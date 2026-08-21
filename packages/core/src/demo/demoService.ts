import type {
  BackendMode,
  Board,
  BoardColumn,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueAttachment,
  IssueComment,
  IssueDetails,
  IssueFilters,
  ParentIssueReference,
  ParentItemQueryOptions,
  IssueSummary,
  PagedIssues,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import {
  buildParentValidationMessage,
  getParentRule,
  isAllowedParentType,
  normalizeIssueTypeLabel
} from '../issues/issueHierarchy';

type DemoAssigneeKind = 'me' | 'other' | 'none';

interface DemoComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
}

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
  created: string;
  updated: string;
  description: string;
  parent?: string;
  comments: DemoComment[];
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
    case 'Backlog':
    default:
      return 'todo';
  }
}

function transitionSet(status: string): WorkflowTransition[] {
  switch (status) {
    case 'Backlog':
      return [
        { id: 'ready-for-work', name: 'Ready for Work', toStatus: 'To Do' },
        { id: 'start-progress', name: 'Start Progress', toStatus: 'In Progress' }
      ];
    case 'To Do':
      return [
        { id: 'send-backlog', name: 'Move to Backlog', toStatus: 'Backlog' },
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
      summary: 'Core platform feature',
      status: 'In Progress',
      issueType: 'Feature',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'High',
      created: '2026-03-27T19:30:00.000Z',
      updated: '2026-03-27T20:00:00.000Z',
      description: 'Primary feature for the application platform work.',
      comments: [
        {
          id: 'demo-comment-1',
          author: 'Alex Agent',
          body: 'Kickoff is complete and the feature is actively moving.',
          created: '2026-03-27T20:05:00.000Z',
          updated: '2026-03-27T20:05:00.000Z'
        }
      ]
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
      created: '2026-03-27T19:40:00.000Z',
      updated: '2026-03-27T20:10:00.000Z',
      description: 'Add the service abstraction so the UI can swap providers.',
      parent: 'APP-100',
      comments: []
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
      created: '2026-03-27T19:50:00.000Z',
      updated: '2026-03-27T20:20:00.000Z',
      description: 'Make demo mode work without a backend service.',
      parent: 'APP-100',
      comments: []
    },
    {
      id: 'demo-4',
      key: 'APP-103',
      summary: 'Simulate workflow validation edge case',
      status: 'Blocked',
      issueType: 'Bug',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeKind: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'Low',
      created: '2026-03-27T20:05:00.000Z',
      updated: '2026-03-27T20:30:00.000Z',
      description: 'This demo issue rejects one transition to mimic workflow restrictions.',
      parent: 'APP-100',
      comments: [],
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
      created: '2026-03-27T20:45:00.000Z',
      updated: '2026-03-27T21:00:00.000Z',
      description: 'Investigate the latest customer-facing incident.',
      comments: []
    }
  ];
}

/** Demo workflow columns — shown even when no issues are in a status. */
const DEMO_BOARD_STATUS_ORDER = ['Backlog', 'To Do', 'In Progress', 'Blocked', 'Done'] as const;
const DEMO_CURRENT_USER = 'Alex Agent';

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

function toIssueSummary(issue: DemoIssue, issuesByKey?: Map<string, DemoIssue>): IssueSummary {
  const parent = issue.parent && issuesByKey?.get(issue.parent);
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: statusCategoryName(issue.status),
    issueType: issue.issueType,
    projectKey: issue.projectKey,
    projectName: issue.projectName,
    parentKey: issue.parent,
    parentIssue: parent ? toParentIssueReference(parent) : undefined,
    assignee: issue.assigneeKind === 'none' ? undefined : issue.assigneeDisplayName,
    priority: issue.priority,
    created: issue.created,
    updated: issue.updated,
    browseUrl: `https://example.com/ticket-manager-demo/${issue.key}`,
    description: issue.description,
    raw: issue
  };
}

function toParentIssueReference(issue: DemoIssue | undefined): ParentIssueReference | undefined {
  if (!issue) {
    return undefined;
  }

  return {
    key: issue.key,
    summary: issue.summary,
    issueType: issue.issueType,
    description: issue.description
  };
}

function toIssueComments(issue: DemoIssue): IssueComment[] {
  return [...issue.comments].sort((left, right) => right.created.localeCompare(left.created));
}

function toIssueDetails(issue: DemoIssue, parentIssue?: DemoIssue): IssueDetails {
  return {
    ...toIssueSummary(issue),
    parentIssue: toParentIssueReference(parentIssue),
    transitions: transitionSet(issue.status),
    comments: toIssueComments(issue)
  };
}

function toBoard(board: DemoBoard): Board {
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

function sortIssuesByUpdated(issues: IssueSummary[]): IssueSummary[] {
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
    case 'backlog':
      return 0;
    case 'to do':
      return 1;
    case 'selected for development':
      return 2;
    case 'in progress':
      return 3;
    case 'blocked':
      return 4;
    case 'done':
      return 5;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function buildBoardColumns(issues: IssueSummary[]): BoardColumn[] {
  const issuesByStatus = new Map<string, IssueSummary[]>();
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

  public constructor(private readonly configStore: { getDefaultPageSize(): number }) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.issues = createSeedIssues();
    this.boards = createSeedBoards();
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    const projects = await this.getProjects();
    return {
      status: 'ok',
      message: `Demo mode active. ${projects.length} demo project(s) loaded.`,
      toolCount: 0,
      projectCount: projects.length,
      serverName: 'demo-mode'
    };
  }

  public async getProjects(): Promise<Project[]> {
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

  public async getIssues(filters: IssueFilters, startAt: number, pageSize: number): Promise<PagedIssues> {
    const issuesByKey = new Map(this.issues.map(item => [item.key, item]));
    const matchingIssues = sortIssuesByUpdated(
      this.issues
        .filter(issue => this.matchesIssueFilters(issue, filters))
        .map(issue => toIssueSummary(issue, issuesByKey))
    );
    const pagedIssues = matchingIssues.slice(startAt, startAt + pageSize);

    return {
      issues: pagedIssues,
      total: matchingIssues.length,
      hasMore: startAt + pageSize < matchingIssues.length
    };
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    const metadataFilters: IssueFilters = {
      ...filters,
      statuses: [],
      issueTypes: []
    };
    const page = await this.getIssues(metadataFilters, 0, 200);

    return {
      statuses: uniqueSorted([...DEMO_BOARD_STATUS_ORDER, ...page.issues.map(issue => issue.status)]),
      issueTypes: uniqueSorted(page.issues.map(issue => issue.issueType))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    const allowedParentTypes = options?.childIssueType
      ? getParentRule(options.childIssueType, this.mode).allowedParentTypes
      : ['Feature', 'Epic'];
    if (allowedParentTypes.length === 0) {
      return [];
    }

    const query = searchText?.trim().toLowerCase();
    const issuesByKey = new Map(this.issues.map(item => [item.key, item]));
    return sortIssuesByUpdated(
      this.issues
        .filter(issue =>
          allowedParentTypes.some(parentType => parentType.toLowerCase() === issue.issueType.toLowerCase())
        )
        .filter(issue => filters.projectKeys.length === 0 || filters.projectKeys.includes(issue.projectKey))
        .filter(issue => filters.statuses.length === 0 || filters.statuses.includes(issue.status))
        .filter(issue => {
          if (!query) {
            return true;
          }
          const haystack = `${issue.key} ${issue.summary} ${issue.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .map(issue => toIssueSummary(issue, issuesByKey))
    );
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
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

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const matchingBoard = this.boards.find(candidate => candidate.id === board.id);
    if (!matchingBoard) {
      throw new Error(`Demo board ${board.name} was not found.`);
    }

    const issuesByKey = new Map(this.issues.map(item => [item.key, item]));
    const issues = sortIssuesByUpdated(
      this.issues
        .filter(issue => matchingBoard.issueKeys.includes(issue.key))
        .map(issue => toIssueSummary(issue, issuesByKey))
    );

    return {
      board: toBoard(matchingBoard),
      issues,
      columns: buildBoardColumns(issues),
      columnStatusOrder: [...DEMO_BOARD_STATUS_ORDER]
    };
  }

  public async createBoard(input: CreateBoardInput): Promise<Board> {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Board name cannot be empty.');
    }

    const project = (await this.getProjects()).find(candidate => candidate.key === input.projectKey);
    if (!project) {
      throw new Error(`Project ${input.projectKey} is not available in demo mode.`);
    }

    const board: DemoBoard = {
      id: `demo-board-${this.boards.length + 1}-${Date.now()}`,
      name,
      type: 'scrum',
      projectKey: project.key,
      projectName: project.name,
      locationName: project.name,
      issueKeys: []
    };

    this.boards.push(board);
    return toBoard(board);
  }

  public async updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board> {
    const board = this.boards.find(candidate => candidate.id === boardId);
    if (!board) {
      throw new Error(`Demo board ${boardId} was not found.`);
    }

    if (typeof input.name === 'string') {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new Error('Board name cannot be empty.');
      }
      board.name = name;
    }

    return toBoard(board);
  }

  public async deleteBoard(boardId: string): Promise<void> {
    const boardIndex = this.boards.findIndex(candidate => candidate.id === boardId);
    if (boardIndex < 0) {
      throw new Error(`Demo board ${boardId} was not found.`);
    }

    this.boards.splice(boardIndex, 1);
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const issue = this.findIssue(issueKey);
    const parentIssue = issue.parent
      ? this.issues.find(candidate => candidate.key === issue.parent)
      : undefined;
    return toIssueDetails(issue, parentIssue);
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const project = (await this.getProjects()).find(candidate => candidate.key === input.projectKey);
    if (!project) {
      throw new Error(`Project ${input.projectKey} is not available in demo mode.`);
    }

    const parentKey = input.parentKey?.trim() || undefined;
    this.validateParentSelection(project.key, input.issueType, parentKey);

    const now = new Date().toISOString();
    const createdIssue: DemoIssue = {
      id: `demo-${this.issues.length + 1}`,
      key: this.getNextIssueKey(input.projectKey),
      summary: input.summary.trim(),
      status: DEMO_BOARD_STATUS_ORDER[0],
      issueType: input.issueType.trim(),
      projectKey: project.key,
      projectName: project.name,
      assigneeKind: 'me',
      assigneeDisplayName: DEMO_CURRENT_USER,
      priority: 'Medium',
      created: now,
      updated: now,
      description: input.description?.trim() ?? '',
      parent: parentKey,
      comments: []
    };

    this.issues.unshift(createdIssue);
    this.attachIssueToBoard(createdIssue.key, createdIssue.projectKey, input.boardId);

    const parentIssue = createdIssue.parent
      ? this.issues.find(candidate => candidate.key === createdIssue.parent)
      : undefined;
    return toIssueDetails(createdIssue, parentIssue);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const issue = this.findIssue(issueKey);
    const nextIssueType =
      typeof input.issueType === 'string' && input.issueType.trim().length > 0
        ? input.issueType.trim()
        : issue.issueType;
    const nextParentKey = Object.prototype.hasOwnProperty.call(input, 'parentKey')
      ? input.parentKey?.trim() || undefined
      : issue.parent;
    this.validateParentSelection(issue.projectKey, nextIssueType, nextParentKey, issue.key);

    if (typeof input.summary === 'string') {
      const summary = input.summary.trim();
      if (summary.length === 0) {
        throw new Error('Summary cannot be empty.');
      }
      issue.summary = summary;
    }
    if (typeof input.description === 'string') {
      issue.description = input.description;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'parentKey')) {
      issue.parent = nextParentKey;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      const assignee = input.assignee?.trim();
      if (assignee) {
        issue.assigneeKind = assignee === DEMO_CURRENT_USER ? 'me' : 'other';
        issue.assigneeDisplayName = assignee;
      } else {
        issue.assigneeKind = 'none';
        issue.assigneeDisplayName = undefined;
      }
    }
    if (typeof input.priority === 'string') {
      const priority = input.priority.trim();
      if (priority.length === 0) {
        throw new Error('Priority cannot be empty.');
      }
      issue.priority = priority;
    }
    if (typeof input.issueType === 'string') {
      const issueType = input.issueType.trim();
      if (issueType.length === 0) {
        throw new Error('Issue type cannot be empty.');
      }
      issue.issueType = issueType;
    }
    issue.updated = new Date().toISOString();

    const parentIssue = issue.parent
      ? this.issues.find(candidate => candidate.key === issue.parent)
      : undefined;
    return toIssueDetails(issue, parentIssue);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    const issueIndex = this.issues.findIndex(candidate => candidate.key === issueKey);
    if (issueIndex < 0) {
      throw new Error(`Issue ${issueKey} was not found in demo mode.`);
    }

    this.issues.splice(issueIndex, 1);
    for (const issue of this.issues) {
      if (issue.parent === issueKey) {
        issue.parent = undefined;
        issue.updated = new Date().toISOString();
      }
    }
    for (const board of this.boards) {
      board.issueKeys = board.issueKeys.filter(key => key !== issueKey);
    }
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const issue = this.findIssue(issueKey);
    const commentBody = body.trim();
    if (commentBody.length === 0) {
      throw new Error('Comment cannot be empty.');
    }

    const now = new Date().toISOString();
    issue.comments.unshift({
      id: `demo-comment-${issue.key}-${issue.comments.length + 1}`,
      author: DEMO_CURRENT_USER,
      body: commentBody,
      created: now,
      updated: now
    });
    issue.updated = now;
  }

  public async attachFile(_issueKey: string, _filePath: string, _fileName?: string): Promise<void> {
    throw new Error('Attachments are not supported in Demo mode.');
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error('Attachment downloads are not supported in Demo mode.');
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
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

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return DEMO_CURRENT_USER;
  }

  public dispose(): void {}

  private matchesIssueFilters(issue: DemoIssue, filters: IssueFilters): boolean {
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

    if (filters.parentKey && issue.parent !== filters.parentKey) {
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

  private validateParentSelection(
    projectKey: string,
    issueType: string,
    parentKey: string | undefined,
    currentIssueKey?: string
  ): void {
    const rule = getParentRule(issueType, this.mode);
    const issueLabel = normalizeIssueTypeLabel(issueType);
    if (!rule.canHaveParent) {
      if (parentKey) {
        throw new Error(`${issueLabel} items cannot have a parent.`);
      }
      return;
    }

    if (!parentKey) {
      if (rule.requiresParent) {
        throw new Error(`${rule.defaultLabel} is required for ${issueLabel} items.`);
      }
      return;
    }

    if (parentKey === currentIssueKey) {
      throw new Error('An item cannot be its own parent.');
    }

    const parentIssue = this.findIssue(parentKey);
    if (parentIssue.projectKey !== projectKey) {
      throw new Error(`${rule.defaultLabel} ${parentKey} must be in the same project.`);
    }
    if (!isAllowedParentType(parentIssue.issueType, issueType, this.mode)) {
      throw new Error(buildParentValidationMessage(issueType, this.mode, parentIssue.issueType));
    }
  }

  private getNextIssueKey(projectKey: string): string {
    const nextNumber =
      this.issues
        .map(issue => {
          const match = issue.key.match(new RegExp(`^${projectKey}-(\\d+)$`));
          const numericPart = match?.[1];
          return numericPart ? Number.parseInt(numericPart, 10) : undefined;
        })
        .reduce<number>(
          (max, value) => (typeof value === 'number' && value > max ? value : max),
          0
        ) + 1;

    return `${projectKey}-${nextNumber}`;
  }

  private attachIssueToBoard(issueKey: string, projectKey: string, preferredBoardId?: string): void {
    const preferredBoard = preferredBoardId
      ? this.boards.find(board => board.id === preferredBoardId)
      : undefined;
    if (preferredBoard) {
      preferredBoard.issueKeys.push(issueKey);
      return;
    }

    const targetBoard =
      this.boards.find(
        board =>
          board.projectKey === projectKey && !board.name.toLowerCase().includes('overview')
      ) ?? this.boards.find(board => board.projectKey === projectKey);
    if (targetBoard) {
      targetBoard.issueKeys.push(issueKey);
    }
  }
}
