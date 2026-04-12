import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import {
  buildParentValidationMessage,
  getParentRule,
  isAllowedParentType
} from '../issues/issueHierarchy';
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
  IssueDetails,
  IssueFilters,
  ParentIssueReference,
  IssueSummary,
  PagedIssues,
  ParentItemQueryOptions,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import {
  type ParsedChildFile,
  type ParsedFeatureFolder,
  type ParsedPlanFolder,
  parsePlanFolder,
  stableChildKey,
  stableFeatureKey,
  stableStoryKey
} from './markdownPlanParser';
import {
  appendFeatureItemTableRow,
  computeFeatureRollupStatus,
  updateFeatureStoryTable,
  writeStatusToMarkdownFile
} from './markdownStatusWriter';

// ── Workflow ────────────────────────────────────────────────────────

const STATUSES = [
  { name: 'Backlog', category: 'todo' },
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'Blocked', category: 'indeterminate' },
  { name: 'Done', category: 'done' }
];

const STATUS_NAMES = STATUSES.map(s => s.name);
const LIVE_FOLDER_CREATION_DISABLED_ERROR =
  'Live Folder issue creation is disabled. Enable ticketManager.liveFolderAllowIssueCreation to create markdown issues.';

type CreatableLiveFolderIssueType = 'Feature' | 'Story' | 'Task' | 'Bug';

const CHILD_FILE_PREFIX_BY_TYPE: Record<Exclude<CreatableLiveFolderIssueType, 'Feature'>, string> = {
  Story: 'story',
  Task: 'task',
  Bug: 'bug'
};

function categoryForStatus(name: string): string {
  return STATUSES.find(s => s.name === name)?.category ?? 'todo';
}

function transitionsFrom(currentStatus: string): WorkflowTransition[] {
  return STATUS_NAMES.filter(s => s !== currentStatus).map((s, i) => ({
    id: `lf-${i}-${s.replace(/\s/g, '-').toLowerCase()}`,
    name: `Move to ${s}`,
    toStatus: s
  }));
}

function normalizeLiveFolderIssueType(value: string): CreatableLiveFolderIssueType | undefined {
  switch (value.trim().toLowerCase()) {
    case 'epic':
    case 'feature':
      return 'Feature';
    case 'story':
      return 'Story';
    case 'task':
      return 'Task';
    case 'bug':
      return 'Bug';
    default:
      return undefined;
  }
}

function padFeatureId(featureId: number): string {
  return String(featureId).padStart(2, '0');
}

function slugifyPathSegment(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}

function buildFeatureDirectoryName(featureId: number, summary: string): string {
  return `feature-${padFeatureId(featureId)}-${slugifyPathSegment(summary)}`;
}

function buildChildFileName(
  issueType: Exclude<CreatableLiveFolderIssueType, 'Feature'>,
  featureId: number,
  childSeq: number,
  summary: string
): string {
  return `${CHILD_FILE_PREFIX_BY_TYPE[issueType]}-${padFeatureId(featureId)}-${childSeq}-${slugifyPathSegment(summary)}.md`;
}

function buildDefaultDescription(issueType: CreatableLiveFolderIssueType): string {
  return `Add details for this ${issueType.toLowerCase()}.`;
}

function buildIssueMarkdown(
  issueType: CreatableLiveFolderIssueType,
  title: string,
  description: string | undefined,
  createdAtIso: string,
  parentKey?: string
): string {
  const lines = [
    `# ${title}`,
    '',
    '**Status:** 📋 Proposed',
    `**Created:** ${createdAtIso}`,
    `**Type:** ${issueType}`
  ];
  if (parentKey) {
    lines.push(`**Parent:** ${parentKey}`);
  }
  lines.push(
    '',
    '## Summary',
    description?.trim() || buildDefaultDescription(issueType),
    ''
  );
  if (issueType === 'Feature') {
    lines.push(
      '## Items',
      '',
      '| Ref | Type | Name | Status |',
      '| --- | --- | --- | --- |',
      ''
    );
  } else {
    lines.push('## Dependencies', '', '');
  }
  return lines.join('\n');
}

