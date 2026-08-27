import type {
  AiProvider,
  Board,
  BoardColumnPreferences,
  BoardDetails,
  BoardFilters,
  Connection,
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
  TrackedBoard,
  UpdateIssueInput
} from '../types';
import type { ModelOptions } from '../ai/providers/modelCatalog';
import type { ActivatedSkill, AgentRuntimeSnapshot } from '../ai/agentRuntime';
import type { IdentifiedPlanFolder } from '../livefolder/markdownPlanParser';
import type { BoardDraftRow } from '../userWorkspace/boardDraftPlanner';
import type { AppSettings, AppSettingsPatch } from '../config/appSettings';
import type {
  AgentSessionRecord,
  AgentTaskDefinition,
  AgentToolMode,
  SessionMode,
  AgentWorkflowReference,
  IssueWorkflowAssignment
} from '../ai/agentTypes';
import type { PermissionDecision } from '../ai/tools';
import type { LprResult } from '../ai/aiReviewService';
import type {
  TaskDesignerFlowRecommendation,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode
} from '../ai/aiReviewService';
import type {
  TaskDesignerPersistedState,
  TaskDesignerTicketNode
} from '../taskDesigner/taskDesignerState';
import type { GitLabMergeRequest } from '../gitlab/gitLabApiService';
import type {
  AttachProjectFolderInput,
  AttachProjectFolderResult,
  CreateProjectInput,
  FolderInspection,
  ProjectBoardReference,
  ProjectRecord,
  UpdateProjectInput
} from '../projects/projectTypes';
import type { GitBlameLine, GitCommitDetails, GitConflictFile, GitConflictResolution, GitDiffDocument, GitDiffRequest, GitDiffResult, GitFileHistoryEntry, GitHunkActionRequest, GitRepositoryPreflight, GitRepositorySnapshot, GitStatusSnapshot } from '../git/gitGraph';

/**
 * Typed IPC contract for the Board and Issue Detail slices, shared (type-only) between the
 * Electron main process (registers ipcMain.handle per method) and the preload script (wraps
 * each into window.ticketManager.*). No runtime code crosses this boundary.
 */
export interface BoardIpc {
  /**
   * Without `connectionId`, aggregates demo boards + every supported connection's
   * boards (one bad connection is skipped, not fatal). With `connectionId`, lists
   * only that connection's boards — used by the board picker.
   */
  list(filters: BoardFilters, connectionId?: string): Promise<Board[]>;
  get(board: Board): Promise<BoardDetails>;
}

export interface IssueIpc {
  /**
   * Filtered, paged issue query — the board view's data source. `filters.boardId`
   * scopes to one board (backends that can't scope by board fall back to
   * `projectKeys`); `startAt`/`pageSize` drive the load-more paging.
   */
  list(
    filters: IssueFilters,
    startAt: number,
    pageSize: number,
    connectionId?: string
  ): Promise<PagedIssues>;
  /** Distinct statuses/types available under the given scope, for filter-bar options. */
  getFilterMetadata(filters: IssueFilters, connectionId?: string): Promise<FilterMetadata>;
  get(issueKey: string, connectionId?: string): Promise<IssueDetails>;
  create(input: CreateIssueInput, connectionId?: string): Promise<IssueDetails>;
  update(issueKey: string, input: UpdateIssueInput, connectionId?: string): Promise<IssueDetails>;
  delete(issueKey: string, connectionId?: string): Promise<void>;
  transition(issueKey: string, transitionId: string, connectionId?: string): Promise<void>;
  addComment(issueKey: string, body: string, connectionId?: string): Promise<void>;
  /** Tracker-specific label for the authenticated user, used by "Assign to me". */
  getSelfAssigneeLabel(connectionId?: string): Promise<string | undefined>;
  getProjects(connectionId?: string): Promise<Project[]>;
  /** Candidate parents for the create/edit form (Features for livefolder, Epics for Jira, …). */
  getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions,
    connectionId?: string
  ): Promise<IssueSummary[]>;
}

