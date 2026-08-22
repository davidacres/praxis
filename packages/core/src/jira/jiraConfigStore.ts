import type { ConnectionType } from '../types';

/**
 * Host-neutral slice of the extension's `AppConfigStore` that `JiraService`
 * actually reads/writes. The extension satisfies this with its
 * `workspace.getConfiguration`-backed store (a structural superset); the
 * desktop host satisfies it with an adapter over a connection's `settings`
 * record.
 */
export interface JiraConfigStore {
  getDefaultPageSize(): number;
  getRequestTimeoutMs(): number;
  hasJiraMcpConfigPublic(): Promise<boolean>;
  getJiraMcpSiteUrl(): string;
  getJiraMcpEpicKey(): string;
  getJiraMcpEpicBoardName(): string;
  getJiraMcpBoardJql(): string;
  getJiraMcpBoardName(): string;
  getJiraDefaultBaseUrl(): string;
  getJiraDefaultProjectKey(): string;
  setJiraMcpEpicBoardName(value: string | undefined): Promise<void>;
  setJiraMcpBoardJql(value: string | undefined): Promise<void>;
  setJiraMcpBoardName(value: string | undefined): Promise<void>;
}

/**
 * Raw Jira MCP connection settings consumed by `JiraMcpConnectionResolver`.
 * The extension sources these from `vscode.workspace.getConfiguration`
 * (including a scan of every configured connection's env/headers); the desktop
 * host sources them from the single connection being resolved.
 */
export interface JiraMcpSettingsSource {
  getConnectionType(): ConnectionType;
  getStdioCommand(): string;
  getStdioArgs(): string[];
  getStdioCwd(): string;
  getHttpUrl(): string;
  getWorkspaceMcpServerName(): string;
  getUserMcpServerRef(): string;
  /** Extra environment variables merged into a stdio server's environment. */
  getCustomEnv(): Record<string, string>;
  /** Extra request headers for HTTP servers. */
  getHttpHeaders(): Record<string, string>;
  /**
   * Optional OAuth gate for HTTP servers: when it returns false, a 401
   * surfaces as a plain error instead of starting the interactive OAuth
   * browser flow (used by API-token connections). Absent/undefined = OAuth
   * allowed (the extension's behavior).
   */
  getHttpAllowOAuth?(): boolean;
}