function toParentIssueReference(issue: LiveIssue | undefined): ParentIssueReference | undefined {
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

// ── Internal model ──────────────────────────────────────────────────

interface LiveIssue extends IssueSummary {
  sourceUri: vscode.Uri;
  featureId: number;
  childSeq?: number;
  featureDirName?: string;
}

export interface LiveFolderConfigProvider {
  getDefaultPageSize(): number;
  getLiveFolderPath(): string;
  getLiveFolderProjectKey(): string;
  getLiveFolderProjectName(): string;
  getLiveFolderAllowIssueCreation(): boolean;
}

// ── Service ─────────────────────────────────────────────────────────

export class LiveFolderService implements IssueTrackerService {
  public readonly mode: BackendMode = 'livefolder';

  private issues: LiveIssue[] = [];
  private projectKey = '';
  private projectName = '';
  private plansRootUri?: vscode.Uri;
  /** The resolved directory containing feature-NN-* folders (may differ from plansRootUri). */
  private featuresRootUri?: vscode.Uri;
  private loaded = false;
  private watcher?: vscode.FileSystemWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  /** Track URIs we just wrote to, so we can skip the watcher callback. */
  private recentWrites = new Set<string>();

  public constructor(private readonly configStore: LiveFolderConfigProvider) {}

  // ── Lifecycle ───────────────────────────────────────────────────

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.loaded = false;
    this.issues = [];
    await this.ensureLoaded();
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  // ── Connection ──────────────────────────────────────────────────

  public async checkConnection(): Promise<ConnectionCheck> {
    try {
      await this.ensureLoaded();
      return {
        status: 'ok',
        message: `Live Folder: ${this.issues.length} items from ${this.plansRootUri?.fsPath ?? '(not set)'} (${this.configStore.getLiveFolderAllowIssueCreation() ? 'issue creation enabled' : 'issue creation disabled'})`,
        toolCount: 0,
        projectCount: 1
      };
    } catch (e) {
      return {
        status: 'error',
        message: `Live Folder error: ${e instanceof Error ? e.message : String(e)}`,
        toolCount: 0
      };
    }
  }

  // ── Projects ────────────────────────────────────────────────────

  public async getProjects(): Promise<Project[]> {
    await this.ensureLoaded();
    return [{ key: this.projectKey, name: this.projectName }];
  }

  // ── Issues ──────────────────────────────────────────────────────

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    await this.ensureLoaded();
    let list = [...this.issues];

    if (filters.projectKeys.length > 0) {
      const pks = new Set(filters.projectKeys);
      list = list.filter(i => pks.has(i.projectKey));
    }
    if (filters.statuses.length > 0) {
      const ss = new Set(filters.statuses);
      list = list.filter(i => ss.has(i.status));
    }
    if (filters.issueTypes.length > 0) {
      const ts = new Set(filters.issueTypes);
      list = list.filter(i => ts.has(i.issueType));
    }
    if (filters.searchText) {
      const q = filters.searchText.toLowerCase();
      list = list.filter(
        i =>
          i.key.toLowerCase().includes(q) ||
          i.summary.toLowerCase().includes(q) ||
          (i.description ?? '').toLowerCase().includes(q)
      );
    }
    if (filters.parentKey) {
      list = list.filter(i => i.parentKey === filters.parentKey);
    }

    const total = list.length;
    const page = list.slice(startAt, startAt + pageSize);
    return { issues: page, total, hasMore: startAt + pageSize < total };
  }

  public async getFilterMetadata(_filters: IssueFilters): Promise<FilterMetadata> {
    await this.ensureLoaded();
    const statuses = [...new Set([...STATUS_NAMES, ...this.issues.map(i => i.status)])];
    const issueTypes = [...new Set(this.issues.map(i => i.issueType))];
    return { statuses, issueTypes };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    _options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    await this.ensureLoaded();
    let features = this.issues.filter(i => i.issueType === 'Feature');
    if (filters.projectKeys.length > 0) {
      const pks = new Set(filters.projectKeys);
      features = features.filter(i => pks.has(i.projectKey));
    }
    if (filters.statuses.length > 0) {
      const statuses = new Set(filters.statuses);
      features = features.filter(i => statuses.has(i.status));
    }
    if (searchText) {
      const q = searchText.toLowerCase();
      features = features.filter(
        i => i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q)
      );
    }
    return features;
  }

  // ── Boards ──────────────────────────────────────────────────────

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(_filters: BoardFilters): Promise<Board[]> {
    await this.ensureLoaded();
    return [
      {
        id: `livefolder-${this.projectKey.toLowerCase()}`,
        name: `${this.projectName} (Live)`,
        type: 'plan',
        projectKey: this.projectKey,
        projectName: this.projectName,
        locationName: this.plansRootUri?.fsPath ?? ''
      }
    ];
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    await this.ensureLoaded();
    const columnMap = new Map<string, IssueSummary[]>();
    for (const s of STATUS_NAMES) {
      columnMap.set(s, []);
    }
    for (const issue of this.issues) {
      const bucket = columnMap.get(issue.status) ?? columnMap.get('Backlog')!;
      bucket.push(issue);
    }
    const columns: BoardColumn[] = STATUS_NAMES.map(s => ({
      id: s,
      name: s,
      statusCategory: categoryForStatus(s),
      issues: columnMap.get(s) ?? []
    }));
    return {
      board,
      columns,
      issues: [...this.issues],
      columnStatusOrder: STATUS_NAMES
    };
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Live Folder mode does not support creating boards.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('Live Folder mode does not support updating boards.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Live Folder mode does not support deleting boards.');
  }

  // ── Single issue ────────────────────────────────────────────────

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    const transitions = transitionsFrom(issue.status);
    const parentIssue = issue.parentKey
      ? this.issues.find(candidate => candidate.key === issue.parentKey)
      : undefined;
    return {
      ...issue,
      parentIssue: toParentIssueReference(parentIssue),
      transitions,
      comments: []
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    await this.ensureLoaded();
    if (!this.configStore.getLiveFolderAllowIssueCreation()) {
      throw new Error(LIVE_FOLDER_CREATION_DISABLED_ERROR);
    }
    if (!this.featuresRootUri) {
      throw new Error('Live Folder features root is not configured.');
    }

    const issueType = normalizeLiveFolderIssueType(input.issueType);
    if (!issueType) {
      throw new Error(
        `Live Folder mode supports creating Feature, Story, Task, and Bug items. "${input.issueType}" is not supported.`
      );
    }

    const projectKey = input.projectKey.trim();
    if (projectKey !== this.projectKey) {
      throw new Error(`Project ${projectKey} is not available in Live Folder mode.`);
    }

    const summary = input.summary.trim();
    if (!summary) {
      throw new Error('Summary cannot be empty.');
    }
    const description = input.description?.trim() || undefined;
    const createdAt = new Date().toISOString();

    if (issueType === 'Feature') {
      if (input.parentKey?.trim()) {
        throw new Error('Feature items cannot have a parent.');
      }
      const featureId = this.getNextFeatureId();
      const featureDirUri = vscode.Uri.joinPath(
        this.featuresRootUri,
        buildFeatureDirectoryName(featureId, summary)
      );
      const featureFileUri = vscode.Uri.joinPath(featureDirUri, 'feature.md');

      await vscode.workspace.fs.createDirectory(featureDirUri);
      await this.writeManagedFile(
        featureFileUri,
        buildIssueMarkdown(issueType, summary, description, createdAt)
      );

      await this.loadFromDisk();
      return this.getIssue(stableFeatureKey(this.projectKey, featureId));
    }

    const parentFeature = this.resolveCreateParent(projectKey, issueType, input.parentKey?.trim());
    const childSeq = this.getNextChildSequence(parentFeature.featureId, issueType);
    const childFileUri = vscode.Uri.joinPath(
      this.featuresRootUri,
      parentFeature.featureDirName!,
      buildChildFileName(issueType, parentFeature.featureId, childSeq, summary)
    );

    await this.writeManagedFile(
      childFileUri,
      buildIssueMarkdown(issueType, summary, description, createdAt, parentFeature.key)
    );
    await this.writeFeatureItemTableRow(
      parentFeature,
      issueType,
      childSeq,
      summary,
      STATUS_NAMES[0] ?? 'Backlog'
    );

    await this.loadFromDisk();
    return this.getIssue(stableChildKey(this.projectKey, issueType, parentFeature.featureId, childSeq));
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    // Only assignee updates are supported in-memory (not persisted to markdown)
    if (input.assignee !== undefined) {
      issue.assignee = input.assignee ?? undefined;
    }
    const parentIssue = issue.parentKey
      ? this.issues.find(candidate => candidate.key === issue.parentKey)
      : undefined;
    return {
      ...issue,
      parentIssue: toParentIssueReference(parentIssue),
      transitions: transitionsFrom(issue.status),
      comments: []
    };
  }

  public async deleteIssue(_issueKey: string): Promise<void> {
    throw new Error('Live Folder mode does not support deleting issues. Remove plan files directly.');
  }

  public async addComment(_issueKey: string, _body: string): Promise<void> {
    throw new Error('Live Folder mode does not support comments.');
  }

  // ── Transitions ─────────────────────────────────────────────────

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      return [];
    }
    return transitionsFrom(issue.status);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }

    const available = transitionsFrom(issue.status);
    const transition = available.find(t => t.id === transitionId);
    if (!transition?.toStatus) {
      throw new Error(`Transition ${transitionId} not valid for ${issueKey}`);
    }

    const newStatus = transition.toStatus;
    const oldStatus = issue.status;

    // Write status to the markdown file
    this.recentWrites.add(issue.sourceUri.toString());
    try {
      await writeStatusToMarkdownFile(issue.sourceUri, newStatus);
    } finally {
      // Clear after a short delay to allow the watcher to see and skip it
      setTimeout(() => this.recentWrites.delete(issue.sourceUri.toString()), 2000);
    }

    // Update in-memory model
    issue.status = newStatus;
    issue.statusCategory = categoryForStatus(newStatus);
    issue.updated = new Date().toISOString();
    if (newStatus === 'Done' && !issue.completed) {
      issue.completed = new Date().toISOString();
    }

    // Feature rollup: update parent feature.md item table + feature status
    if (issue.childSeq !== undefined && issue.featureDirName && issue.issueType !== 'Feature') {
      const parentFeature = this.issues.find(
        i => i.issueType === 'Feature' && i.featureId === issue.featureId
      );
      if (parentFeature) {
        // Update the feature.md item table row for this child item.
        this.recentWrites.add(parentFeature.sourceUri.toString());
        try {
          await updateFeatureStoryTable(
            parentFeature.sourceUri,
            issue.childSeq,
            issue.summary,
            newStatus
          );
        } finally {
          setTimeout(() => this.recentWrites.delete(parentFeature.sourceUri.toString()), 2000);
        }

        // Only stories participate in the feature rollup workflow.
        if (issue.issueType === 'Story') {
          const siblingStories = this.issues.filter(
            i => i.issueType === 'Story' && i.featureId === issue.featureId
          );
          const rollupStatus = computeFeatureRollupStatus(siblingStories.map(s => s.status));
          if (rollupStatus && rollupStatus !== parentFeature.status) {
            this.recentWrites.add(parentFeature.sourceUri.toString());
            try {
              await writeStatusToMarkdownFile(parentFeature.sourceUri, rollupStatus);
            } finally {
              setTimeout(() => this.recentWrites.delete(parentFeature.sourceUri.toString()), 2000);
            }
            parentFeature.status = rollupStatus;
            parentFeature.statusCategory = categoryForStatus(rollupStatus);
            parentFeature.updated = new Date().toISOString();
          }
        }
      }
    }

    // If a feature was transitioned directly, update its markdown
    if (issue.issueType === 'Feature' && oldStatus !== newStatus) {
      // Already written above via writeStatusToMarkdownFile
    }
  }

  // ── Browse ──────────────────────────────────────────────────────

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    const live = this.issues.find(i => i.key === issue.key);
    if (live?.sourceUri) {
      return live.sourceUri.toString();
    }
    return undefined;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  // ── Internal ────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const folderPath = this.configStore.getLiveFolderPath();
    if (!folderPath) {
      throw new Error('Live Folder path is not configured. Set ticketManager.liveFolderPath.');
    }

    this.projectKey = this.configStore.getLiveFolderProjectKey() || 'LIVE';
    this.projectName = this.configStore.getLiveFolderProjectName() || 'Live Folder';
    this.plansRootUri = undefined;

    await this.loadFromDisk(folderPath);
    this.setupWatcher();
    this.loaded = true;
  }

  private async loadFromDisk(folderPathOverride?: string): Promise<void> {
    const folderPath = folderPathOverride ?? this.plansRootUri?.fsPath;
    if (!folderPath) {
      return;
    }

    const parsed = await parsePlanFolder(folderPath);
    this.plansRootUri = parsed.plansRootUri;
    this.featuresRootUri = parsed.featuresRootUri;
    this.issues = this.buildIssueModel(parsed);
  }

  private buildIssueModel(parsed: ParsedPlanFolder): LiveIssue[] {
    const pk = this.projectKey;
    const pn = this.projectName;
    const issues: LiveIssue[] = [];

    // Features
    for (const f of parsed.features) {
      const key = stableFeatureKey(pk, f.featureId);
      const now = new Date().toISOString();
      issues.push({
        key,
        summary: f.title,
        status: f.planStatus,
        statusCategory: categoryForStatus(f.planStatus),
        issueType: 'Feature',
        projectKey: pk,
        projectName: pn,
        priority: 'Medium',
        created: f.planningDates.created ?? now,
        updated: f.planningDates.completed ?? now,
        description: f.description,
        sourceUri: f.featureMdUri,
        featureId: f.featureId,
        featureDirName: f.dirName
      });
    }

    const featureDirNameById = new Map<number, string>();
    for (const feature of parsed.features) {
      featureDirNameById.set(feature.featureId, feature.dirName);
    }

    // Child items (stories, tasks, bugs)
    for (const child of parsed.childItems) {
      const key =
        child.issueType === 'Story'
          ? stableStoryKey(pk, child.featureId, child.sequence)
          : stableChildKey(pk, child.issueType, child.featureId, child.sequence);
      const parentKey = stableFeatureKey(pk, child.featureId);
      const now = new Date().toISOString();
      issues.push({
        key,
        summary: child.title,
        status: child.planStatus,
        statusCategory: categoryForStatus(child.planStatus),
        issueType: child.issueType,
        projectKey: pk,
        projectName: pn,
        parentKey,
        priority: 'Medium',
        created: child.planningDates.created ?? now,
        updated: child.planningDates.completed ?? now,
        description: child.description,
        branch: child.branch,
        sourceUri: child.fileUri,
        featureId: child.featureId,
        childSeq: child.sequence,
        featureDirName: featureDirNameById.get(child.featureId)
      });
    }

    // Resolve dependency tokens to stable keys
    const featureKeyByDir = new Map<string, string>();
    for (const f of parsed.features) {
      featureKeyByDir.set(f.dirName, stableFeatureKey(pk, f.featureId));
    }
    const childKeyByBaseName = new Map<string, string>();
    for (const child of parsed.childItems) {
      const key =
        child.issueType === 'Story'
          ? stableStoryKey(pk, child.featureId, child.sequence)
          : stableChildKey(pk, child.issueType, child.featureId, child.sequence);
      childKeyByBaseName.set(child.filename.replace(/\.md$/i, '').toLowerCase(), key);
    }

    // Attach dependsOn to each issue
    const allParsed = [
      ...parsed.features.map(f => ({
        key: stableFeatureKey(pk, f.featureId),
        tokens: f.depTokens
      })),
      ...parsed.childItems.map(child => ({
        key:
          child.issueType === 'Story'
            ? stableStoryKey(pk, child.featureId, child.sequence)
            : stableChildKey(pk, child.issueType, child.featureId, child.sequence),
        tokens: child.depTokens
      }))
    ];

    for (const { key, tokens } of allParsed) {
      if (!tokens.length) {
        continue;
      }
      const issue = issues.find(i => i.key === key);
      if (!issue) {
        continue;
      }
      const resolved: string[] = [];
      for (const token of tokens) {
        if (/^[A-Z][A-Z0-9_]{1,14}-\d+$/.test(token)) {
          resolved.push(token);
        } else if (/^feature-\d+/i.test(token)) {
          const k = featureKeyByDir.get(token);
          if (k) {
            resolved.push(k);
          }
        } else {
          const k = childKeyByBaseName.get(token.toLowerCase());
          if (k) {
            resolved.push(k);
          }
        }
      }
      if (resolved.length > 0) {
        issue.dependsOn = resolved.filter(r => r !== key);
      }
    }

    return issues;
  }

  private getNextFeatureId(): number {
    const featureIds = this.issues
      .filter(issue => issue.issueType === 'Feature')
      .map(issue => issue.featureId);
    return (featureIds.length > 0 ? Math.max(...featureIds) : 0) + 1;
  }

  private getNextChildSequence(
    featureId: number,
    issueType: Exclude<CreatableLiveFolderIssueType, 'Feature'>
  ): number {
    const childSequences = this.issues
      .filter(issue => issue.featureId === featureId && issue.issueType === issueType)
      .map(issue => issue.childSeq ?? 0);
    return (childSequences.length > 0 ? Math.max(...childSequences) : 0) + 1;
  }

  private resolveCreateParent(
    projectKey: string,
    issueType: Exclude<CreatableLiveFolderIssueType, 'Feature'>,
    parentKey: string | undefined
  ): LiveIssue {
    const rule = getParentRule(issueType, 'livefolder');
    if (!parentKey) {
      throw new Error(`${rule.defaultLabel} is required for ${issueType} items.`);
    }

    const parentIssue = this.issues.find(issue => issue.key === parentKey);
    if (!parentIssue) {
      throw new Error(`${rule.defaultLabel} ${parentKey} was not found.`);
    }
    if (parentIssue.projectKey !== projectKey) {
      throw new Error(`${rule.defaultLabel} ${parentKey} must be in the same project.`);
    }
    if (!isAllowedParentType(parentIssue.issueType, issueType, 'livefolder')) {
      throw new Error(buildParentValidationMessage(issueType, 'livefolder', parentIssue.issueType));
    }
    if (!parentIssue.featureDirName) {
      throw new Error(`Feature ${parentIssue.key} is missing its live folder directory.`);
    }
    return parentIssue;
  }

  private async writeManagedFile(fileUri: vscode.Uri, contents: string): Promise<void> {
    this.recentWrites.add(fileUri.toString());
    try {
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(contents, 'utf8'));
    } finally {
      setTimeout(() => this.recentWrites.delete(fileUri.toString()), 2000);
    }
  }

  private async writeFeatureItemTableRow(
    parentFeature: LiveIssue,
    issueType: Exclude<CreatableLiveFolderIssueType, 'Feature'>,
    childSeq: number,
    summary: string,
    status: string
  ): Promise<void> {
    this.recentWrites.add(parentFeature.sourceUri.toString());
    try {
      await appendFeatureItemTableRow(
        parentFeature.sourceUri,
        `${padFeatureId(parentFeature.featureId)}.${childSeq}`,
        issueType,
        summary,
        status
      );
    } finally {
      setTimeout(() => this.recentWrites.delete(parentFeature.sourceUri.toString()), 2000);
    }
  }

  private setupWatcher(): void {
    if (this.watcher || !this.featuresRootUri) {
      return;
    }

    const pattern = new vscode.RelativePattern(this.featuresRootUri, '*/**/*.md');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      // Skip if we just wrote this file
      if (this.recentWrites.has(uri.toString())) {
        return;
      }
      // Debounce rapid changes
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        void this.reloadFromDisk();
      }, 500);
    };

    this.watcher.onDidChange(handleChange);
    this.watcher.onDidCreate(handleChange);
    this.watcher.onDidDelete(handleChange);
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      await this.loadFromDisk();
    } catch {
      // Silently ignore reload errors — folder may be temporarily invalid
    }
  }
}