export interface ConnectionIpc {
  list(): Promise<Connection[]>;
  add(connection: Connection): Promise<void>;
  update(connection: Connection): Promise<void>;
  remove(connectionId: string): Promise<void>;
  /**
   * Slug-based unique id for a new connection name. Generated main-side so the
   * slug rules and collision suffixes stay in one place (ConnectionStore).
   */
  generateId(name: string): Promise<string>;
  /** Runs the backend's health check; unported modes return a clear error status. */
  check(connectionId: string): Promise<ConnectionCheck>;
  getTrackedBoards(connectionId: string): Promise<TrackedBoard[]>;
  addTrackedBoards(boards: TrackedBoard[]): Promise<void>;
  removeTrackedBoard(connectionId: string, boardId: string): Promise<void>;
  updateTrackedBoard(board: TrackedBoard): Promise<void>;
  /**
   * Stores a secret (e.g. an API key) encrypted via the OS keychain. Passing
   * `undefined` deletes it. Tracked so `remove` purges it with the connection.
   */
  setSecret(connectionId: string, name: string, value: string | undefined): Promise<void>;
  /**
   * True when a secret exists for this connection. The value itself never
   * crosses IPC — the form only needs to know whether one is already saved.
   */
  hasSecret(connectionId: string, name: string): Promise<boolean>;
}

/**
 * User Workspace slice: the board-creation wizard plus board lifecycle. Board
 * definitions live in a global store (`userWorkspace.json` on desktop,
 * `context.globalState` in the extension), so these take the connection id only
 * to route to the right backend — the store itself is shared.
 */
export interface UserWorkspaceIpc {
  /**
   * Discovers board candidates under a picked folder — step 2 of the
   * create-board wizard. Merges two scans (plan folders and Git repository
   * roots) the same way the VS Code extension's "Find repositories" does,
   * so a brand-new repo with no plans content yet still surfaces a row.
   */
  discoverBoardDrafts(connectionId: string, folderPath: string): Promise<BoardDraftRow[]>;
  /** Re-validates edited draft rows (unique/well-formed project keys) before creation. */
  validateBoardDrafts(connectionId: string, rows: BoardDraftRow[]): Promise<string | undefined>;
  createBoard(connectionId: string, input: CreateBoardInput): Promise<Board>;
  deleteBoard(connectionId: string, boardId: string): Promise<void>;
}

/**
 * Live Folder slice. A live-folder connection whose configured folder contains
 * several plans roots exposes one board per root; this lets the renderer show
 * the discovery result without loading a board.
 */
export interface LiveFolderIpc {
  /** All plans roots under the connection's configured folder (multi-board discovery). */
  discoverPlans(connectionId: string): Promise<IdentifiedPlanFolder[]>;
}

/**
 * Window chrome control. The app runs frameless (no native title bar or menu), so the renderer
 * owns the caption buttons and needs to drive the native window itself.
 */
export interface WindowIpc {
  /** Reloads the current renderer window without quitting the desktop process. */
  reload(): Promise<void>;
  minimize(): Promise<void>;
  /** Toggles between maximized and restored; resolves with the state after the toggle. */
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Subscribes to maximize/unmaximize; returns an unsubscribe function. */
  onMaximizeChange(listener: (maximized: boolean) => void): () => void;
}

/**
 * Settings store slice. The Electron main process and the VS Code extension
 * share a single JSON file (see `resolveSharedSettingsPath`) so a change made
 * in one is reflected in the other via the file watcher + this push channel.
 */
export interface SettingsIpc {
  /** Returns the current settings (merged over defaults). */
  get(): Promise<AppSettings>;
  /**
   * Applies a deep patch to the current settings, persists, and resolves with the
   * merged result so the caller can show the new state without an extra `get`.
   */
  set(patch: AppSettingsPatch): Promise<AppSettings>;
  /**
   * Push channel for live updates. Fires whenever the settings change — both
   * from a local `set` and from an external change (e.g. the VS Code extension
   * editing the same file). Returns an unsubscribe function.
   */
  onChanged(listener: (settings: AppSettings) => void): () => void;
}

/**
 * Main-process log stream. Ported backends (Jira, GitLab) and the AI agent
 * service write through host-provided `LogSink`s; the desktop host tees those
 * lines into a `LogBus` ring buffer that the Output panel tails via this slice.
 */
export interface LogIpc {
  /** The most recent buffered lines (oldest first). */
  getRecent(): Promise<string[]>;
  /** Push channel for new lines; returns an unsubscribe function. */
  onAppended(listener: (line: string) => void): () => void;
}

