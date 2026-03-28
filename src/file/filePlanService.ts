import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import type {
  BackendMode,
  Board,
  BoardColumn,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateIssueInput,
  FilterMetadata,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  Project,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';

interface PlanStatus {
  name: string;
  category?: string;
}

interface PlanTransition {
  id: string;
  name: string;
  toStatus: string;
}

interface PlanBoardDefinition {
  id: string;
  name: string;
  type?: string;
  projectKey?: string;
  projectName?: string;
  locationName?: string;
  issueKeys?: string[];
  columnStatusOrder?: string[];
}

interface PlanItemDefinition {
  id?: string;
  key: string;
  summary: string;
  status: string;
  type?: string;
  issueType?: string;
  projectKey: string;
  projectName?: string;
  assignee?: string;
  priority?: string;
  updated?: string;
  description?: string;
  parent?: string;
  browseUrl?: string;
}

interface PlanWorkflowDefinition {
  statuses?: PlanStatus[];
  transitions?: Record<string, PlanTransition[]>;
}

interface PlanDocument {
  version?: number;
  currentUser?: string;
  projects?: Project[];
  boards?: PlanBoardDefinition[];
  workflow?: PlanWorkflowDefinition;
  items?: PlanItemDefinition[];
}

interface LoadedPlan {
  uri: vscode.Uri;
  text: string;
  document: PlanDocument;
  items: IssueSummary[];
  boards: PlanBoardDefinition[];
  projects: Project[];
  currentUser?: string;
  statusCategoryByName: Map<string, string | undefined>;
  defaultStatusOrder: string[];
}

const DEFAULT_STATUSES: PlanStatus[] = [
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'Blocked', category: 'indeterminate' },
  { name: 'Done', category: 'done' }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function statusCategoryName(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'done' || normalized === 'closed' || normalized === 'complete') {
    return 'done';
  }
  if (normalized.includes('progress') || normalized === 'blocked') {
    return 'indeterminate';
  }
  return 'todo';
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
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

function normalizePlanStatus(raw: unknown): PlanStatus | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const name = asString(raw.name);
  if (!name) {
    return undefined;
  }

  return {
    name,
    category: asString(raw.category)
  };
}

function normalizePlanTransition(raw: unknown): PlanTransition | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = asString(raw.id);
  const name = asString(raw.name);
  const toStatus = asString(raw.toStatus);
  if (!id || !name || !toStatus) {
    return undefined;
  }

  return { id, name, toStatus };
}

function normalizePlanBoard(raw: unknown): PlanBoardDefinition | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    type: asString(raw.type),
    projectKey: asString(raw.projectKey),
    projectName: asString(raw.projectName),
    locationName: asString(raw.locationName),
    issueKeys: asStringArray(raw.issueKeys),
    columnStatusOrder: asStringArray(raw.columnStatusOrder)
  };
}

function normalizePlanItem(
  raw: unknown,
  statusCategoryByName: Map<string, string | undefined>
): IssueSummary | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const key = asString(raw.key);
  const summary = asString(raw.summary);
  const status = asString(raw.status);
  const projectKey = asString(raw.projectKey);
  if (!key || !summary || !status || !projectKey) {
    return undefined;
  }

  const statusCategory = statusCategoryByName.get(status) ?? statusCategoryName(status);
  return {
    id: asString(raw.id),
    key,
    summary,
    status,
    statusCategory,
    issueType: asString(raw.type) ?? asString(raw.issueType) ?? 'Issue',
    projectKey,
    projectName: asString(raw.projectName),
    parentKey: asString(raw.parent),
    assignee: asString(raw.assignee),
    priority: asString(raw.priority),
    updated: asString(raw.updated),
    browseUrl: asString(raw.browseUrl),
    description: asString(raw.description),
    raw
  };
}

function normalizeProjects(rawProjects: unknown, items: IssueSummary[]): Project[] {
  const projects: Project[] = Array.isArray(rawProjects)
    ? rawProjects.flatMap(project => {
        if (!isRecord(project)) {
          return [];
        }

        const key = asString(project.key);
        const name = asString(project.name);
        if (!key || !name) {
          return [];
        }

        return [
          {
            id: asString(project.id),
            key,
            name
          }
        ];
      })
    : [];

  if (projects.length > 0) {
    return projects;
  }

  return uniqueSorted(items.map(item => item.projectKey)).map(projectKey => {
    const sample = items.find(item => item.projectKey === projectKey);
    return {
      key: projectKey,
      name: sample?.projectName ?? projectKey
    };
  });
}

