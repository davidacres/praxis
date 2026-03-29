export type ConnectionType = 'stdio' | 'http';
export type BackendMode = 'jira' | 'demo' | 'file';
export type AssigneeMode = 'me' | 'all';
export type GroupingMode = 'project' | 'status' | 'none';

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

export interface HttpConnectionConfig extends BaseConnectionConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
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
  projectKey?: string;
  projectName?: string;
  locationName?: string;
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

export interface ParentIssueReference {
  key: string;
  summary?: string;
  issueType?: string;
  description?: string;
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
  priority?: string;
  created?: string;
  updated?: string;
  selfUrl?: string;
  browseUrl?: string;
  description?: string;
  raw?: unknown;
}

export interface IssueDetails extends IssueSummary {
  transitions?: WorkflowTransition[];
  comments?: IssueComment[];
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
  parentKey?: string;
  boardId?: string;
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string;
  parentKey?: string | null;
  assignee?: string | null;
  priority?: string;
  issueType?: string;
}

export interface ParentItemQueryOptions {
  childIssueType?: string;
}

export interface UpdateBoardInput {
  name?: string;
}

export interface CreateBoardInput {
  name: string;
  projectKey: string;
}

export interface IssueFilters {
  projectKeys: string[];
  statuses: string[];
  issueTypes: string[];
  searchText: string;
  assigneeMode: AssigneeMode;
  parentKey?: string;
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
}

export interface PagedIssues {
  issues: IssueSummary[];
  total?: number;
  hasMore: boolean;
}

export interface JiraCapabilities {
  getProjects: string;
  searchIssues: string;
  getIssue: string;
  getTransitions: string;
  transitionIssue: string;
  createIssue?: string;
  updateIssue?: string;
  deleteIssue?: string;
  addComment?: string;
  getAgileBoards?: string;
  getBoardIssues?: string;
}

export interface CapabilityResolution {
  capabilities?: JiraCapabilities;
  missing: Array<keyof JiraCapabilities>;
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

export interface ConfigureConnectionResult {
  saved: boolean;
  description: string;
}