/**
 * Native dialogs. The renderer is sandboxed, so anything the OS must own
 * (file/folder pickers) goes through here.
 */
export interface DialogIpc {
  /** Native folder picker; resolves to the chosen path, or undefined when cancelled. */
  pickFolder(title?: string): Promise<string | undefined>;
}

/**
 * Per-board view preferences (list/board mode, swim lanes, colors, column
 * set/order, per-column card order, max-age). Backed by the same
 * `BoardColumnStore` the extension uses, persisted by the host — Electron keeps
 * it in a small JSON file under `userData`, so it survives relaunch but stays
 * out of the shared settings document.
 */
export interface BoardPrefsIpc {
  /** Returns the board's prefs; an empty default when none were saved yet. */
  get(boardId: string): Promise<BoardColumnPreferences>;
  /** Replaces the board's prefs wholesale (the store prunes empty fields). */
  set(boardId: string, prefs: BoardColumnPreferences): Promise<void>;
}

/**
 * Outbound links. The renderer is sandboxed, so opening a URL in the system
 * browser goes through here; main rejects anything that isn't http(s).
 */
export interface ShellIpc {
  /** Opens the URL in the system browser. Resolves false when the URL was refused. */
  openExternal(url: string): Promise<boolean>;
}

export interface AppIpc {
  getVersion(): Promise<string>;
}

/** Durable app-managed projects and their default local boards. */
export interface ProjectsIpc {
  list(): Promise<ProjectRecord[]>;
  get(projectId: string): Promise<ProjectRecord | undefined>;
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  update(projectId: string, patch: UpdateProjectInput): Promise<ProjectRecord>;
  inspectFolder(folderPath: string): Promise<FolderInspection>;
  attachFolder(projectId: string, input: AttachProjectFolderInput): Promise<AttachProjectFolderResult>;
  linkBoard(projectId: string, board: ProjectBoardReference): Promise<ProjectRecord>;
  unlinkBoard(projectId: string, connectionId: string, boardId: string): Promise<ProjectRecord>;
}

/** Progress payload streamed on the `ai:reviewProgress` push channel while a review runs. */
export interface AiReviewProgress {
  issueKey: string;
  /** Full review markdown accumulated so far. */
  content: string;
  /** True on the final payload — `error` is set when the review failed or was cancelled. */
  done: boolean;
  error?: string;
}

/** One chat turn in the per-issue analysis conversation. */
export interface AiAnalysisMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

/**
 * Per-issue analysis state. Messages/confirmed/confirmedAt/model persist;
 * `busy` is runtime-only (an analysis run is streaming right now).
 */
export interface AiAnalysisState {
  issueKey: string;
  messages: AiAnalysisMessage[];
  /** Gate flag: delegation/delivery can require a confirmed analysis first. */
  confirmed: boolean;
  confirmedAt?: string;
  /** True while an analysis run is streaming. */
  busy: boolean;
  /** Provider used by the latest analysis run. */
  provider?: AiProvider;
  model?: string;
}

/** Where the effective Vercel gateway API key came from. */
export type AiKeySource = 'secret' | 'env' | 'none';

export interface AiProviderStatus {
  provider: AiProvider;
  /** True when a usable API key exists (secret store or, for vercel-gateway, env fallback). */
  configured: boolean;
  keySource: AiKeySource;
  /** Effective base URL — the configured value or the provider's shipped default. */
  gatewayUrl: string;
  defaultModel: string;
  agentName: string;
  /** Issue keys with a currently running agent task. */
  activeTasks: string[];
}

export interface AiDelegateInput {
  /** Explicit session purpose; defaults to chat for ordinary new sessions. */
  mode?: SessionMode;
  /**
   * Issue to delegate. Omit for a free-form session: `goal` is then required and
   * the main process synthesizes a session key (the session is not bound to any
   * tracker issue).
   */
  issueKey?: string;
  connectionId?: string;
  /** Free-form goal for an issue-less session (the New Session composer path). */
  goal?: string;
  /** Task overrides; any omitted field falls back to a default built from the issue. */
  task?: Partial<AgentTaskDefinition>;
  /** Working directory the agent's local tools run in. Defaults to the app's cwd. */
  workingDirectory?: string;
  /** Provider override for this session; defaults to `settings.ai.activeProvider`. */
  provider?: AiProvider;
  /** Model id override for this session; omitted to use the selected provider's default. */
  model?: string;
  /** Host-enforced tool access for this session. Analysis always uses read-only. */
  toolMode?: AgentToolMode;
  /** Starts the issue's read-only analysis as the first turn of its normal chat session. */
  purpose?: 'analysis';
  /** Optional discovered runtime host and skills to use for this session. */
  agentId?: string;
  skillNames?: string[];
}