function collectDefaultStatusOrder(document: PlanDocument, items: IssueSummary[]): string[] {
  const explicit = (document.workflow?.statuses ?? [])
    .map(status => normalizePlanStatus(status))
    .filter((status): status is PlanStatus => Boolean(status))
    .map(status => status.name);
  if (explicit.length > 0) {
    return explicit;
  }

  const fromItems = items.map(item => item.status);
  return uniqueSorted([...DEFAULT_STATUSES.map(status => status.name), ...fromItems]);
}

function toBoard(summary: PlanBoardDefinition): Board {
  return {
    id: summary.id,
    name: summary.name,
    type: summary.type ?? 'plan',
    projectKey: summary.projectKey,
    projectName: summary.projectName,
    locationName: summary.locationName,
    raw: summary
  };
}

function buildSyntheticBoards(projects: Project[], items: IssueSummary[], statusOrder: string[]): PlanBoardDefinition[] {
  return projects.map(project => ({
    id: `project:${project.key}`,
    name: `${project.name} Board`,
    type: 'plan',
    projectKey: project.key,
    projectName: project.name,
    locationName: 'Workspace Plan',
    issueKeys: items.filter(item => item.projectKey === project.key).map(item => item.key),
    columnStatusOrder: [...statusOrder]
  }));
}

export class FilePlanService implements IssueTrackerService {
  public readonly mode: BackendMode = 'file';

  public constructor(private readonly configStore: AppConfigStore) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {}

  public async checkConnection(): Promise<ConnectionCheck> {
    try {
      const plan = await this.loadPlan();
      return {
        status: plan.items.length === 0 ? 'warning' : 'ok',
        message:
          plan.items.length === 0
            ? `File mode active, but ${path.basename(plan.uri.fsPath)} contains no items.`
            : `File mode active. Loaded ${plan.items.length} item(s) from ${path.basename(plan.uri.fsPath)}.`,
        toolCount: 0,
        projectCount: plan.projects.length,
        serverName: plan.uri.fsPath
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        toolCount: 0
      };
    }
  }

