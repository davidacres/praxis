import type {
  Board,
  BoardDetails,
  BoardFilters,
  Connection,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  ParentItemQueryOptions,
  Project,
  TrackedBoard,
  UpdateIssueInput
} from '../types';
import type { IdentifiedPlanFolder } from '../livefolder/markdownPlanParser';
import type { AppSettings, AppSettingsPatch } from '../config/appSettings';

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
 * Native dialogs. The renderer is sandboxed, so anything the OS must own
 * (file/folder pickers) goes through here.
 */
export interface DialogIpc {
  /** Native folder picker; resolves to the chosen path, or undefined when cancelled. */
  pickFolder(title?: string): Promise<string | undefined>;
}

export interface TicketManagerIpc {
  board: BoardIpc;
  issue: IssueIpc;
  connection: ConnectionIpc;
  userWorkspace: UserWorkspaceIpc;
  liveFolder: LiveFolderIpc;
  window: WindowIpc;
  settings: SettingsIpc;
  dialog: DialogIpc;
}