/**
 * AI slice: Vercel-gateway provider setup plus agent session lifecycle. The API
 * key lives in the OS-keychain secrets store and never crosses IPC — the
 * renderer only learns whether one is configured. Session updates stream back
 * over the `ai:sessionChanged` push channel.
 */
export interface AiIpc {
  /** Active provider's configuration snapshot — kept for back-compat callers. */
  getStatus(): Promise<AiProviderStatus>;
  /** Stores the active provider's API key encrypted; empty string clears it. */
  setApiKey(value: string): Promise<AiProviderStatus>;
  /** Every configured provider's status snapshot, for the settings UI and the session picker. */
  listProviderStatuses(): Promise<AiProviderStatus[]>;
  /**
   * The available models for a `hostKind: 'acp'` provider (Claude Code,
   * Codex), read live from the agent's `session/new` response — a
   * throwaway connection is spun up and immediately disposed, no prompt
   * sent. `undefined` for providers with no model selector (including
   * every non-ACP provider).
   */
  listCliModelOptions(provider: AiProvider): Promise<ModelOptions | undefined>;
  /**
   * The available models for a `kind: 'api'` provider (Vercel AI Gateway,
   * OpenAI, Anthropic), read from its real `/v1/models`-style endpoint and
   * cached (see `modelCatalog.ts`) — pass `forceRefresh: true` to bypass the
   * cache (e.g. a "Refresh" button). `undefined` when no API key is
   * configured or the fetch fails.
   */
  listApiModelOptions(provider: AiProvider, forceRefresh?: boolean): Promise<ModelOptions | undefined>;
  /** Stores a specific provider's API key encrypted; empty string clears it. */
  setProviderApiKey(provider: AiProvider, value: string): Promise<AiProviderStatus>;
  /** Clears all AI provider API keys so credentials can be re-entered after a keychain migration. */
  resetProviderApiKeys(): Promise<void>;
  /** Every persisted agent session, most recently started first. */
  listSessions(): Promise<AgentSessionRecord[]>;
  /** Renames a persisted session without changing its ticket binding or task goal. */
  renameSession(issueKey: string, title: string): Promise<AgentSessionRecord>;
  /** Aborts a running session if needed, then permanently removes its saved conversation. */
  deleteSession(issueKey: string): Promise<void>;
  /** Starts a general agent task for an issue; resolves with the new session record. */
  delegate(input: AiDelegateInput): Promise<AgentSessionRecord>;
  /** Aborts the running task for an issue (no-op when none is active). */
  abort(issueKey: string): Promise<void>;
  /** Sends a follow-up message and continues the existing recorded session. */
  continueSession(issueKey: string, message: string): Promise<void>;
  /** Switches the active phase of a session and continues it with that mode's contract. */
  switchSessionMode(issueKey: string, mode: SessionMode): Promise<void>;
  /**
   * Resolves the oldest pending permission request for an issue's active
   * task (no-op when none is pending). `'allow_always'` also resolves every
   * other request currently queued for that task.
   */
  respondToPermission(issueKey: string, decision: PermissionDecision): Promise<void>;
  /** Subscribes to session record updates; returns an unsubscribe function. */
  onSessionChanged(listener: (record: AgentSessionRecord) => void): () => void;
  /** Subscribes to session deletions; returns an unsubscribe function. */
  onSessionDeleted(listener: (issueKey: string) => void): () => void;