  public async getProjects(): Promise<Project[]> {
    return (await this.loadPlan()).projects;
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    const plan = await this.loadPlan();
    const matchingIssues = sortIssuesByUpdated(
      plan.items.filter(issue => this.matchesIssueFilters(plan, issue, filters))
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
    const page = await this.getIssues(metadataFilters, 0, 500);
    return {
      statuses: uniqueSorted(page.issues.map(issue => issue.status)),
      issueTypes: uniqueSorted(page.issues.map(issue => issue.issueType))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string
  ): Promise<IssueSummary[]> {
    const plan = await this.loadPlan();
    const parentKeys = new Set(
      plan.document.items
        ?.map(item => (isRecord(item) ? asString(item.parent) : undefined))
        .filter((value): value is string => Boolean(value)) ?? []
    );
    const query = searchText?.trim().toLowerCase();

    return sortIssuesByUpdated(
      plan.items
        .filter(item => parentKeys.has(item.key) || item.issueType === 'Feature' || item.issueType === 'Epic')
        .filter(item => filters.projectKeys.length === 0 || filters.projectKeys.includes(item.projectKey))
        .filter(item => {
          if (!query) {
            return true;
          }

          const haystack = `${item.key} ${item.summary} ${item.description ?? ''}`.toLowerCase();
          return haystack.includes(query);
        })
    );
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const plan = await this.loadPlan();
    const query = filters.searchText.trim().toLowerCase();
    const boards = (plan.boards.length > 0
      ? plan.boards
      : buildSyntheticBoards(plan.projects, plan.items, plan.defaultStatusOrder)
    )
      .filter(board => filters.projectKeys.length === 0 || !board.projectKey || filters.projectKeys.includes(board.projectKey))
      .filter(board => filters.types.length === 0 || filters.types.includes(board.type ?? 'plan'))
      .filter(board => {
        if (!query) {
          return true;
        }

        const haystack =
          `${board.name} ${board.projectKey ?? ''} ${board.projectName ?? ''} ${board.locationName ?? ''}`.toLowerCase();
        return haystack.includes(query);
      })
      .map(toBoard)
      .sort((left, right) => left.name.localeCompare(right.name));

    return boards;
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const plan = await this.loadPlan();
    const boardDefinition =
      (plan.boards.length > 0 ? plan.boards : buildSyntheticBoards(plan.projects, plan.items, plan.defaultStatusOrder))
        .find(candidate => candidate.id === board.id);
    if (!boardDefinition) {
      throw new Error(`Board ${board.name} was not found in the plan file.`);
    }

    const issues = sortIssuesByUpdated(
      plan.items.filter(issue => {
        if (boardDefinition.issueKeys && boardDefinition.issueKeys.length > 0) {
          return boardDefinition.issueKeys.includes(issue.key);
        }

        if (boardDefinition.projectKey) {
          return issue.projectKey === boardDefinition.projectKey;
        }

        return true;
      })
    );

    return {
      board: toBoard(boardDefinition),
      issues,
      columns: buildBoardColumns(issues),
      columnStatusOrder:
        boardDefinition.columnStatusOrder && boardDefinition.columnStatusOrder.length > 0
          ? [...boardDefinition.columnStatusOrder]
          : [...plan.defaultStatusOrder]
    };
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const plan = await this.loadPlan();
    const issue = plan.items.find(candidate => candidate.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} was not found in the plan file.`);
    }

    return {
      ...issue,
      transitions: this.getTransitionsForIssue(plan, issue)
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const plan = await this.loadPlan();
    const project = plan.projects.find(candidate => candidate.key === input.projectKey);
    if (!project) {
      throw new Error(`Project ${input.projectKey} was not found in the plan file.`);
    }

    const now = new Date().toISOString();
    const nextKey = this.getNextIssueKey(plan, input.projectKey);
    const nextStatus = plan.defaultStatusOrder[0] ?? DEFAULT_STATUSES[0].name;
    const nextItem: PlanItemDefinition = {
      key: nextKey,
      summary: input.summary.trim(),
      status: nextStatus,
      type: input.issueType.trim(),
      projectKey: project.key,
      projectName: project.name,
      assignee: plan.currentUser,
      priority: 'Medium',
      updated: now,
      description: input.description?.trim() || undefined,
      parent: input.parentKey?.trim() || undefined
    };

    const formattingOptions = { insertSpaces: true, tabSize: 2 };
    let nextText = plan.text;
    if (Array.isArray(plan.document.items)) {
      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', plan.document.items.length], nextItem, {
          formattingOptions,
          isArrayInsertion: true
        })
      );
    } else {
      nextText = applyEdits(nextText, modify(nextText, ['items'], [nextItem], { formattingOptions }));
    }

    const targetBoardId = this.resolveTargetBoardId(plan, project.key, input.boardId);
    if (targetBoardId) {
      const rawBoards = Array.isArray(plan.document.boards) ? plan.document.boards : [];
      const boardIndex = rawBoards.findIndex(
        board => isRecord(board) && asString(board.id) === targetBoardId
      );
      if (boardIndex >= 0) {
        const rawBoard = rawBoards[boardIndex];
        const nextIssueKeys = isRecord(rawBoard) ? asStringArray(rawBoard.issueKeys) : [];
        nextText = applyEdits(
          nextText,
          modify(nextText, ['boards', boardIndex, 'issueKeys'], [...nextIssueKeys, nextKey], {
            formattingOptions
          })
        );
      }
    }

    await vscode.workspace.fs.writeFile(plan.uri, Buffer.from(nextText, 'utf8'));

    return {
      key: nextKey,
      summary: nextItem.summary,
      status: nextStatus,
      statusCategory: plan.statusCategoryByName.get(nextStatus) ?? statusCategoryName(nextStatus),
      issueType: nextItem.type ?? 'Issue',
      projectKey: project.key,
      projectName: project.name,
      parentKey: nextItem.parent,
      assignee: nextItem.assignee,
      priority: nextItem.priority,
      updated: now,
      description: nextItem.description,
      raw: nextItem,
      transitions: this.getTransitionsForIssue(plan, {
        key: nextKey,
        summary: nextItem.summary,
        status: nextStatus,
        statusCategory: plan.statusCategoryByName.get(nextStatus) ?? statusCategoryName(nextStatus),
        issueType: nextItem.type ?? 'Issue',
        projectKey: project.key,
        projectName: project.name,
        parentKey: nextItem.parent,
        assignee: nextItem.assignee,
        priority: nextItem.priority,
        updated: now,
        description: nextItem.description,
        raw: nextItem
      })
    };
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const plan = await this.loadPlan();
    const rawItems = Array.isArray(plan.document.items) ? plan.document.items : [];
    const itemIndex = rawItems.findIndex(item => isRecord(item) && asString(item.key) === issueKey);
    if (itemIndex < 0) {
      throw new Error(`Issue ${issueKey} was not found in the plan file.`);
    }

    const formattingOptions = { insertSpaces: true, tabSize: 2 };
    let nextText = plan.text;
    if (typeof input.summary === 'string') {
      const summary = input.summary.trim();
      if (summary.length === 0) {
        throw new Error('Summary cannot be empty.');
      }
      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', itemIndex, 'summary'], summary, { formattingOptions })
      );
    }
    if (typeof input.description === 'string') {
      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', itemIndex, 'description'], input.description.trim() || undefined, {
          formattingOptions
        })
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, 'parentKey')) {
      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', itemIndex, 'parent'], input.parentKey?.trim() || undefined, {
          formattingOptions
        })
      );
    }
    nextText = applyEdits(
      nextText,
      modify(nextText, ['items', itemIndex, 'updated'], new Date().toISOString(), {
        formattingOptions
      })
    );

    await vscode.workspace.fs.writeFile(plan.uri, Buffer.from(nextText, 'utf8'));
    return this.getIssue(issueKey);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    const plan = await this.loadPlan();
    const rawItems = Array.isArray(plan.document.items) ? plan.document.items : [];
    const itemIndex = rawItems.findIndex(item => isRecord(item) && asString(item.key) === issueKey);
    if (itemIndex < 0) {
      throw new Error(`Issue ${issueKey} was not found in the plan file.`);
    }

    const formattingOptions = { insertSpaces: true, tabSize: 2 };
    let nextText = plan.text;

    for (let index = 0; index < rawItems.length; index += 1) {
      const item = rawItems[index];
      if (!isRecord(item) || asString(item.parent) !== issueKey) {
        continue;
      }

      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', index, 'parent'], undefined, { formattingOptions })
      );
      nextText = applyEdits(
        nextText,
        modify(nextText, ['items', index, 'updated'], new Date().toISOString(), { formattingOptions })
      );
    }

    const rawBoards = Array.isArray(plan.document.boards) ? plan.document.boards : [];
    for (let index = 0; index < rawBoards.length; index += 1) {
      const board = rawBoards[index];
      if (!isRecord(board)) {
        continue;
      }

      const nextIssueKeys = asStringArray(board.issueKeys).filter(key => key !== issueKey);
      nextText = applyEdits(
        nextText,
        modify(nextText, ['boards', index, 'issueKeys'], nextIssueKeys, { formattingOptions })
      );
    }

    nextText = applyEdits(
      nextText,
      modify(nextText, ['items', itemIndex], undefined, { formattingOptions })
    );

    await vscode.workspace.fs.writeFile(plan.uri, Buffer.from(nextText, 'utf8'));
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    const plan = await this.loadPlan();
    const issue = plan.items.find(candidate => candidate.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} was not found in the plan file.`);
    }

    return this.getTransitionsForIssue(plan, issue);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const plan = await this.loadPlan();
    const transitions = await this.getTransitions(issueKey);
    const transition = transitions.find(candidate => candidate.id === transitionId);
    if (!transition) {
      throw new Error(`Transition ${transitionId} is not valid for ${issueKey}.`);
    }

    const rawItems = Array.isArray(plan.document.items) ? plan.document.items : [];
    const itemIndex = rawItems.findIndex(item => isRecord(item) && asString(item.key) === issueKey);
    if (itemIndex < 0) {
      throw new Error(`Issue ${issueKey} was not found in the plan file.`);
    }

    const formattingOptions = { insertSpaces: true, tabSize: 2 };
    let nextText = applyEdits(
      plan.text,
      modify(plan.text, ['items', itemIndex, 'status'], transition.toStatus, {
        formattingOptions
      })
    );

    nextText = applyEdits(
      nextText,
      modify(nextText, ['items', itemIndex, 'updated'], new Date().toISOString(), {
        formattingOptions
      })
    );

    await vscode.workspace.fs.writeFile(plan.uri, Buffer.from(nextText, 'utf8'));
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl;
  }

