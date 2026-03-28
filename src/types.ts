export type ConnectionType = 'stdio' | 'http';
export type BackendMode = 'jira' | 'demo';
export type AssigneeMode = 'me' | 'all';
export type GroupingMode = 'project' | 'status' | 'none';
export type EpicQueryMode = 'parent' | 'parentEpic';

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

export interface JiraProject {
  id?: string;
  key: string;
  name: string;
}

export interface JiraBoard {
  id: string;
  name: string;
  type: string;
  projectKey?: string;
  projectName?: string;
  locationName?: string;
  raw?: unknown;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatus?: string;
  raw?: unknown;
}

export interface JiraIssueSummary {
  id?: string;
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType: string;
  projectKey: string;
  projectName?: string;
  assignee?: string;
  priority?: string;
  updated?: string;
  selfUrl?: string;
  browseUrl?: string;
  description?: string;
  raw?: unknown;
}

export interface JiraIssueDetails extends JiraIssueSummary {
  transitions?: JiraTransition[];
}

export interface JiraFilters {
  projectKeys: string[];
  statuses: string[];
  issueTypes: string[];
  searchText: string;
  assigneeMode: AssigneeMode;
  epicKey?: string;
  grouping: GroupingMode;
}

export interface JiraBoardFilters {
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
  epicKey?: string;
  lastSelectedIssueKey?: string;
}

export interface PersistedBoardFilterState {
  projectKeys: string[];
  types: string[];
  searchText: string;
  lastSelectedBoardId?: string;
}

export interface PagedIssues {
  issues: JiraIssueSummary[];
  total?: number;
  hasMore: boolean;
}

export interface JiraCapabilities {
  getProjects: string;
  searchIssues: string;
  getIssue: string;
  getTransitions: string;
  transitionIssue: string;
  getAgileBoards?: string;
  getBoardIssues?: string;
}

export interface CapabilityResolution {
  capabilities?: JiraCapabilities;
  missing: Array<keyof JiraCapabilities>;
}

export interface JiraConnectionCheck {
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

export interface JiraBoardColumn {
  id: string;
  name: string;
  statusCategory?: string;
  issues: JiraIssueSummary[];
}

export interface JiraBoardDetails {
  board: JiraBoard;
  columns: JiraBoardColumn[];
  issues: JiraIssueSummary[];
  /**
   * Optional canonical status column order for this board (e.g. workflow). When set, the board
   * shows a column for each status even if no issues are in that status. Jira backends omit this
   * until board/workflow metadata is available; demo mode supplies it.
   */
  columnStatusOrder?: string[];
}

/** Per-board column layout. `orderedStatuses` empty = show every status column in default order. */
export interface BoardColumnPreferences {
  orderedStatuses: string[];
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
