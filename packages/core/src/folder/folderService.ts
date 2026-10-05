import * as path from 'node:path';
import { readBoardConfigFile, writeBoardConfigFile, type BoardConfigFile } from './boardConfigFile';
import { folderFs } from './folderFs';
import type { ProjectWorkflowStage } from '../projects/projectTypes';
import { DEFAULT_WORKFLOW, normalizeWorkflowStages } from '../projects/projectWorkflow';
import { folderWatch, type FolderWatcher } from './folderWatch';
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
  discoverPlanFolders,
  extractComments,
  identifyPlanFolder,
  parsePlanFolder,
  resolvePlanDependencyKeys,
  readUtf8,
  stableChildKey,
  stableFeatureKey,
  stableStoryKey
} from './markdownPlanParser';
import { toStoredFolderPath } from './pathUtils';
import {
  appendCommentToMarkdownFile,
  appendFeatureItemTableRow,
  computeFeatureRollupStatus,
  removeFeatureItemTableRow,
  updateFeatureStoryTable,
  upgradeMarkdownFile,
  writeDescriptionToMarkdownFile,
  writeModelToMarkdownFile,
  writePriorityToMarkdownFile,
  writeParentToMarkdownFile,
  writeReportedByToMarkdownFile,
  writeSeverityToMarkdownFile,
  writeStatusToMarkdownFile,
  writeSummaryToMarkdownFile,
  writeIdeaTranscriptToMarkdownFile
} from './markdownStatusWriter';
import { generateIssueMarkdown, type IssueType } from './markdownTemplate';

// ── Workflow ────────────────────────────────────────────────────────

// A folder board's columns are its *project's workflow*, not a constant here
// (FX-BE-045). `board.praxis.json` declares it so it travels with the folder;
// a folder that declares none falls back to DEFAULT_WORKFLOW, which is the five
// statuses this constant used to hold — same names, order and categories — so
// an existing folder board is unchanged.
const FOLDER_CREATION_DISABLED_ERROR =
  'Issue creation is disabled for this folder. Enable it on the connection to create markdown issues.';

type CreatableFolderIssueType = 'Feature' | 'Idea' | 'Story' | 'Task' | 'Bug';

const CHILD_FILE_PREFIX_BY_TYPE: Record<Exclude<CreatableFolderIssueType, 'Feature'>, string> = {
  Idea: 'idea',
  Story: 'story',
  Task: 'task',
  Bug: 'bug'
};

function categoryForStatus(name: string, workflow: readonly ProjectWorkflowStage[]): string {
  return workflow.find(s => s.name === name)?.category ?? 'todo';
}

function transitionsFrom(
  currentStatus: string,
  workflow: readonly ProjectWorkflowStage[]
): WorkflowTransition[] {
  return workflow.map(s => s.name).filter(s => s !== currentStatus).map((s, i) => ({
    id: `lf-${i}-${s.replace(/\s/g, '-').toLowerCase()}`,
    name: `Move to ${s}`,
    toStatus: s
  }));
}

function normalizeFolderIssueType(value: string): CreatableFolderIssueType | undefined {
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
  issueType: Exclude<CreatableFolderIssueType, 'Feature'>,
  featureId: number,
  childSeq: number,
  summary: string
): string {
  return `${CHILD_FILE_PREFIX_BY_TYPE[issueType]}-${padFeatureId(featureId)}-${childSeq}-${slugifyPathSegment(summary)}.md`;
}