  public dispose(): void {}

  private async loadPlan(): Promise<LoadedPlan> {
    const uri = await this.resolvePlanUri();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      throw new Error(`Unable to read the plan file at ${uri.fsPath}: ${(error as Error).message}`);
    }

    const text = Buffer.from(bytes).toString('utf8');
    const parsed = parseJsonc(text);
    if (!isRecord(parsed)) {
      throw new Error(`The plan file at ${uri.fsPath} must contain a JSON object.`);
    }

    const document = parsed as PlanDocument;
    const workflowStatuses = (document.workflow?.statuses ?? [])
      .map(status => normalizePlanStatus(status))
      .filter((status): status is PlanStatus => Boolean(status));
    const statusCategoryByName = new Map<string, string | undefined>();
    for (const status of workflowStatuses) {
      statusCategoryByName.set(status.name, status.category ?? statusCategoryName(status.name));
    }

    for (const status of DEFAULT_STATUSES) {
      if (!statusCategoryByName.has(status.name)) {
        statusCategoryByName.set(status.name, status.category);
      }
    }

    const items = (Array.isArray(document.items) ? document.items : [])
      .map(item => normalizePlanItem(item, statusCategoryByName))
      .filter((item): item is IssueSummary => Boolean(item));

    for (const item of items) {
      if (!statusCategoryByName.has(item.status)) {
        statusCategoryByName.set(item.status, item.statusCategory ?? statusCategoryName(item.status));
      }
    }

