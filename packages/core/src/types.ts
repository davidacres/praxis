export type ConnectionType = 'stdio' | 'http';
/**
 * How a board's issues are stored and reached.
 *
 * `app` is Praxis's own local work-item backend. It is a normal connection
 * mode, just like folder, GitLab, or Jira. `project` is retained solely so
 * legacy saved records can be migrated to `app` or `folder` on startup.
 */
export type BackendMode =
  | 'jiracloud'
  | 'demo'
  | 'github'
  | 'gitlab'
  | 'folder'
  | 'app'
  /** @deprecated migrated on startup; never create new project-mode connections. */
  | 'project';
export type AssigneeMode = 'me' | 'all';
export type GroupingMode = 'project' | 'status' | 'none';
export type AiProvider = 'vercel-gateway' | 'openai' | 'anthropic' | 'gemini' | 'z-ai' | 'claude-code-cli' | 'codex-cli' | 'copilot-cli' | 'antigravity-cli';

export interface AiAssignment {
  provider: AiProvider;
  label?: string;
  sessionId: string;
  assignedAt: string; // ISO timestamp
  status: 'active' | 'completed' | 'failed';
  boardId?: string;
}

export interface AiAgentRegistration {
  name: string;
  provider: AiProvider;
  apiKey: string;
}

export interface DeliveryWorkflowSettings {
  enabled: boolean;
  publishCommand: string;
  artifactPattern: string;
  agentWorkflowPath?: string;
  agentWorkflowUrl?: string;
  summaryTemplate?: string;
  failureTemplate?: string;
}

export interface SecretConnectionValues {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface BaseConnectionConfig {
  timeoutMs: number;
}

export interface StdioConnectionConfig extends BaseConnectionConfig {
  type: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

/**
 * Pre-registered OAuth client credentials for servers where dynamic client
 * registration is unavailable or blocked (e.g. an org-restricted Atlassian
 * site that only trusts org-registered 3LO apps). When present, the host's
 * OAuth provider skips DCR and authenticates with these credentials instead.
 */
export interface OAuthClientOverride {
  clientId: string;
  /** Confidential-client secret; omit for public (PKCE-only) apps. */
  clientSecret?: string;
  /** Redirect URL registered on the app; defaults to the host's own callback. */
  redirectUrl?: string;
  /** Scope string for the authorize request (e.g. Atlassian 3LO scopes). */
  scope?: string;
  /**
   * Extra query params the authorization server requires on /authorize beyond
   * the OAuth-standard set — e.g. Atlassian 3LO mandates
   * `{ audience: 'api.atlassian.com', prompt: 'consent' }` and answers with a
   * generic "internal error" page when audience is missing.
   */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * Overrides the authorization-server endpoints the SDK would otherwise
   * discover from the MCP server. Needed when the MCP server's own AS only
   * knows its dynamically-registered clients — e.g. Atlassian's MCP server
   * 500s on console-registered 3LO client ids, so those must authorize
   * against `https://auth.atlassian.com` instead.
   */
  authorizationServer?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
  };
}

export interface HttpConnectionConfig extends BaseConnectionConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  /**
   * When false, a 401 from this server surfaces as a plain error instead of
   * triggering the interactive OAuth browser flow. Used by API-token setups,
   * where a 401 means "bad token", not "please sign in".
   */
  allowOAuth?: boolean;
  /** Pre-registered OAuth client to use instead of dynamic registration. */
  oauthClient?: OAuthClientOverride;
}

export type ConnectionConfig = StdioConnectionConfig | HttpConnectionConfig;
export type ConnectionSource = 'manual' | 'workspaceMcp' | 'userMcp';

export interface ResolvedConnectionConfig {
  config: ConnectionConfig;
  source: ConnectionSource;
  description: string;
}

export interface WorkspaceMcpCandidate {
  serverName: string;
  label: string;
  sourcePath: string;
  isJiraLike: boolean;
  config: ConnectionConfig;
}