  // ── Workflow packs ────────────────────────────────────────────────────────
  /** Workflow packs discovered under `<workingDirectory>/.github/skills`. */
  listWorkflowPacks(): Promise<AgentWorkflowReference[]>;
  /** The workflow pack assigned to an issue, if any. */
  getWorkflowAssignment(issueKey: string): Promise<IssueWorkflowAssignment | undefined>;
  /** Assigns a workflow pack to an issue; `null` clears the assignment. */
  setWorkflowAssignment(issueKey: string, workflow: AgentWorkflowReference | null): Promise<void>;

  // ── Ticket review ─────────────────────────────────────────────────────────
  /** Runs the AI ticket review; streams `ai:reviewProgress` and resolves with the final markdown. */
  reviewIssue(
    issueKey: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<string>;
  /** Cancels a running review (no-op when none is active). */
  cancelReview(issueKey: string): Promise<void>;
  /** Subscribes to review progress; returns an unsubscribe function. */
  onReviewProgress(listener: (progress: AiReviewProgress) => void): () => void;

  // ── Local peer review ─────────────────────────────────────────────────────
  /**
   * Runs the three-section local peer review (code review, security review,
   * then a summarizing verdict). Resolves with the three markdown bodies.
   */
  localPeerReview(
    issueKey: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<LprResult>;
  /** Continues a local peer review with a follow-up question. */
  localPeerReviewFollowUp(
    issueKey: string,
    message: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<string>;

  // ── Issue analysis (chat) ─────────────────────────────────────────────────
  /** The persisted analysis conversation + confirmation state for an issue. */
  getAnalysis(issueKey: string): Promise<AiAnalysisState>;
  /**
   * Asks a question (empty string runs the base analysis) and streams the answer
   * into the state; every mutation pushes `ai:analysisChanged`.
   */
  submitAnalysis(
    issueKey: string,
    question: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<void>;
  /** Cancels a running analysis (no-op when none is active). */
  cancelAnalysis(issueKey: string): Promise<void>;
  /** Marks the analysis confirmed (or un-confirms it) for the delegation gate. */
  setAnalysisConfirmed(issueKey: string, confirmed: boolean): Promise<void>;
  /** Clears the stored analysis conversation for an issue. */
  clearAnalysis(issueKey: string): Promise<void>;
  /** Subscribes to analysis state updates; returns an unsubscribe function. */
  onAnalysisChanged(listener: (state: AiAnalysisState) => void): () => void;

  // ── Delivery / decomposition / merge requests ─────────────────────────────
  /** Starts the delivery workflow for an issue; validates delivery settings first. */
  startDelivery(issueKey: string, connectionId?: string): Promise<AgentSessionRecord>;
  /** Decomposes a feature-request issue into sub-tasks (created when the run completes). */
  decomposeFeature(issueKey: string, connectionId?: string): Promise<AgentSessionRecord>;
  /** Starts delivery of one decomposed sub-task of a feature issue. */
  startSubTaskDelivery(
    parentIssueKey: string,
    subTaskKey: string,
    connectionId?: string
  ): Promise<AgentSessionRecord>;
  /** Merge requests linked to the issue key (GitLab connections only). */
  listMergeRequests(issueKey: string, connectionId: string): Promise<GitLabMergeRequest[]>;
  /** Creates an MR for the issue's delivery branch; returns an existing open one when present. */
  createMergeRequest(issueKey: string, connectionId: string): Promise<GitLabMergeRequest>;
  /** Starts a feedback-addressing session when the open MR has new human notes. */
  checkMergeRequestFeedback(
    issueKey: string,
    connectionId: string
  ): Promise<{ started: boolean; noteCount: number }>;
}

export interface TicketManagerIpc {
  app: AppIpc;
  board: BoardIpc;
  issue: IssueIpc;
  connection: ConnectionIpc;
  userWorkspace: UserWorkspaceIpc;
  liveFolder: LiveFolderIpc;
  window: WindowIpc;
  settings: SettingsIpc;
  log: LogIpc;
  dialog: DialogIpc;
  shell: ShellIpc;
  boardPrefs: BoardPrefsIpc;
  ai: AiIpc;
  agentRuntime: AgentRuntimeIpc;
  taskDesigner: TaskDesignerIpc;
  projects: ProjectsIpc;
  terminal: TerminalIpc;
  git: GitIpc;
}

/** Discovery and skill-registry status for the desktop runtime. */
export interface AgentRuntimeIpc {
  list(): Promise<AgentRuntimeSnapshot>;
  refresh(): Promise<AgentRuntimeSnapshot>;
  start(agentId: string): Promise<AgentRuntimeSnapshot>;
  activateSkill(agentId: string, skillName: string): Promise<ActivatedSkill>;
}

// ── Integrated terminal ─────────────────────────────────────────────────────

export interface CreateTerminalInput {
  cwd?: string;
  cols: number;
  rows: number;
  profileId?: string;
  /** Reuse an active matching terminal during automatic panel initialisation. */
  reuseExisting?: boolean;
}

export interface TerminalProfile {
  id: string;
  name: string;
  shell: string;
  isDefault: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  profileId: string;
  profileName: string;
  hasContext: boolean;
  exited: boolean;
  lastCommand?: TerminalCommandRecord;
}

export interface TerminalCommandRecord {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  output: string;
  status: 'running' | 'success' | 'failed';
}

export interface TerminalCommandEvent {
  sessionId: string;
  command: TerminalCommandRecord;
}

export interface TerminalContext {
  sessionId: string;
  cwd: string;
  /** ANSI-free recent output, capped main-side before it crosses IPC. */
  output: string;
  capturedAt: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface TerminalContextAvailabilityEvent {
  sessionId: string;
  terminalHasContext: boolean;
}

export interface TerminalIpc {
  listProfiles(): Promise<TerminalProfile[]>;
  list(): Promise<TerminalSessionInfo[]>;
  create(input: CreateTerminalInput): Promise<TerminalSessionInfo>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  kill(sessionId: string): Promise<void>;
  /** Raw xterm stream used to redraw a preserved terminal after the panel reopens. */
  getBuffer(sessionId: string): Promise<string>;
  getContext(sessionId: string): Promise<TerminalContext>;
  listCommands(sessionId: string): Promise<TerminalCommandRecord[]>;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onContextAvailability(listener: (event: TerminalContextAvailabilityEvent) => void): () => void;
  onCommand(listener: (event: TerminalCommandEvent) => void): () => void;
}

export interface GitIpc {
  preflight(repositoryPath?: string): Promise<GitRepositoryPreflight>;
  initialize(repositoryPath: string): Promise<GitRepositoryPreflight>;
  clone(repositoryUrl: string, targetParent: string, targetName?: string): Promise<GitRepositoryPreflight>;
  open(repositoryPath?: string): Promise<GitRepositorySnapshot>;
  refresh(repositoryPath: string): Promise<GitRepositorySnapshot>;
  status(repositoryPath: string): Promise<GitStatusSnapshot>;
  getCommit(repositoryPath: string, hash: string): Promise<GitCommitDetails>;
  getDiff(repositoryPath: string, hash: string, filePath?: string): Promise<GitDiffResult>;
  getComparison(repositoryPath: string, request: GitDiffRequest): Promise<GitDiffDocument>;
  applyHunk(repositoryPath: string, request: GitHunkActionRequest): Promise<GitStatusSnapshot>;
  stage(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstage(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  discard(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  commit(repositoryPath: string, message: string): Promise<GitRepositorySnapshot>;
  createBranch(repositoryPath: string, name: string, startPoint?: string): Promise<GitRepositorySnapshot>;
  checkout(repositoryPath: string, name: string): Promise<GitRepositorySnapshot>;
  deleteBranch(repositoryPath: string, name: string): Promise<GitRepositorySnapshot>;
  renameBranch(repositoryPath: string, oldName: string, newName: string): Promise<GitRepositorySnapshot>;
  merge(repositoryPath: string, source: string): Promise<GitRepositorySnapshot>;
  rebase(repositoryPath: string, target: string): Promise<GitRepositorySnapshot>;
  getConflict(repositoryPath: string, path: string): Promise<GitConflictFile>;
  resolveConflict(repositoryPath: string, path: string, resolution: GitConflictResolution): Promise<GitStatusSnapshot>;
  abortConflict(repositoryPath: string): Promise<GitRepositorySnapshot>;
  getFileHistory(repositoryPath: string, path: string, ref?: string): Promise<GitFileHistoryEntry[]>;
  getBlame(repositoryPath: string, path: string, ref?: string): Promise<GitBlameLine[]>;
  cherryPick(repositoryPath: string, commit: string): Promise<GitRepositorySnapshot>;
  revert(repositoryPath: string, commit: string): Promise<GitRepositorySnapshot>;
  stash(repositoryPath: string, message?: string): Promise<GitRepositorySnapshot>;
  popStash(repositoryPath: string): Promise<GitRepositorySnapshot>;
  pull(repositoryPath: string): Promise<GitRepositorySnapshot>;
  fetch(repositoryPath: string): Promise<GitRepositorySnapshot>;
  push(repositoryPath: string): Promise<GitRepositorySnapshot>;
}

// ── Task Designer ────────────────────────────────────────────────────────────

/** How a dropped issue relates to the main dropped issue (drives connector direction). */
export type TaskDesignerRelatedIssueRelation = 'dependsOn' | 'subTask';

export interface TaskDesignerResolvedIssueRelation {
  relation: TaskDesignerRelatedIssueRelation;
  sourceIssueKey: string;
  targetIssueKey: string;
}

/** Node payload without position/type — what the backend returns for one issue. */
export type TaskDesignerIssueNodePayload = Omit<TaskDesignerTicketNode, 'id' | 'x' | 'y' | 'type'>;

/**
 * Result of dropping an issue key onto the canvas: the main issue plus every
 * resolvable dependsOn/subTask neighbour, with the directed relations the
 * renderer turns into connectors.
 */
export interface TaskDesignerResolvedDroppedIssue {
  mainIssue: TaskDesignerIssueNodePayload;
  relatedIssues: Array<TaskDesignerIssueNodePayload & { relation: TaskDesignerRelatedIssueRelation }>;
  relations: TaskDesignerResolvedIssueRelation[];
}

/**
 * Outcome of persisting a canvas state. `ok:false` means the stored state did
 * NOT change to what was sent — `state` carries the corrective state the
 * renderer must adopt (normalization repair, or the previously persisted state
 * on a graph validation failure).
 */
export interface TaskDesignerSetStateResult {
  ok: boolean;
  warning?: string;
  state: TaskDesignerPersistedState;
}

/** Board-flow recommendation: the seeded nodes plus the gateway's ordering. */
export interface TaskDesignerBoardFlowRecommendation {
  boardName: string;
  nodes: TaskDesignerRecommendationNode[];
  recommendation: TaskDesignerFlowRecommendation;
}

/** Where the generated master-plan artifacts landed. */
export interface TaskDesignerMasterPlanResult {
  outputPath: string;
  generatedFeaturesPath: string;
  generatedFeatureCount: number;
  generatedStoryCount: number;
}

/**
 * Task Designer slice: canvas persistence plus the host-owned operations
 * (issue resolution for drops, AI flow recommendations, master-plan file
 * generation). Canvas state is scoped per connection+board. Operational
 * failures reject the promise (the renderer shows the message); only
 * `setState` uses a result envelope because it also carries corrective state.
 */
export interface TaskDesignerIpc {
  /** Loads the persisted canvas state (normalized + repaired on the way out). */
  getState(boardId: string, connectionId?: string): Promise<TaskDesignerPersistedState>;
  /** Persists a canvas state; rejects invalid payloads with corrective state. */
  setState(
    boardId: string,
    connectionId: string | undefined,
    state: TaskDesignerPersistedState
  ): Promise<TaskDesignerSetStateResult>;
  /** Resolves an issue key (drop target) plus its dependsOn/subTask neighbours. */
  resolveIssue(issueKey: string, connectionId?: string): Promise<TaskDesignerResolvedDroppedIssue>;
  /** AI flow recommendation over the current canvas ticket nodes. */
  recommendFlow(
    nodes: TaskDesignerRecommendationNode[],
    connectors: TaskDesignerRecommendationConnector[]
  ): Promise<TaskDesignerFlowRecommendation>;
  /** AI flow recommendation seeded from every issue on a board. */
  recommendBoardFlow(board: Board): Promise<TaskDesignerBoardFlowRecommendation>;
  /** Writes plans/master-plan.md + generated feature/story files under the working directory. */
  generateMasterPlan(
    boardId: string,
    connectionId: string | undefined,
    state: TaskDesignerPersistedState
  ): Promise<TaskDesignerMasterPlanResult>;
}