    const boards = (Array.isArray(document.boards) ? document.boards : [])
      .map(board => normalizePlanBoard(board))
      .filter((board): board is PlanBoardDefinition => Boolean(board));

    return {
      uri,
      text,
      document,
      items,
      boards,
      projects: normalizeProjects(document.projects, items),
      currentUser: asString(document.currentUser),
      statusCategoryByName,
      defaultStatusOrder: collectDefaultStatusOrder(document, items)
    };
  }

  private async resolvePlanUri(): Promise<vscode.Uri> {
    const configured = await this.configStore.getResolvedPlanFileUri();
    if (configured) {
      return configured;
    }

    const candidates = await this.configStore.findWorkspacePlanCandidates();
    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      throw new Error('Multiple workspace plan files were found. Choose the plan file to use.');
    }

    throw new Error('No plan file is configured. Choose or create a plan file for File mode.');
  }

  private getTransitionsForIssue(plan: LoadedPlan, issue: IssueSummary): WorkflowTransition[] {
    const workflowTransitions = isRecord(plan.document.workflow?.transitions)
      ? plan.document.workflow?.transitions
      : undefined;
    const explicitTransitions = workflowTransitions?.[issue.status];
    const normalizedExplicit = Array.isArray(explicitTransitions)
      ? explicitTransitions
          .map(transition => normalizePlanTransition(transition))
          .filter((transition): transition is PlanTransition => Boolean(transition))
      : [];

    if (normalizedExplicit.length > 0) {
      return normalizedExplicit;
    }

    const statuses = plan.defaultStatusOrder.length > 0
      ? plan.defaultStatusOrder
      : uniqueSorted(plan.items.map(item => item.status));

    return statuses
      .filter(status => status !== issue.status)
      .map(status => ({
        id: `set-status:${issue.status}->${status}`,
        name: `Move to ${status}`,
        toStatus: status
      }));
  }

  private getNextIssueKey(plan: LoadedPlan, projectKey: string): string {
    const nextNumber =
      plan.items
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

  private resolveTargetBoardId(
    plan: LoadedPlan,
    projectKey: string,
    preferredBoardId?: string
  ): string | undefined {
    if (preferredBoardId && plan.boards.some(board => board.id === preferredBoardId)) {
      return preferredBoardId;
    }

    return plan.boards.find(board => board.projectKey === projectKey)?.id;
  }

  private matchesIssueFilters(
    plan: LoadedPlan,
    issue: IssueSummary,
    filters: IssueFilters
  ): boolean {
    if (filters.projectKeys.length > 0 && !filters.projectKeys.includes(issue.projectKey)) {
      return false;
    }

    if (
      filters.assigneeMode === 'me' &&
      plan.currentUser &&
      issue.assignee &&
      issue.assignee !== plan.currentUser
    ) {
      return false;
    }

    if (filters.statuses.length > 0 && !filters.statuses.includes(issue.status)) {
      return false;
    }

    if (filters.issueTypes.length > 0 && !filters.issueTypes.includes(issue.issueType)) {
      return false;
    }

    if (filters.parentKey && issue.parentKey !== filters.parentKey) {
      return false;
    }

    if (filters.searchText.trim().length === 0) {
      return true;
    }

    const haystack = `${issue.key} ${issue.summary} ${issue.description ?? ''}`.toLowerCase();
    return haystack.includes(filters.searchText.trim().toLowerCase());
  }
}