export interface Project {
  id?: string;
  key: string;
  name: string;
}

export interface Board {
  id: string;
  name: string;
  type: string;
  /** Board creator when the backend exposes it. */
  createdBy?: string;
  /** Board creation timestamp when the backend exposes it. */
  createdAt?: string;
  projectKey?: string;
  projectName?: string;
  locationName?: string;
  /** Optional id of the connection this board came from (multi-connection mode). */
  connectionId?: string;
  /** Availability of a locally-backed board; missing boards remain visible so they can be removed. */
  availability?: 'available' | 'missing';
  availabilityMessage?: string;
  raw?: unknown;
}

export interface WorkflowTransition {
  id: string;
  name: string;
  toStatus?: string;
  raw?: unknown;
}

export interface IssueComment {
  id?: string;
  author?: string;
  body: string;
  created?: string;
  updated?: string;
  raw?: unknown;
}

export interface IssueAttachment {
  id?: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  contentUrl?: string;
  thumbnailUrl?: string;
  created?: string;
  author?: string;
  raw?: unknown;
}

export interface ParentIssueReference {
  key: string;
  summary?: string;
  issueType?: string;
  description?: string;
}

export interface LinkedIssueReference {
  key: string;
  summary?: string;
  issueType?: string;
  status?: string;
  relationship: string;
  browseUrl?: string;
  raw?: unknown;
}

export interface SubTaskSummary {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType: string;
  assignee?: string;
}

export interface IssueSummary {
  id?: string;
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType: string;
  projectKey: string;
  projectName?: string;
  parentKey?: string;
  parentIssue?: ParentIssueReference;
  assignee?: string;
  reporter?: string;
  reporterMention?: string;
  priority?: string;
  severity?: string;
  reportedBy?: string;
  complexity?: string;
  model?: string;
  created?: string;
  updated?: string;
  selfUrl?: string;
  browseUrl?: string;
  description?: string;
  ideaTranscript?: string;
  /** Issue keys this ticket depends on (same plan); used for execution ordering and links. */
  dependsOn?: string[];
  /** Git branch name for this work item when known (e.g. from import or tooling). */
  branch?: string;
  /** When the work was completed (distinct from `updated`). */
  completed?: string;
  attachments?: IssueAttachment[];
  /** AI agent assignment tracking for this issue. */
  aiAssignment?: AiAssignment;
  /** Sub-tasks linked to this issue (populated for feature requests). */
  subTasks?: SubTaskSummary[];
  /**
   * Stable order among sibling children under the same `parentKey` (e.g. a
   * story's sequence within its feature). Folder mode derives this from the
   * child file's numeric segment; backends with no such concept leave it
   * unset, and consumers fall back to another stable sort (e.g. `key`).
   */
  childSeq?: number;
  raw?: unknown;
}

export interface IssueDetails extends IssueSummary {
  transitions?: WorkflowTransition[];
  comments?: IssueComment[];
  linkedIssues?: LinkedIssueReference[];
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
  ideaTranscript?: string;
  parentKey?: string;
  boardId?: string;
  /**
   * folder-backed only: when `parentKey` is absent and this is
   * non-empty, the service creates a Feature with this summary first, then
   * creates the requested item under it. Ignored by other backends.
   */
  newParentSummary?: string;
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string;
  ideaTranscript?: string;
  parentKey?: string | null;
  assignee?: string | null;
  priority?: string;
  severity?: string;
  reportedBy?: string;
  model?: string;
  issueType?: string;
}

export interface ParentItemQueryOptions {
  childIssueType?: string;
}

export interface UpdateBoardInput {
  name?: string;
  jql?: string;
}

export interface CreateBoardInput {
  name: string;
  projectKey: string;
  projectName?: string;
  liveFolderPath?: string;
}

