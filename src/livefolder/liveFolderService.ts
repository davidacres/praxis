import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
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
  IssueSummary,
  PagedIssues,
  ParentItemQueryOptions,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import {
  type ParsedFeatureFolder,
  type ParsedPlanFolder,
  type ParsedStoryFile,
  parsePlanFolder,
  stableFeatureKey,
  stableStoryKey
} from './markdownPlanParser';
import {
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

// ── Internal model ──────────────────────────────────────────────────

interface LiveIssue extends IssueSummary {
  sourceUri: vscode.Uri;
  featureId: number;
  storySeq?: number;
  featureDirName?: string;
}

// ── Service ─────────────────────────────────────────────────────────

export class LiveFolderService implements IssueTrackerService {
  public readonly mode: BackendMode = 'livefolder';

  private issues: LiveIssue[] = [];
  private projectKey = '';
  private projectName = '';
  private plansRootUri?: vscode.Uri;
  private loaded = false;
  private watcher?: vscode.FileSystemWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  /** Track URIs we just wrote to, so we can skip the watcher callback. */
  private recentWrites = new Set<string>();

  public constructor(private readonly configStore: AppConfigStore) {}

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
        message: `Live Folder: ${this.issues.length} items from ${this.plansRootUri?.fsPath ?? '(not set)'}`,
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
    const statuses = [...new Set(this.issues.map(i => i.status))];
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
    return { ...issue, transitions, comments: [] };
  }

  public async createIssue(_input: CreateIssueInput): Promise<IssueDetails> {
    throw new Error('Live Folder mode does not support creating issues. Author plan files directly.');
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    // Only assignee updates are supported in-memory (not persisted to markdown)
    if (input.assignee !== undefined) {
      issue.assignee = input.assignee ?? undefined;
    }
    return { ...issue, transitions: transitionsFrom(issue.status), comments: [] };
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

    // Feature rollup: update parent feature.md story table + feature status
    if (issue.storySeq !== undefined && issue.featureDirName) {
      const parentFeature = this.issues.find(
        i => i.issueType === 'Feature' && i.featureId === issue.featureId
      );
      if (parentFeature) {
        // Update story table row in feature.md
        this.recentWrites.add(parentFeature.sourceUri.toString());
        try {
          await updateFeatureStoryTable(
            parentFeature.sourceUri,
            issue.storySeq,
            issue.summary,
            newStatus
          );
        } finally {
          setTimeout(() => this.recentWrites.delete(parentFeature.sourceUri.toString()), 2000);
        }

        // Compute and apply feature rollup status
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
    this.plansRootUri = vscode.Uri.file(folderPath);

    await this.loadFromDisk();
    this.setupWatcher();
    this.loaded = true;
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.plansRootUri) {
      return;
    }

    const parsed = await parsePlanFolder(this.plansRootUri);
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

    // Stories
    for (const s of parsed.stories) {
      const key = stableStoryKey(pk, s.featureId, s.storySeq);
      const parentKey = stableFeatureKey(pk, s.featureId);
      const now = new Date().toISOString();
      issues.push({
        key,
        summary: s.title,
        status: s.planStatus,
        statusCategory: categoryForStatus(s.planStatus),
        issueType: 'Story',
        projectKey: pk,
        projectName: pn,
        parentKey,
        priority: 'Medium',
        created: s.planningDates.created ?? now,
        updated: s.planningDates.completed ?? now,
        description: s.description,
        branch: s.branch,
        sourceUri: s.storyMdUri,
        featureId: s.featureId,
        storySeq: s.storySeq,
        featureDirName: parsed.features.find(f => f.featureId === s.featureId)?.dirName
      });
    }

    // Resolve dependency tokens to stable keys
    const featureKeyByDir = new Map<string, string>();
    for (const f of parsed.features) {
      featureKeyByDir.set(f.dirName, stableFeatureKey(pk, f.featureId));
    }
    const storyKeyByFS = new Map<string, string>();
    for (const s of parsed.stories) {
      storyKeyByFS.set(`${s.featureId}-${s.storySeq}`, stableStoryKey(pk, s.featureId, s.storySeq));
    }

    // Attach dependsOn to each issue
    const allParsed = [
      ...parsed.features.map(f => ({
        key: stableFeatureKey(pk, f.featureId),
        tokens: f.depTokens
      })),
      ...parsed.stories.map(s => ({
        key: stableStoryKey(pk, s.featureId, s.storySeq),
        tokens: s.depTokens
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
          const sm = token.match(/^story-(\d+)-(\d+)/i);
          if (sm) {
            const k = storyKeyByFS.get(`${Number.parseInt(sm[1], 10)}-${Number.parseInt(sm[2], 10)}`);
            if (k) {
              resolved.push(k);
            }
          }
        }
      }
      if (resolved.length > 0) {
        issue.dependsOn = resolved.filter(r => r !== key);
      }
    }

    return issues;
  }

  private setupWatcher(): void {
    if (this.watcher || !this.plansRootUri) {
      return;
    }

    const pattern = new vscode.RelativePattern(this.plansRootUri, 'features/**/*.md');
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