function buildIssueMarkdown(
  issueType: CreatableFolderIssueType,
  title: string,
  description: string | undefined,
  ideaTranscript: string | undefined,
  createdAtIso: string,
  parentKey?: string,
  model?: string,
  extras?: Pick<CreateIssueInput, 'priority' | 'severity' | 'sections'>
): string {
  const fieldValues = {
    ...(extras?.priority?.trim() ? { Priority: extras.priority.trim() } : {}),
    ...(extras?.severity?.trim() ? { Severity: extras.severity.trim() } : {})
  };
  return generateIssueMarkdown(issueType as IssueType, title, {
    description,
    ideaTranscript,
    createdAt: createdAtIso,
    parentKey,
    model,
    ...(Object.keys(fieldValues).length > 0 ? { fieldValues } : {}),
    ...(extras?.sections ? { sectionBodies: extras.sections } : {})
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
  featureDirName?: string;
}

// ── Multi-root boards ───────────────────────────────────────────────

/**
 * Stable short hash of a plans-root path, used to distinguish board ids when a
 * folder contains several plans roots. djb2 — a stable discriminator, not
 * cryptographic.
 */
function hashRootPath(rootPath: string): string {
  let hash = 5381;
  const normalized = toStoredFolderPath(rootPath).toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** One discovered plans root, backing one board. */
interface FolderBoardRoot {
  id: string;
  name: string;
  rootPath: string;
  featuresRootPath: string;
  /** This root's own project key — its `board.praxis.json`, else the connection's. */
  projectKey: string;
  /** This root's own project name — its `board.praxis.json`, else the connection's. */
  projectName: string;
}

export interface FolderConfigProvider {
  getDefaultPageSize(): number;
  /**
   * The folders to discover plans roots under, in order. The first is the
   * "primary" root: it supplies the fallback project identity and is the one
   * the template-upgrade pass writes to. Roots need not share a parent.
   */
  getFolderRoots(): string[];
  getFolderProjectKey(): string;
  getFolderProjectName(): string;
  getFolderAllowIssueCreation(): boolean;
  getAiDefaultModel(): string;
  /**
   * Whether the configured key/name outrank a root's `board.praxis.json`.
   *
   * A folder *connection* says no (the default): the folder is shared, so its
   * own file describes it and travels with it. A folder-backed *project* says
   * yes — the user chose that key in the project wizard, and letting a file in
   * the folder quietly win would make the field they typed a lie.
   */
  prefersConfiguredIdentity?(): boolean;
}

// ── Service ─────────────────────────────────────────────────────────

/** Fired when an external file edit adds a new comment to a ticket. */
export interface ExternalCommentEvent {
  issueKey: string;
  author: string;
  body: string;
}

/** How long a path we wrote ourselves is treated as our own write by the watcher. */
const SELF_WRITE_WINDOW_MS = 2000;

export class FolderService implements IssueTrackerService {
  public readonly mode: BackendMode = 'folder';

  private issues: LiveIssue[] = [];
  private projectKey = '';
  private projectName = '';
  /** `board.praxis.json` from the primary plans root — overrides the connection's settings. */
  private boardConfig: BoardConfigFile = {};
  private plansRootPath?: string;
  /** The resolved directory containing feature-NN-* folders (may differ from plansRootPath). */
  private featuresRootPath?: string;
  /** The configured folders discovery started from (kept for reloads). */
  private configuredRoots: string[] = [];
  /**
   * Every plans root discovered under the configured folder, primary root first.
   * A single root yields exactly the legacy one-board shape; extra roots get
   * path-hashed board ids.
   */
  private boardRoots: FolderBoardRoot[] = [];
  private issuesByRoot = new Map<string, LiveIssue[]>();
  private loaded = false;
  /** In-flight first load — concurrent callers share it instead of racing a
   *  second `loadFromDisk` (whose template-upgrade pass rewrites files). */
  private loadingPromise?: Promise<void>;
  private watchers: FolderWatcher[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  /** Track paths we just wrote to, so we can skip the watcher callback. */
  private recentWrites = new Set<string>();

  /** Snapshot of comment counts per issue key, used to detect new external comments. */
  private commentCountSnapshot = new Map<string, number>();

  private readonly _onDidReceiveExternalComment = new Emitter<ExternalCommentEvent>();
  public readonly onDidReceiveExternalComment: Event<ExternalCommentEvent> = this._onDidReceiveExternalComment.event;

  private readonly _onDidReloadFromDisk = new Emitter<void>();
  /** Fired after a watcher-driven reload replaced the in-memory board model. */
  public readonly onDidReloadFromDisk: Event<void> = this._onDidReloadFromDisk.event;

  public constructor(private readonly configStore: FolderConfigProvider) {}

  /**
   * This board's columns: the folder's declared workflow, else the five
   * statuses folder boards have always had.
   */
  private currentWorkflow(): readonly ProjectWorkflowStage[] {
    return this.boardConfig.workflow?.length
      ? normalizeWorkflowStages(this.boardConfig.workflow)
      : DEFAULT_WORKFLOW;
  }

  private statusNames(): string[] {
    return this.currentWorkflow().map(stage => stage.name);
  }

  /** `board.praxis.json` wins over the connection setting when it specifies a value. */
  private allowsIssueCreation(): boolean {
    return this.boardConfig.allowIssueCreation ?? this.configStore.getFolderAllowIssueCreation();
  }

  /**
   * Materialize the connection's project identity into `board.praxis.json` in the
   * plans root so it travels with the folder. Called by the create-board and
   * connection-edit flows so the file stays in sync with what the user set.
   *
   * `allowIssueCreation` is only written when the caller says it is a real
   * per-board setting (the desktop connection form) — never from the user
   * workspace path, where it is a single app-wide toggle.
   */
  public async syncBoardConfigToFolder(options?: {
    includeAllowIssueCreation?: boolean;
    /** The board's columns, written so the workflow travels with the folder (FX-BE-045). */
    workflow?: readonly ProjectWorkflowStage[];
  }): Promise<void> {
    await this.ensureLoaded();
    if (!this.plansRootPath) {
      return;
    }
    // An explicit workflow replaces what is on disk; otherwise whatever the
    // folder already declares is preserved rather than silently dropped.
    const workflow = options?.workflow ?? this.boardConfig.workflow;
    const next: BoardConfigFile = {
      projectKey: this.configStore.getFolderProjectKey() || undefined,
      projectName: this.configStore.getFolderProjectName() || undefined,
      ...(workflow?.length ? { workflow: normalizeWorkflowStages(workflow) } : {}),
      ...(options?.includeAllowIssueCreation
        ? { allowIssueCreation: this.configStore.getFolderAllowIssueCreation() }
        : {})
    };
    const configFilePath = path.join(this.plansRootPath, 'board.praxis.json');
    this.recentWrites.add(configFilePath);
    setTimeout(() => this.recentWrites.delete(configFilePath), 2000);
    await writeBoardConfigFile(this.plansRootPath, next);
    this.boardConfig = await readBoardConfigFile(this.plansRootPath);
    this.projectKey = this.resolveKey(this.boardConfig);
    this.projectName = this.resolveName(this.boardConfig);
  }

  /** The connection's key unless a root's own file may override it. */
  private resolveKey(config: BoardConfigFile): string {
    const configured = this.configStore.getFolderProjectKey();
    if (this.configStore.prefersConfiguredIdentity?.() && configured) {
      return configured;
    }
    return config.projectKey ?? (configured || 'LIVE');
  }

  /** The connection's name unless a root's own file may override it. */
  private resolveName(config: BoardConfigFile): string {
    const configured = this.configStore.getFolderProjectName();
    if (this.configStore.prefersConfiguredIdentity?.() && configured) {
      return configured;
    }
    return config.projectName ?? (configured || 'Folder');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.loaded = false;
    this.issues = [];
    this.boardRoots = [];
    this.issuesByRoot.clear();
    await this.ensureLoaded();
  }

  /**
   * Closes the file watchers. The returned promise settles once they have
   * released their handles — callers that just want the service gone can
   * ignore it, but a test suite must await it or the process hangs on an open
   * chokidar handle.
   */
  public dispose(): Promise<void> {
    const closing = this.watchers.map(watcher => watcher.close());
    this.watchers = [];
    this._onDidReceiveExternalComment.dispose();
    this._onDidReloadFromDisk.dispose();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    return Promise.all(closing).then(() => undefined);
  }

  // ── Connection ──────────────────────────────────────────────────

  public async checkConnection(): Promise<ConnectionCheck> {
    try {
      await this.ensureLoaded();
      return {
        status: 'ok',
        message: `Folder: ${this.issues.length} items from ${this.plansRootPath ?? '(not set)'} (${this.allowsIssueCreation() ? 'issue creation enabled' : 'issue creation disabled'})`,
        toolCount: 0,
        projectCount: 1
      };
    } catch (e) {
      return {
        status: 'error',
        message: `Folder error: ${e instanceof Error ? e.message : String(e)}`,
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

    // Multi-root connections expose one board per root but share a single
    // projectKey, so board scoping has to go through the root's issue list —
    // projectKeys alone would return every root's issues for every board.
    if (filters.boardId) {
      const root = this.boardRoots.find(candidate => candidate.id === filters.boardId);
      list = root ? [...(this.issuesByRoot.get(root.rootPath) ?? [])] : [];
    }

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
    const statuses = [...new Set([...this.statusNames(), ...this.issues.map(i => i.status)])];
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
    return this.boardRoots.map(root => ({
      id: root.id,
      name: root.name,
      type: 'plan',
      projectKey: root.projectKey,
      projectName: root.projectName,
      locationName: root.rootPath
    }));
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    await this.ensureLoaded();
    // Multi-root: scope the columns to the board's own plans root. An unknown
    // id (e.g. a board constructed before a reload) falls back to every issue,
    // matching the legacy single-root behavior.
    const root = this.boardRoots.find(candidate => candidate.id === board.id);
    const issues = root ? (this.issuesByRoot.get(root.rootPath) ?? []) : this.issues;
    const columnMap = new Map<string, IssueSummary[]>();
    for (const s of this.statusNames()) {
      columnMap.set(s, []);
    }
    for (const issue of issues) {
      const bucket = columnMap.get(issue.status) ?? columnMap.get(this.statusNames()[0])!;
      bucket.push(issue);
    }
    const columns: BoardColumn[] = this.statusNames().map(s => ({
      id: s,
      name: s,
      statusCategory: categoryForStatus(s, this.currentWorkflow()),
      issues: columnMap.get(s) ?? []
    }));
    return {
      board,
      columns,
      issues: [...issues],
      columnStatusOrder: this.statusNames()
    };
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Folder mode does not support creating boards.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('Folder mode does not support updating boards.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Folder mode does not support deleting boards.');
  }

  // ── Single issue ────────────────────────────────────────────────

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    const transitions = transitionsFrom(issue.status, this.currentWorkflow());
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
    if (!this.allowsIssueCreation()) {
      throw new Error(FOLDER_CREATION_DISABLED_ERROR);
    }
    // Multi-root v1: writes always land in the primary root. Refuse loudly when
    // the caller targeted another root rather than silently misfiling the issue.
    if (input.boardId && this.boardRoots.length > 1) {
      const target = this.boardRoots.find(root => root.id === input.boardId);
      if (target && target.id !== this.boardRoots[0]?.id) {
        throw new Error(
          'Creating issues in a specific plans root is not supported yet for multi-root folder connections — create from the primary board instead.'
        );
      }
    }
    if (!this.featuresRootPath) {
      throw new Error('Folder features root is not configured.');
    }

    const issueType = normalizeFolderIssueType(input.issueType);
    if (!issueType) {
      throw new Error(
        `Folder mode supports creating Feature, Story, Task, and Bug items. "${input.issueType}" is not supported.`
      );
    }

    const projectKey = input.projectKey.trim();
    if (projectKey !== this.projectKey) {
      throw new Error(`Project ${projectKey} is not available in Folder mode.`);
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

      await folderFs().mkdir(featureDirPath);
      await this.writeManagedFile(
        featureFilePath,
        buildIssueMarkdown(
          issueType,
          summary,
          description,
          undefined,
          createdAt,
          undefined,
          defaultModel,
          input
        )
      );

      await this.loadFromDisk();
      return this.getIssue(stableFeatureKey(this.projectKey, featureId));
    }

    // newParentSummary is specific to folder-backed boards and is ignored by
    // other backends: when no existing parent was picked, create the Feature first
    // (same primitives as the Feature branch above) and use its key as the parent.
    let resolvedParentKey = input.parentKey?.trim() || undefined;
    if (!resolvedParentKey && input.newParentSummary?.trim()) {
      const newFeatureId = this.getNextFeatureId();
      const newFeatureDirPath = path.join(
        this.featuresRootPath,
        buildFeatureDirectoryName(newFeatureId, input.newParentSummary.trim())
      );
      await folderFs().mkdir(newFeatureDirPath);
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
        defaultModel,
        input
      )
    );
    await this.writeFeatureItemTableRow(
      parentFeature,
      issueType,
      childSeq,
      summary,
      this.statusNames()[0] ?? 'Backlog'
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

    const hasParentPatch = Object.prototype.hasOwnProperty.call(input, 'parentKey');
    if (hasParentPatch) {
      const issueType = normalizeFolderIssueType(issue.issueType);
      if (!issueType || issueType === 'Feature') {
        throw new Error(buildParentValidationMessage(issue.issueType, 'folder', undefined));
      }

      const nextParentKey = input.parentKey?.trim() || undefined;
      const parentFeature = this.resolveCreateParent(issue.projectKey, issueType, nextParentKey);
      if (nextParentKey !== issue.parentKey) {
        const previousPath = issue.sourcePath;
        const previousParent = issue.parentKey
          ? this.issues.find(candidate => candidate.key === issue.parentKey)
          : undefined;
        const nextChildSeq = this.getNextChildSequence(parentFeature.featureId!, issueType);
        const nextPath = path.join(
          path.dirname(parentFeature.sourcePath),
          buildChildFileName(
            issueType,
            parentFeature.featureId!,
            nextChildSeq,
            input.summary?.trim() || issue.summary
          )
        );

        this.recentWrites.add(previousPath);
        this.recentWrites.add(nextPath);
        try {
          await folderFs().moveFile(previousPath, nextPath);
        } finally {
          setTimeout(() => {
            this.recentWrites.delete(previousPath);
            this.recentWrites.delete(nextPath);
          }, 2000);
        }

        if (previousParent && issue.featureId !== undefined && issue.childSeq !== undefined) {
          await this.writeFeatureItemTableRowRemoval(
            previousParent,
            issue.issueType,
            issue.childSeq
          );
        }
        await this.writeFeatureItemTableRow(
          parentFeature,
          issueType,
          nextChildSeq,
          input.summary?.trim() || issue.summary,
          issue.status
        );
        this.recentWrites.add(nextPath);
        try {
          await writeParentToMarkdownFile(nextPath, parentFeature.key);
        } finally {
          setTimeout(() => this.recentWrites.delete(nextPath), 2000);
        }

        issue.key = issueType === 'Story'
          ? stableStoryKey(issue.projectKey, parentFeature.featureId!, nextChildSeq)
          : stableChildKey(issue.projectKey, issueType, parentFeature.featureId!, nextChildSeq);
        issue.parentKey = parentFeature.key;
        issue.featureId = parentFeature.featureId;
        issue.featureDirName = parentFeature.featureDirName;
        issue.childSeq = nextChildSeq;
        issue.sourcePath = nextPath;
      }
    }

    // Persist summary changes to the markdown `# ` title line
    if (input.summary !== undefined && input.summary !== null) {
      this.recentWrites.add(issue.sourcePath);
      try {
        const written = await writeSummaryToMarkdownFile(issue.sourcePath, input.summary);
        if (!written && issue.summary !== input.summary.trim()) {
          throw new Error(`Could not update summary in ${issue.sourcePath}.`);
        }
        issue.summary = input.summary.trim();
      } finally {
        setTimeout(() => this.recentWrites.delete(issue.sourcePath), 2000);
      }
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
      transitions: transitionsFrom(issue.status, this.currentWorkflow()),
      comments
    };
  }

  public async deleteIssue(_issueKey: string): Promise<void> {
    throw new Error('Folder mode does not support deleting issues. Remove the markdown files directly.');
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
    throw new Error('Folder mode does not support attachments.');
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error('Folder mode does not support attachment downloads.');
  }

  // ── Transitions ─────────────────────────────────────────────────

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      return [];
    }
    return transitionsFrom(issue.status, this.currentWorkflow());
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.ensureLoaded();
    const issue = this.issues.find(i => i.key === issueKey);
    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }

    const available = transitionsFrom(issue.status, this.currentWorkflow());
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
    issue.statusCategory = categoryForStatus(newStatus, this.currentWorkflow());
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
            parentFeature.statusCategory = categoryForStatus(rollupStatus, this.currentWorkflow());
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
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadInitial();
      // A failed load clears the memo so the next call retries from scratch.
      this.loadingPromise.catch(() => {
        this.loadingPromise = undefined;
      });
    }
    return this.loadingPromise;
  }

  private async loadInitial(): Promise<void> {
    const roots = this.configStore.getFolderRoots().filter(root => root.trim().length > 0);
    if (roots.length === 0) {
      throw new Error('This folder connection has no folders configured. Add at least one plans folder.');
    }

    this.projectKey = this.configStore.getFolderProjectKey() || 'LIVE';
    this.projectName = this.configStore.getFolderProjectName() || 'Folder';
    this.plansRootPath = undefined;
    this.configuredRoots = roots;

    await this.loadFromDisk(roots);
    await this.snapshotCommentCounts();
    this.setupWatcher();
    this.loaded = true;
  }

  private async loadFromDisk(rootsOverride?: string[]): Promise<void> {
    const roots = rootsOverride
      ?? (this.configuredRoots.length > 0
        ? this.configuredRoots
        : this.plansRootPath ? [this.plansRootPath] : []);
    if (roots.length === 0) {
      return;
    }

    // The board's workflow decides what a plan document's status resolves to,
    // so `board.praxis.json` has to be read *before* the parse — otherwise a
    // doc whose status names a declared stage ("Architecture") is resolved
    // against the default five and silently lands in the first column.
    // Identifying the plans root is a directory scan; parsing is the expensive
    // part, and it still happens exactly once per load.
    const identified = await identifyPlanFolder(roots[0]);
    this.boardConfig = await readBoardConfigFile(identified.plansRootPath);

    // Primary root: the first configured folder. parsePlanFolder throws the
    // familiar "unreadable / not a plans folder" errors and its output drives
    // the template-upgrade pass — only this root is ever written to.
    let parsed = await parsePlanFolder(roots[0], undefined, this.currentWorkflow());
    this.plansRootPath = parsed.plansRootPath;
    this.featuresRootPath = parsed.featuresRootPath;

    // Upgrade existing files to current template format
    const anyUpgraded = await this.upgradeExistingFiles(parsed);

    // Re-parse if any files were upgraded so the model reflects new fields
    if (anyUpgraded) {
      parsed = await parsePlanFolder(roots[0], undefined, this.currentWorkflow());
      this.plansRootPath = parsed.plansRootPath;
      this.featuresRootPath = parsed.featuresRootPath;
    }

    // A `board.praxis.json` in the primary plans root overrides the connection's
    // project identity so it travels with the folder. Re-read on every load so
    // an external edit to the file is picked up on the next reload.
    this.boardConfig = await readBoardConfigFile(this.plansRootPath);
    this.projectKey = this.resolveKey(this.boardConfig);
    this.projectName = this.resolveName(this.boardConfig);

    // Multi-board discovery: every other plans root under any configured folder
    // becomes its own board. Extra roots are parsed read-only (no template
    // upgrade writes) so pointing at a parent folder never mutates sibling
    // projects. Discovery/parse failures skip that root rather than failing the
    // whole load.
    const rootParses: ParsedPlanFolder[] = [parsed];
    const seen = new Set<string>([toStoredFolderPath(parsed.plansRootPath).toLowerCase()]);
    for (const configuredRoot of roots) {
      try {
        for (const candidate of await discoverPlanFolders(configuredRoot)) {
          const candidateKey = toStoredFolderPath(candidate.plansRootPath).toLowerCase();
          if (seen.has(candidateKey)) {
            continue;
          }
          seen.add(candidateKey);
          try {
            rootParses.push(await parsePlanFolder(candidate.plansRootPath, undefined, this.currentWorkflow()));
          } catch {
            // A root that vanishes mid-scan is skipped, not fatal.
          }
        }
      } catch {
        // Discovery failure on one configured folder must not lose the others.
      }
    }

    // Each root may carry its own `board.praxis.json` supplying its project key
    // and name; both fall back to the connection's when unset. Issue keys are
    // built per root, so two roots can use different keys under one connection.
    const rootConfigs = await Promise.all(
      rootParses.map((rootParsed, index) =>
        index === 0 ? Promise.resolve(this.boardConfig) : readBoardConfigFile(rootParsed.plansRootPath)
      )
    );

    this.issuesByRoot.clear();
    this.boardRoots = rootParses.map((rootParsed, index) => {
      // A project-backed service owns its identity outright, so a secondary
      // root's own file must not rename or re-key it either.
      const authoritative = this.configStore.prefersConfiguredIdentity?.() === true;
      const rootKey = (authoritative ? this.projectKey : rootConfigs[index]?.projectKey || this.projectKey).toUpperCase();
      const rootProjectName = authoritative ? this.projectName : rootConfigs[index]?.projectName || this.projectName;
      this.issuesByRoot.set(
        rootParsed.plansRootPath,
        this.buildIssueModel(rootParsed, rootKey, rootProjectName)
      );
      if (index === 0) {
        return {
          id: `folder-${rootKey.toLowerCase()}`,
          name: rootProjectName,
          rootPath: rootParsed.plansRootPath,
          featuresRootPath: rootParsed.featuresRootPath,
          projectKey: rootKey,
          projectName: rootProjectName
        };
      }
      // Secondary boards are path-hashed so two roots that share a key still
      // get distinct board ids.
      const rootName = rootConfigs[index]?.projectName || path.basename(rootParsed.plansRootPath);
      return {
        id: `folder-${rootKey.toLowerCase()}-${hashRootPath(rootParsed.plansRootPath)}`,
        name: rootName,
        rootPath: rootParsed.plansRootPath,
        featuresRootPath: rootParsed.featuresRootPath,
        projectKey: rootKey,
        projectName: rootName
      };
    });
    this.issues = rootParses.flatMap(
      rootParsed => this.issuesByRoot.get(rootParsed.plansRootPath) ?? []
    );
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

  private buildIssueModel(
    parsed: ParsedPlanFolder,
    projectKey: string = this.projectKey,
    projectName: string = this.projectName
  ): LiveIssue[] {
    const pk = projectKey;
    const pn = projectName;
    const issues: LiveIssue[] = [];

    // Features
    for (const f of parsed.features) {
      const key = stableFeatureKey(pk, f.featureId);
      const now = new Date().toISOString();
      issues.push({
        key,
        summary: f.title,
        status: f.planStatus,
        statusCategory: categoryForStatus(f.planStatus, this.currentWorkflow()),
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
        statusCategory: categoryForStatus(child.planStatus, this.currentWorkflow()),
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

    // Explicit planning ids must resolve to this board's generated keys.
    const dependencyKeys = resolvePlanDependencyKeys(parsed, pk);
    for (const issue of issues) {
      const keys = dependencyKeys.get(issue.key);
      if (keys?.length) issue.dependsOn = keys;
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
    issueType: Exclude<CreatableFolderIssueType, 'Feature'>
  ): number {
    const childSequences = this.issues
      .filter(issue => issue.featureId === featureId && issue.issueType === issueType)
      .map(issue => issue.childSeq ?? 0);
    return (childSequences.length > 0 ? Math.max(...childSequences) : 0) + 1;
  }

  private resolveCreateParent(
    projectKey: string,
    issueType: Exclude<CreatableFolderIssueType, 'Feature'>,
    parentKey: string | undefined
  ): LiveIssue {
    const rule = getParentRule(issueType, 'folder');
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
    if (!isAllowedParentType(parentIssue.issueType, issueType, 'folder')) {
      throw new Error(buildParentValidationMessage(issueType, 'folder', parentIssue.issueType));
    }
    if (!parentIssue.featureDirName) {
      throw new Error(`Feature ${parentIssue.key} is missing its plans directory.`);
    }
    return parentIssue;
  }

  private async writeManagedFile(filePath: string, contents: string): Promise<void> {
    this.recentWrites.add(filePath);
    try {
      await folderFs().writeFile(filePath, contents);
    } finally {
      setTimeout(() => this.recentWrites.delete(filePath), 2000);
    }
  }

  private async writeFeatureItemTableRow(
    parentFeature: LiveIssue,
    issueType: Exclude<CreatableFolderIssueType, 'Feature'>,
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

  private async writeFeatureItemTableRowRemoval(
    parentFeature: LiveIssue,
    issueType: string,
    childSeq: number
  ): Promise<void> {
    this.recentWrites.add(parentFeature.sourcePath);
    try {
      await removeFeatureItemTableRow(
        parentFeature.sourcePath,
        `${padFeatureId(parentFeature.featureId!)}.${childSeq}`,
        issueType
      );
    } finally {
      setTimeout(() => this.recentWrites.delete(parentFeature.sourcePath), 2000);
    }
  }

  private setupWatcher(): void {
    if (this.watchers.length > 0 || this.boardRoots.length === 0) {
      return;
    }

    const handleChangeFor = (_rootPath: string) => (absolutePath: string) => {
      // A path we just wrote is our own echo, so don't reload straight away —
      // but never drop the event: an external edit or delete landing inside the
      // self-write window would otherwise be lost for good and leave a stale
      // card. Reload once the window has lapsed instead.
      const delayMs = this.recentWrites.has(absolutePath) ? SELF_WRITE_WINDOW_MS + 500 : 500;
      // Debounce rapid changes
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        void this.reloadFromDisk();
      }, delayMs);
    };

    // One watcher per plans root. Roots discovered later (by a reload) are not
    // watched until the next full load — a documented v1 limitation.
    const watch = folderWatch();
    for (const root of this.boardRoots) {
      this.watchers.push(watch(root.rootPath, handleChangeFor(root.rootPath)));
    }
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      await this.loadFromDisk();
      this._onDidReloadFromDisk.fire();
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
