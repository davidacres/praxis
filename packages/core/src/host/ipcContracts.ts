import type {
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
import type { IdentifiedPlanFolder } from '../livefolder/markdownPlanParser';
import type { AppSettings, AppSettingsPatch } from '../config/appSettings';
import type {
  AgentSessionRecord,
  AgentTaskDefinition,
  AgentWorkflowReference,
  IssueWorkflowAssignment
} from '../ai/agentTypes';
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
  /** Discovers plan folders under a picked folder — step 2 of the create-board wizard. */
  discoverPlans(folderPath: string): Promise<IdentifiedPlanFolder[]>;
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
  model?: string;
}

/** Where the effective Vercel gateway API key came from. */
export type AiKeySource = 'secret' | 'env' | 'none';

export interface AiProviderStatus {
  provider: 'vercel-gateway';
  /** True when a usable gateway API key exists (secret store or env fallback). */
  configured: boolean;
  keySource: AiKeySource;
  /** Effective gateway URL — the configured value or the shipped default. */
  gatewayUrl: string;
  defaultModel: string;
  agentName: string;
  /** Issue keys with a currently running agent task. */
  activeTasks: string[];
}

export interface AiDelegateInput {
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
}

/**
 * AI slice: Vercel-gateway provider setup plus agent session lifecycle. The API
 * key lives in the OS-keychain secrets store and never crosses IPC — the
 * renderer only learns whether one is configured. Session updates stream back
 * over the `ai:sessionChanged` push channel.
 */
export interface AiIpc {
  /** Provider configuration snapshot for the settings UI. */
  getStatus(): Promise<AiProviderStatus>;
  /** Stores the gateway API key encrypted; empty string clears it. */
  setApiKey(value: string): Promise<AiProviderStatus>;
  /** Every persisted agent session, most recently started first. */
  listSessions(): Promise<AgentSessionRecord[]>;
  /** Starts a general agent task for an issue; resolves with the new session record. */
  delegate(input: AiDelegateInput): Promise<AgentSessionRecord>;
  /** Aborts the running task for an issue (no-op when none is active). */
  abort(issueKey: string): Promise<void>;
  /** Subscribes to session record updates; returns an unsubscribe function. */
  onSessionChanged(listener: (record: AgentSessionRecord) => void): () => void;

  // ── Workflow packs ────────────────────────────────────────────────────────
  /** Workflow packs discovered under `<workingDirectory>/.github/skills`. */
  listWorkflowPacks(): Promise<AgentWorkflowReference[]>;
  /** The workflow pack assigned to an issue, if any. */
  getWorkflowAssignment(issueKey: string): Promise<IssueWorkflowAssignment | undefined>;
  /** Assigns a workflow pack to an issue; `null` clears the assignment. */
  setWorkflowAssignment(issueKey: string, workflow: AgentWorkflowReference | null): Promise<void>;

  // ── Ticket review ─────────────────────────────────────────────────────────
  /** Runs the AI ticket review; streams `ai:reviewProgress` and resolves with the final markdown. */
  reviewIssue(issueKey: string, connectionId?: string): Promise<string>;
  /** Cancels a running review (no-op when none is active). */
  cancelReview(issueKey: string): Promise<void>;
  /** Subscribes to review progress; returns an unsubscribe function. */
  onReviewProgress(listener: (progress: AiReviewProgress) => void): () => void;

  // ── Local peer review ─────────────────────────────────────────────────────
  /**
   * Runs the three-section local peer review (code review, security review,
   * then a summarizing verdict). Resolves with the three markdown bodies.
   */
  localPeerReview(issueKey: string, connectionId?: string): Promise<LprResult>;

  // ── Issue analysis (chat) ─────────────────────────────────────────────────
  /** The persisted analysis conversation + confirmation state for an issue. */
  getAnalysis(issueKey: string): Promise<AiAnalysisState>;
  /**
   * Asks a question (empty string runs the base analysis) and streams the answer
   * into the state; every mutation pushes `ai:analysisChanged`.
   */
  submitAnalysis(issueKey: string, question: string, connectionId?: string): Promise<void>;
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
  taskDesigner: TaskDesignerIpc;
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