export interface IssueFilters {
  projectKeys: string[];
  statuses: string[];
  issueTypes: string[];
  searchText: string;
  assigneeMode: AssigneeMode;
  parentKey?: string;
  boardId?: string;
  grouping: GroupingMode;
}

export interface BoardFilters {
  projectKeys: string[];
  types: string[];
  searchText: string;
}

export interface PersistedFilterState {
  projectKeys: string[];
  statuses: string[];
  issueTypes: string[];
  searchText: string;
  assigneeMode: AssigneeMode;
  parentKey?: string;
  lastSelectedIssueKey?: string;
}

export interface PersistedBoardFilterState {
  projectKeys: string[];
  types: string[];
  searchText: string;
  lastSelectedBoardId?: string;
  lastSelectedConnectionId?: string;
}

/**
 * A named backend connection. Each connection is one configured backend
 * instance (e.g. one Jira server, one GitLab host, one folder connection).
 * `settings` is mode-specific; see ConnectionStore for the per-mode shape.
 */
export interface Connection {
  id: string;
  name: string;
  mode: BackendMode;
  settings: Record<string, unknown>;
}

/**
 * A board the user has explicitly chosen to track. References a Connection
 * by id and a board id native to that connection's backend.
 */
export interface TrackedBoard {
  connectionId: string;
  boardId: string;
  displayName?: string;
}

export interface TrackedBoardRef {
  connectionId: string;
  boardId: string;
}

export interface PagedIssues {
  issues: IssueSummary[];
  total?: number;
  hasMore: boolean;
}

export interface ConnectionCheck {
  status: 'ok' | 'warning' | 'error';
  message: string;
  toolCount: number;
  projectCount?: number;
  serverName?: string;
}

export interface FilterMetadata {
  statuses: string[];
  issueTypes: string[];
}

export interface BoardColumn {
  id: string;
  name: string;
  statusCategory?: string;
  issues: IssueSummary[];
}

export interface BoardDetails {
  board: Board;
  columns: BoardColumn[];
  issues: IssueSummary[];
  /**
   * Optional canonical status column order for this board (e.g. workflow). When set, the board
   * shows a column for each status even if no issues are in that status.
   */
  columnStatusOrder?: string[];
}

/** Per-board column layout. `orderedStatuses` empty = show every status column in default order. */
export interface BoardColumnPreferences {
  workflowStatuses: string[];
  orderedStatuses: string[];
  /** Optional hex color (e.g. #aabbcc) for the project/location pill on the board list row. */
  projectPillColor?: string;
  /** When set to assignee or epic, the board panel renders horizontal swim lanes. */
  swimLaneGroupBy?: 'none' | 'assignee' | 'epic';
  /** Case-insensitive substring filter on assignee display name. */
  issueFilterAssignee?: string;
  /** Case-insensitive match on parent epic key or parent summary. */
  issueFilterEpicKey?: string;
  /** When non-empty, only issues whose status is in this list are shown. */
  issueFilterStatuses?: string[];
  /** Per-status column dot color; key is exact status name as on the board. */
  statusColors?: Record<string, string>;
  /** Per-issue-type card and pill color; key is exact issue type label on the board. */
  issueTypeColors?: Record<string, string>;
  /** Board panel layout: Kanban columns or grouped list view. */
  viewMode?: 'board' | 'list';
  /** List-view group order by exact status name. */
  listGroupOrder?: string[];
  /** Hide issues not updated within this many weeks; 0 shows all issues regardless of age. */
  maxAgeWeeks?: number;
  /** Per-column card order for visual priority; key is status name, value is ordered issue keys. */
  issueOrder?: Record<string, string[]>;
  /**
   * Suppress the surface-pack material (texture, watermark, tint, glass) behind
   * this board so dense content stays legible. The colour theme still applies —
   * the board just sits on a flat elevated fill instead of the material.
   */
  plainSurface?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
}

export interface ToolCallPayload {
  raw: unknown;
  value: unknown;
  textBlocks: string[];
}
