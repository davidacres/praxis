import {
  JiraMcpConnectionResolver
} from '@praxis/core';
import type {
  Connection,
  ConnectionType,
  JiraConfigStore,
  JiraMcpSettingsSource
} from '@praxis/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `JiraConfigStore` + `JiraMcpSettingsSource` backed by a single desktop
 * connection's `settings` record (the same keys the extension's
 * connection-scoped store maps). Board renames/JQL edits made through
 * `updateBoard` persist back into the connection via `persistSettings`.
 */
export class DesktopJiraConfigProvider implements JiraConfigStore, JiraMcpSettingsSource {
  public constructor(
    private readonly connection: Connection,
    private readonly persistSettings?: (patch: Record<string, unknown>) => Promise<void>
  ) {
    if (!isRecord(this.connection.settings)) {
      this.connection.settings = {};
    }
  }

  private get settings(): Record<string, unknown> {
    return this.connection.settings as Record<string, unknown>;
  }

  /** Persists a patch and applies it to the local snapshot so subsequent reads agree. */
  private async applyPatch(patch: Record<string, unknown>): Promise<void> {
    Object.assign(this.settings, patch);
    await this.persistSettings?.(patch);
  }

  private str(key: string): string {
    const value = this.settings[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  private num(key: string, fallback: number): number {
    const value = this.settings[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private strList(key: string): string[] {
    const value = this.settings[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    // The connection form stores multi-value fields as newline-joined text.
    if (typeof value === 'string') {
      return value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    }
    return [];
  }

  private strRecord(...keys: string[]): Record<string, string> {
    for (const key of keys) {
      const value = this.settings[key];
      if (isRecord(value) && !Array.isArray(value)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string') {
            out[k] = v;
          }
        }
        return out;
      }
    }
    return {};
  }

  // ── JiraMcpSettingsSource ─────────────────────────────────────────────────

  public getConnectionType(): ConnectionType {
    return this.str('connectionType') === 'http' ? 'http' : 'stdio';
  }

  public getStdioCommand(): string {
    return this.str('stdioCommand');
  }

  public getStdioArgs(): string[] {
    return this.strList('stdioArgs');
  }

  public getStdioCwd(): string {
    return this.str('stdioCwd');
  }

  public getHttpUrl(): string {
    return this.str('httpUrl');
  }

  public getWorkspaceMcpServerName(): string {
    return this.str('workspaceMcpServerName');
  }

  public getUserMcpServerRef(): string {
    return this.str('userMcpServerRef');
  }

  public getCustomEnv(): Record<string, string> {
    return this.strRecord('env');
  }

  public getHttpHeaders(): Record<string, string> {
    return this.strRecord('httpHeaders', 'headers');
  }

  /**
   * API-token sign-in sends its own Authorization header, so a 401 means
   * "bad token" — suppress the interactive OAuth browser flow for it.
   */
  public getHttpAllowOAuth(): boolean {
    return this.settings['jiraAuthMethod'] === 'api-token' ? false : true;
  }

  /** Workspace folder used for `.vscode/mcp.json` discovery, if configured. */
  public getWorkspaceFolderPath(): string | undefined {
    return this.str('workspaceFolder') || undefined;
  }

  // ── JiraConfigStore ─────────────────────────────────────────────────────────

  public getDefaultPageSize(): number {
    return this.num('defaultPageSize', 25);
  }

  public getRequestTimeoutMs(): number {
    return this.num('requestTimeoutMs', 30000);
  }

  public async hasJiraMcpConfigPublic(): Promise<boolean> {
    const resolver = new JiraMcpConnectionResolver(this, this, () => this.getWorkspaceFolderPath());
    return resolver.hasJiraMcpConfig();
  }

  public getJiraMcpSiteUrl(): string {
    return this.str('url');
  }

  public getJiraMcpEpicKey(): string {
    return this.str('epicKey');
  }

  public getJiraMcpEpicBoardName(): string {
    return this.str('epicBoardName');
  }

  public getJiraMcpBoardJql(): string {
    return this.str('boardJql');
  }

  public getJiraMcpBoardName(): string {
    return this.str('boardName');
  }

  public getJiraDefaultBaseUrl(): string {
    // No host-wide company default on desktop — the site URL field carries it.
    return this.str('defaultBaseUrl');
  }

  public getJiraDefaultProjectKey(): string {
    return this.str('defaultProjectKey');
  }

  public async setJiraMcpEpicBoardName(value: string | undefined): Promise<void> {
    await this.applyPatch({ epicBoardName: value?.trim() ?? '' });
  }

  public async setJiraMcpBoardJql(value: string | undefined): Promise<void> {
    await this.applyPatch({ boardJql: value?.trim() ?? '' });
  }

  public async setJiraMcpBoardName(value: string | undefined): Promise<void> {
    await this.applyPatch({ boardName: value?.trim() ?? '' });
  }
}
