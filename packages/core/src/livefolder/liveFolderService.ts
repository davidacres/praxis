import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { Emitter, type Event } from '../host/emitter';
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
  IssueAttachment,
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
  type ParsedPlanFolder,
  extractComments,
  parsePlanFolder,
  readUtf8,
  stableChildKey,
  stableFeatureKey,
  stableStoryKey
} from './markdownPlanParser';
import {
  appendCommentToMarkdownFile,
  appendFeatureItemTableRow,
  computeFeatureRollupStatus,
  updateFeatureStoryTable,
  upgradeMarkdownFile,
  writeDescriptionToMarkdownFile,
  writeModelToMarkdownFile,
  writePriorityToMarkdownFile,
  writeReportedByToMarkdownFile,
  writeSeverityToMarkdownFile,
  writeStatusToMarkdownFile,
  writeIdeaTranscriptToMarkdownFile
} from './markdownStatusWriter';
import { generateIssueMarkdown, type IssueType } from './markdownTemplate';

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

type CreatableLiveFolderIssueType = 'Feature' | 'Idea' | 'Story' | 'Task' | 'Bug';

const CHILD_FILE_PREFIX_BY_TYPE: Record<Exclude<CreatableLiveFolderIssueType, 'Feature'>, string> = {
  Idea: 'idea',
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
    case 'idea':
      return 'Idea';
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

function buildIssueMarkdown(
  issueType: CreatableLiveFolderIssueType,
  title: string,
  description: string | undefined,
  ideaTranscript: string | undefined,
  createdAtIso: string,
  parentKey?: string,
  model?: string
): string {
  return generateIssueMarkdown(issueType as IssueType, title, {
    description,
    ideaTranscript,
    createdAt: createdAtIso,
    parentKey,
    model
  });
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
  sourcePath: string;
  featureId: number | undefined;
  childSeq?: number;
  featureDirName?: string;
}

export interface LiveFolderConfigProvider {
  getDefaultPageSize(): number;
  getLiveFolderPath(): string;
  getLiveFolderProjectKey(): string;
  getLiveFolderProjectName(): string;
  getLiveFolderAllowIssueCreation(): boolean;
  getAiDefaultModel(): string;
}

// ── Service ─────────────────────────────────────────────────────────

/** Fired when an external file edit adds a new comment to a ticket. */
export interface ExternalCommentEvent {
  issueKey: string;
  author: string;
  body: string;
}

export class LiveFolderService implements IssueTrackerService {
  public readonly mode: BackendMode = 'livefolder';

  private issues: LiveIssue[] = [];
  private projectKey = '';
  private projectName = '';
  private plansRootPath?: string;
  /** The resolved directory containing feature-NN-* folders (may differ from plansRootPath). */
  private featuresRootPath?: string;
  private loaded = false;
  private watcher?: FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  /** Track paths we just wrote to, so we can skip the watcher callback. */
  private recentWrites = new Set<string>();

  /** Snapshot of comment counts per issue key, used to detect new external comments. */
  private commentCountSnapshot = new Map<string, number>();

  private readonly _onDidReceiveExternalComment = new Emitter<ExternalCommentEvent>();
  public readonly onDidReceiveExternalComment: Event<ExternalCommentEvent> = this._onDidReceiveExternalComment.event;

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
    void this.watcher?.close();
    this.watcher = undefined;
    this._onDidReceiveExternalComment.dispose();
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
        message: `Live Folder: ${this.issues.length} items from ${this.plansRootPath ?? '(not set)'} (${this.configStore.getLiveFolderAllowIssueCreation() ? 'issue creation enabled' : 'issue creation disabled'})`,
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
        locationName: this.plansRootPath ?? ''
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
    const comments = await this.readCommentsFromFile(issue);
    return {
      ...issue,
      parentIssue: toParentIssueReference(parentIssue),
      transitions,
      comments
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    await this.ensureLoaded();
    if (!this.configStore.getLiveFolderAllowIssueCreation()) {
      throw new Error(LIVE_FOLDER_CREATION_DISABLED_ERROR);
    }
    if (!this.featuresRootPath) {
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
    const ideaTranscript = input.ideaTranscript?.trim() || undefined;
    const createdAt = new Date().toISOString();
    const defaultModel = this.configStore.getAiDefaultModel() || undefined;

    if (issueType === 'Feature') {
      if (input.parentKey?.trim()) {
        throw new Error('Feature items cannot have a parent.');
      }
      const featureId = this.getNextFeatureId();
      const featureDirPath = path.join(
        this.featuresRootPath,
        buildFeatureDirectoryName(featureId, summary)
      );
      const featureFilePath = path.join(featureDirPath, 'feature.md');

      await fs.mkdir(featureDirPath, { recursive: true });
      await this.writeManagedFile(
        featureFilePath,
        buildIssueMarkdown(
          issueType,
          summary,
          description,
          undefined,
          createdAt,
          undefined,
          defaultModel
        )
      );

      await this.loadFromDisk();
      return this.getIssue(stableFeatureKey(this.projectKey, featureId));
    }

    // newParentSummary is specific to livefolder/userworkspace and is ignored by
    // other backends: when no existing parent was picked, create the Feature first
    // (same primitives as the Feature branch above) and use its key as the parent.
    let resolvedParentKey = input.parentKey?.trim() || undefined;
    if (!resolvedParentKey && input.newParentSummary?.trim()) {
      const newFeatureId = this.getNextFeatureId();
      const newFeatureDirPath = path.join(
        this.featuresRootPath,
        buildFeatureDirectoryName(newFeatureId, input.newParentSummary.trim())
      );
      await fs.mkdir(newFeatureDirPath, { recursive: true });
      await this.writeManagedFile(
        path.join(newFeatureDirPath, 'feature.md'),
        buildIssueMarkdown(
          'Feature',
          input.newParentSummary.trim(),
          undefined,
          undefined,
          createdAt,
          undefined,
          defaultModel
        )
      );
      // The new feature must be in the in-memory model before resolveCreateParent.
      await this.loadFromDisk();
      resolvedParentKey = stableFeatureKey(projectKey, newFeatureId);
    }

    const parentFeature = this.resolveCreateParent(projectKey, issueType, resolvedParentKey);
    const childSeq = this.getNextChildSequence(parentFeature.featureId!, issueType);
    const childFilePath = path.join(
      this.featuresRootPath,
      parentFeature.featureDirName!,
      buildChildFileName(issueType, parentFeature.featureId!, childSeq, summary)
    );

    await this.writeManagedFile(
      childFilePath,
      buildIssueMarkdown(
        issueType,
        summary,
        description,
        issueType === 'Idea' ? ideaTranscript : undefined,
        createdAt,
        parentFeature.key,
        defaultModel
      )
    );
    await this.writeFeatureItemTableRow(
      parentFeature,
      issueType,
      childSeq,
      summary,
      STATUS_NAMES[0] ?? 'Backlog'
    );

    await this.loadFromDisk();
    return this.getIssue(stableChildKey(this.projectKey, issueType, parentFeature.featureId!, childSeq));
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }

    if (input.assignee !== undefined) {
      issue.assignee = input.assignee ?? undefined;
    }

    const updatesNeedIdeaTranscript =
      issue.issueType === 'Idea' &&
      (input.description !== undefined || input.ideaTranscript !== undefined);
    if (updatesNeedIdeaTranscript) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const nextDescription = input.description !== undefined ? input.description : issue.description ?? '';
        const nextTranscript =
          input.ideaTranscript !== undefined ? input.ideaTranscript : issue.ideaTranscript ?? '';
        const written = await writeIdeaTranscriptToMarkdownFile(
          issue.sourcePath,
          nextDescription,
          nextTranscript
        );
        if (!written && (issue.description ?? '') !== nextDescription) {
          throw new Error(`Could not update description in ${issue.sourcePath}.`);
        }
        issue.description = nextDescription;
        issue.ideaTranscript = nextTranscript;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    } else if (input.description !== undefined && input.description !== null) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writeDescriptionToMarkdownFile(issue.sourcePath, input.description);
        if (!written && (issue.description ?? '') !== input.description) {
          throw new Error(`Could not update description in ${issue.sourcePath}.`);
        }
        issue.description = input.description;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    }

    // Persist priority changes to markdown file
    if (input.priority !== undefined && input.priority !== null) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writePriorityToMarkdownFile(issue.sourcePath, input.priority);
        if (!written && issue.priority !== input.priority) {
          throw new Error(`Could not update priority in ${issue.sourcePath}.`);
        }
        issue.priority = input.priority;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    }

    // Persist model changes to markdown file
    if (input.model !== undefined) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writeModelToMarkdownFile(issue.sourcePath, input.model);
        if (!written && issue.model !== input.model) {
          throw new Error(`Could not update model in ${issue.sourcePath}.`);
        }
        issue.model = input.model;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    }

    // Persist severity changes to markdown file
    if (input.severity !== undefined) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writeSeverityToMarkdownFile(issue.sourcePath, input.severity);
        if (!written && issue.severity !== input.severity) {
          throw new Error(`Could not update severity in ${issue.sourcePath}.`);
        }
        issue.severity = input.severity;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    }

    // Persist reportedBy changes to markdown file
    if (input.reportedBy !== undefined) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writeReportedByToMarkdownFile(issue.sourcePath, input.reportedBy);
        if (!written && issue.reportedBy !== input.reportedBy) {
          throw new Error(`Could not update reported by in ${issue.sourcePath}.`);
        }
        issue.reportedBy = input.reportedBy;
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
    }

    const parentIssue = issue.parentKey
      ? this.issues.find(candidate => candidate.key === issue.parentKey)
      : undefined;
    const comments = await this.readCommentsFromFile(issue);
    return {
      ...issue,
      parentIssue: toParentIssueReference(parentIssue),
      transitions: transitionsFrom(issue.status),
      comments
    };
  }

  public async deleteIssue(_issueKey: string): Promise<void> {
    throw new Error('Live Folder mode does not support deleting issues. Remove the markdown files directly.');
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const commentBody = body.trim();
    if (commentBody.length === 0) {
      throw new Error('Comment cannot be empty.');
    }
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    const author = issue.assignee || issue.key;
    this.recentWrites.add(issue.sourcePath);
    try {
      await appendCommentToMarkdownFile(issue.sourcePath, author, commentBody);
      // Update snapshot so the watcher doesn't treat this as an external comment
      const prev = this.commentCountSnapshot.get(issueKey) ?? 0;
      this.commentCountSnapshot.set(issueKey, prev + 1);
    } finally {
      setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
    }
  }

  public async attachFile(_issueKey: string, _filePath: string, _fileName?: string): Promise<void> {
    throw new Error('Live Folder mode does not support attachments.');
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error('Live Folder mode does not support attachment downloads.');
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
    this.recentWrites.add(issue.sourcePath);
    let written: boolean;
    try {
      written = await writeStatusToMarkdownFile(issue.sourcePath, newStatus);
    } finally {
      // Clear after a short delay to allow the watcher to see and skip it
      setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
    }

    if (!written) {
      throw new Error(
        `Could not update status in ${issue.sourcePath}. ` +
        `The file status is already set to the target value.`
      );
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
        this.recentWrites.add(parentFeature.sourcePath);
        try {
          await updateFeatureStoryTable(
            parentFeature.sourcePath,
            issue.childSeq,
            issue.summary,
            newStatus
          );
        } finally {
          setTimeout(() => this.recentWrites.delete(parentFeature.sourcePath), 2000);
        }

        // Only stories participate in the feature rollup workflow.
        if (issue.issueType === 'Story') {
          const siblingStories = this.issues.filter(
            i => i.issueType === 'Story' && i.featureId === issue.featureId
          );
          const rollupStatus = computeFeatureRollupStatus(siblingStories.map(s => s.status));
          if (rollupStatus && rollupStatus !== parentFeature.status) {
            this.recentWrites.add(parentFeature.sourcePath);
            try {
              await writeStatusToMarkdownFile(parentFeature.sourcePath, rollupStatus);
            } finally {
              setTimeout(() => this.recentWrites.delete(parentFeature.sourcePath), 2000);
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
    if (live?.sourcePath) {
      return live.sourcePath;
    }
    return undefined;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  // ── Internal ────────────────────────────────────────────────────

  private async readCommentsFromFile(issue: LiveIssue): Promise<IssueDetails['comments']> {
    try {
      const content = await readUtf8(issue.sourcePath);
      const parsed = extractComments(content);
      return parsed.map((c, i) => ({
        id: `${issue.key}-comment-${i + 1}`,
        author: c.author,
        body: c.body,
        created: c.created,
        updated: c.created
      }));
    } catch {
      return [];
    }
  }

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
    this.plansRootPath = undefined;

    await this.loadFromDisk(folderPath);
    await this.snapshotCommentCounts();
    this.setupWatcher();
    this.loaded = true;
  }

  private async loadFromDisk(folderPathOverride?: string): Promise<void> {
    const folderPath = folderPathOverride ?? this.plansRootPath;
    if (!folderPath) {
      return;
    }

    let parsed = await parsePlanFolder(folderPath);
    this.plansRootPath = parsed.plansRootPath;
    this.featuresRootPath = parsed.featuresRootPath;

    // Upgrade existing files to current template format
    const anyUpgraded = await this.upgradeExistingFiles(parsed);

    // Re-parse if any files were upgraded so the model reflects new fields
    if (anyUpgraded) {
      parsed = await parsePlanFolder(folderPath);
      this.plansRootPath = parsed.plansRootPath;
      this.featuresRootPath = parsed.featuresRootPath;
    }

    this.issues = this.buildIssueModel(parsed);
  }

  private async upgradeExistingFiles(parsed: ParsedPlanFolder): Promise<boolean> {
    let anyUpgraded = false;
    for (const f of parsed.features) {
      this.recentWrites.add(f.featureMdPath);
      try {
        const upgraded = await upgradeMarkdownFile(f.featureMdPath, 'Feature');
        if (upgraded) { anyUpgraded = true; }
      } finally {
        setTimeout(() => this.recentWrites.delete(f.featureMdPath), 2000);
      }
    }
    for (const child of parsed.childItems) {
      this.recentWrites.add(child.filePath);
      try {
        const upgraded = await upgradeMarkdownFile(child.filePath, child.issueType);
        if (upgraded) { anyUpgraded = true; }
      } finally {
        setTimeout(() => this.recentWrites.delete(child.filePath), 2000);
      }
    }
    return anyUpgraded;
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
        priority: f.priority ?? 'Medium',
        complexity: f.complexity,
        model: f.model,
        created: f.planningDates.created ?? now,
        updated: f.planningDates.completed ?? now,
        description: f.description,
        sourcePath: f.featureMdPath,
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
      const fid = child.featureId ?? 0;
      const key =
        child.issueType === 'Story'
          ? stableStoryKey(pk, fid, child.sequence)
          : stableChildKey(pk, child.issueType, fid, child.sequence);
      const parentKey = child.featureId !== undefined
        ? stableFeatureKey(pk, child.featureId)
        : undefined;
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
        priority: child.priority ?? 'Medium',
        severity: child.severity,
        reportedBy: child.reportedBy,
        complexity: child.complexity,
        model: child.model,
        created: child.planningDates.created ?? now,
        updated: child.planningDates.completed ?? now,
        description: child.description,
        branch: child.branch,
        sourcePath: child.filePath,
        featureId: child.featureId,
        childSeq: child.sequence,
        featureDirName: child.featureId !== undefined
          ? featureDirNameById.get(child.featureId)
          : undefined
      });
    }

    // Resolve dependency tokens to stable keys
    const featureKeyByDir = new Map<string, string>();
    for (const f of parsed.features) {
      featureKeyByDir.set(f.dirName, stableFeatureKey(pk, f.featureId));
    }
    const childKeyByBaseName = new Map<string, string>();
    for (const child of parsed.childItems) {
      const fid = child.featureId ?? 0;
      const key =
        child.issueType === 'Story'
          ? stableStoryKey(pk, fid, child.sequence)
          : stableChildKey(pk, child.issueType, fid, child.sequence);
      childKeyByBaseName.set(child.filename.replace(/\.md$/i, '').toLowerCase(), key);
    }

    // Attach dependsOn to each issue
    const allParsed = [
      ...parsed.features.map(f => ({
        key: stableFeatureKey(pk, f.featureId),
        tokens: f.depTokens
      })),
      ...parsed.childItems.map(child => {
        const fid = child.featureId ?? 0;
        return {
          key:
            child.issueType === 'Story'
              ? stableStoryKey(pk, fid, child.sequence)
              : stableChildKey(pk, child.issueType, fid, child.sequence),
          tokens: child.depTokens
        };
      })
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
      .filter(issue => issue.issueType === 'Feature' && issue.featureId !== undefined)
      .map(issue => issue.featureId as number);
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

  private async writeManagedFile(filePath: string, contents: string): Promise<void> {
    this.recentWrites.add(filePath);
    try {
      await fs.writeFile(filePath, contents, 'utf-8');
    } finally {
      setTimeout(() => this.recentWrites.delete(filePath), 2000);
    }
  }

  private async writeFeatureItemTableRow(
    parentFeature: LiveIssue,
    issueType: Exclude<CreatableLiveFolderIssueType, 'Feature'>,
    childSeq: number,
    summary: string,
    status: string
  ): Promise<void> {
    this.recentWrites.add(parentFeature.sourcePath);
    try {
      await appendFeatureItemTableRow(
        parentFeature.sourcePath,
        `${padFeatureId(parentFeature.featureId!)}.${childSeq}`,
        issueType,
        summary,
        status
      );
    } finally {
      setTimeout(() => this.recentWrites.delete(parentFeature.sourcePath), 2000);
    }
  }

  private setupWatcher(): void {
    if (this.watcher || !this.plansRootPath) {
      return;
    }

    this.watcher = chokidar.watch('**/*.md', {
      cwd: this.plansRootPath,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });

    const handleChange = (relativePath: string) => {
      const absolutePath = path.join(this.plansRootPath!, relativePath);
      // Skip if we just wrote this file
      if (this.recentWrites.has(absolutePath)) {
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

    this.watcher.on('change', handleChange);
    this.watcher.on('add', handleChange);
    this.watcher.on('unlink', handleChange);
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      await this.loadFromDisk();
      await this.detectNewExternalComments();
    } catch {
      // Silently ignore reload errors — folder may be temporarily invalid
    }
  }

  /** Snapshot comment counts for all loaded issues. Called after internal writes. */
  private async snapshotCommentCounts(): Promise<void> {
    for (const issue of this.issues) {
      try {
        const content = await readUtf8(issue.sourcePath);
        const comments = extractComments(content);
        this.commentCountSnapshot.set(issue.key, comments.length);
      } catch {
        // ignore read errors
      }
    }
  }

  /**
   * Compare current comment counts against snapshot and fire events for new external comments.
   * Updates the snapshot after detection.
   */
  private async detectNewExternalComments(): Promise<void> {
    for (const issue of this.issues) {
      try {
        const content = await readUtf8(issue.sourcePath);
        const comments = extractComments(content);
        const previousCount = this.commentCountSnapshot.get(issue.key) ?? 0;
        if (comments.length > previousCount) {
          // Fire events for each new comment
          for (let i = previousCount; i < comments.length; i++) {
            this._onDidReceiveExternalComment.fire({
              issueKey: issue.key,
              author: comments[i].author,
              body: comments[i].body
            });
          }
        }
        this.commentCountSnapshot.set(issue.key, comments.length);
      } catch {
        // ignore read errors
      }
    }
  }
}
