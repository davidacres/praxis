import * as path from 'node:path';
import { getDesktopMcpOAuthManager } from './mcpOAuthManager';

const DEFAULT_JIRA_OAUTH_SCOPE = 'read:jira-work write:jira-work read:jira-user offline_access';

class DesktopFolderConfigProvider {
  constructor(private connection: any) {}
  getDefaultPageSize(): number { return 25; }
  getFolderRoots(): string[] {
    const s = this.connection.settings || {};
    if (Array.isArray(s.roots)) return s.roots.filter((r: any) => typeof r === 'string' && r.trim());
    if (typeof s.folderPath === 'string' && s.folderPath.trim()) return [s.folderPath.trim()];
    if (typeof s.path === 'string' && s.path.trim()) return [s.path.trim()];
    return [];
  }
  getFolderProjectKey(): string { return this.connection.settings?.projectKey || ''; }
  getFolderProjectName(): string { return this.connection.settings?.projectName || ''; }
  getFolderAllowIssueCreation(): boolean { return Boolean(this.connection.settings?.allowIssueCreation); }
  getAiDefaultModel(): string { return ''; }
  prefersConfiguredIdentity(): boolean { return typeof this.connection.settings?.projectId === 'string' || Boolean(this.connection.id?.startsWith('project:')); }
}

class DesktopGitHubConfigProvider {
  constructor(private connection: any) {}
  getDefaultPageSize(): number { return 25; }
  getGitHubApiUrl(): string { return (this.connection.settings?.url || '').trim(); }
  getGitHubOwner(): string { return this.connection.settings?.owner || ''; }
  getGitHubRepo(): string { return this.connection.settings?.repo || ''; }
  getGitHubApiKey(): string { return this.connection.settings?.pat || ''; }
  getGitHubAllowIssueCreation(): boolean { return this.connection.settings?.allowIssueCreation === true; }
}

class DesktopGitLabConfigProvider {
  constructor(private connection: any) {}
  getDefaultPageSize(): number { return 25; }
  getGitLabUrl(): string { return (this.connection.settings?.url || '').trim(); }
  getGitLabProjectPath(): string { return this.connection.settings?.projectPath || ''; }
  getGitLabListAllAccessibleBoards(): boolean { return this.connection.settings?.listAllAccessibleBoards === true; }
  getGitLabSelectedBoardRefs(): string[] {
    const v = this.connection.settings?.selectedBoardRefs;
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  }
  getGitLabApiKey(): string { return this.connection.settings?.apiKey || ''; }
  getGitLabAllowIssueCreation(): boolean { return this.connection.settings?.allowIssueCreation === true; }
}

class DesktopJiraConfigProvider {
  constructor(private connection: any) {}
  private get settings(): Record<string, unknown> {
    return this.connection.settings || {};
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
    if (typeof value === 'string') {
      return value.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    }
    return [];
  }
  private strRecord(...keys: string[]): Record<string, string> {
    for (const key of keys) {
      const value = this.settings[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string') out[k] = v;
        }
        return out;
      }
    }
    return {};
  }
  getConnectionType(): string {
    return this.str('connectionType') === 'http' ? 'http' : 'stdio';
  }
  getStdioCommand(): string { return this.str('stdioCommand'); }
  getStdioArgs(): string[] { return this.strList('stdioArgs'); }
  getStdioCwd(): string { return this.str('stdioCwd'); }
  getHttpUrl(): string { return this.str('httpUrl'); }
  getWorkspaceMcpServerName(): string { return this.str('workspaceMcpServerName'); }
  getUserMcpServerRef(): string { return this.str('userMcpServerRef'); }
  getCustomEnv(): Record<string, string> { return this.strRecord('env'); }
  getHttpHeaders(): Record<string, string> { return this.strRecord('httpHeaders', 'headers'); }
  getHttpAllowOAuth(): boolean {
    return this.settings['jiraAuthMethod'] === 'api-token' ? false : true;
  }
  getWorkspaceFolderPath(): string | undefined {
    return this.str('workspaceFolder') || undefined;
  }
  getDefaultPageSize(): number { return this.num('defaultPageSize', 25); }
  getRequestTimeoutMs(): number { return this.num('requestTimeoutMs', 30000); }
  async hasJiraMcpConfigPublic(): Promise<boolean> { return true; }
  getJiraMcpSiteUrl(): string { return this.str('url'); }
  getJiraMcpEpicKey(): string { return this.str('epicKey'); }
  getJiraMcpEpicBoardName(): string { return this.str('epicBoardName'); }
  getJiraMcpBoardJql(): string { return this.str('boardJql'); }
  getJiraMcpBoardName(): string { return this.str('boardName'); }
  getJiraDefaultBaseUrl(): string { return this.str('defaultBaseUrl'); }
  getJiraDefaultProjectKey(): string { return this.str('defaultProjectKey'); }
  async setJiraMcpEpicBoardName(value: string | undefined): Promise<void> { this.settings['epicBoardName'] = value?.trim() ?? ''; }
  async setJiraMcpBoardJql(value: string | undefined): Promise<void> { this.settings['boardJql'] = value?.trim() ?? ''; }
  async setJiraMcpBoardName(value: string | undefined): Promise<void> { this.settings['boardName'] = value?.trim() ?? ''; }
}

export class TrackerRegistry {
  private services = new Map<string, any>();
  private connections = new Map<string, any>();
  private secrets = new Map<string, Map<string, string>>();
  private onBoardChangedCb?: (connectionId: string) => void;
  public onPlanFileChangedCb?: (connectionId: string, filePath: string) => void;

  constructor(onBoardChanged?: (connectionId: string) => void) {
    this.onBoardChangedCb = onBoardChanged;
    getDesktopMcpOAuthManager();
  }

  public setSecret(connectionId: string, name: string, value: string | undefined): void {
    if (!this.secrets.has(connectionId)) {
      this.secrets.set(connectionId, new Map());
    }
    const map = this.secrets.get(connectionId)!;
    if (value === undefined) {
      map.delete(name);
    } else {
      map.set(name, value);
    }
    this.disposeConnection(connectionId);
  }

  public getSecret(connectionId: string, name: string): string | undefined {
    return this.secrets.get(connectionId)?.get(name);
  }

  public hasSecret(connectionId: string, name: string): boolean {
    const val = this.getSecret(connectionId, name);
    return val !== undefined && val.length > 0;
  }

  private async createService(connection: any): Promise<any> {
    const nullLogSink = { appendLine: (_line: string) => {} };
    let service: any;
    if (connection.mode === 'folder') {
      const { FolderService } = require('../../../packages/core/out/folder/folderService');
      service = new FolderService(new DesktopFolderConfigProvider(connection));
      if (typeof service.onDidReloadFromDisk === 'function') {
        service.onDidReloadFromDisk(() => {
          this.onBoardChangedCb?.(connection.id);
        });
      }
      if (typeof service.onDidChangePlanFile === 'function') {
        service.onDidChangePlanFile((filePath: string) => {
          this.onPlanFileChangedCb?.(connection.id, filePath);
        });
      }
    } else if (connection.mode === 'github') {
      const { GitHubBoardService } = require('../../../packages/core/out/github/githubBoardService');
      service = new GitHubBoardService(
        new DesktopGitHubConfigProvider(connection),
        nullLogSink,
        globalThis.fetch,
        { getApiKeyFromSecrets: async () => this.getSecret(connection.id, 'pat') || connection.settings?.pat || '' }
      );
    } else if (connection.mode === 'gitlab') {
      const { GitLabBoardService } = require('../../../packages/core/out/gitlab/gitLabBoardService');
      service = new GitLabBoardService(
        new DesktopGitLabConfigProvider(connection),
        nullLogSink,
        globalThis.fetch,
        undefined as any,
        { getApiKeyFromSecrets: async () => this.getSecret(connection.id, 'apiKey') || connection.settings?.apiKey || '' }
      );
    } else if (connection.mode === 'jiracloud') {
      const { JiraService } = require('../../../packages/core/out/jira/jiraService');
      const { JiraMcpConnectionResolver } = require('../../../packages/core/out/jira/jiraMcpConnectionResolver');
      const provider = new DesktopJiraConfigProvider(connection);
      const resolver = new JiraMcpConnectionResolver(
        provider,
        provider,
        () => provider.getWorkspaceFolderPath()
      );
      try {
        const resolution = await resolver.resolve();
        if (resolution) {
          if (connection.settings?.jiraAuthMethod === 'api-token' && resolution.config.type === 'http') {
            const email = String(connection.settings.jiraApiEmail ?? '').trim();
            const token = this.getSecret(connection.id, 'jiraApiToken');
            if (email && token) {
              resolution.config.headers = {
                ...resolution.config.headers,
                Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
              };
            }
          }
          if (resolution.config.type === 'http') {
            const clientId = String(connection.settings?.jiraOAuthClientId ?? '').trim();
            if (clientId) {
              const clientSecret = this.getSecret(connection.id, 'jiraOAuthClientSecret')?.trim();
              const redirectUrl = String(connection.settings?.jiraOAuthRedirectUrl ?? '').trim();
              const scope =
                String(connection.settings?.jiraOAuthScope ?? '').trim() || DEFAULT_JIRA_OAUTH_SCOPE;
              const issuer =
                String(connection.settings?.jiraOAuthIssuer ?? '').trim() || 'https://auth.atlassian.com';
              resolution.config.oauthClient = {
                clientId,
                ...(clientSecret ? { clientSecret } : {}),
                ...(redirectUrl ? { redirectUrl } : {}),
                scope,
                extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
                authorizationServer: {
                  issuer,
                  authorizationEndpoint:
                    String(connection.settings?.jiraOAuthAuthorizationEndpoint ?? '').trim() ||
                    `${issuer}/authorize`,
                  tokenEndpoint:
                    String(connection.settings?.jiraOAuthTokenEndpoint ?? '').trim() ||
                    `${issuer}/oauth/token`
                }
              };
            }
          }
          service = new JiraService(provider, nullLogSink, resolution);
        }
      } catch (err) {
        console.warn('TrackerRegistry: failed to resolve Jira MCP connection', connection.id, err);
      }
    } else if (connection.mode === 'demo') {
      const { DemoService } = require('../../../packages/core/out/demo/demoService');
      service = new DemoService({ getDefaultPageSize: () => 25 });
    }
    return service;
  }

  public async registerConnection(connection: any): Promise<any[]> {
    if (!connection || !connection.id) return [];
    this.connections.set(connection.id, connection);
    this.disposeConnection(connection.id);

    const service = await this.createService(connection);
    if (service) {
      this.services.set(connection.id, service);
      try {
        const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
        return boards.map((b: any) => ({
          ...b,
          connectionId: connection.id
        }));
      } catch (err) {
        // Warning is expected if auth has not been performed yet
      }
    }
    return [];
  }

  public disposeConnection(connectionId: string) {
    const s = this.services.get(connectionId);
    if (s) {
      try { s.dispose?.(); } catch {}
      this.services.delete(connectionId);
    }
  }

  public disposeAll() {
    for (const [, s] of this.services) {
      try { s.dispose?.(); } catch {}
    }
    this.services.clear();
    this.connections.clear();
    this.secrets.clear();
  }

  public hasService(connectionId?: string): boolean {
    if (connectionId && this.services.has(connectionId)) return true;
    return this.services.size > 0;
  }

  public async getService(connectionId?: string): Promise<any> {
    if (connectionId && this.services.has(connectionId)) {
      return this.services.get(connectionId);
    }
    if (connectionId && this.connections.has(connectionId)) {
      const service = await this.createService(this.connections.get(connectionId));
      if (service) {
        this.services.set(connectionId, service);
        return service;
      }
    }
    if (this.services.size === 1) {
      return Array.from(this.services.values())[0];
    }
    return null;
  }

  public async call(connectionId: string | undefined, method: string, ...args: any[]): Promise<any> {
    const service = await this.getService(connectionId);
    if (!service || typeof service[method] !== 'function') {
      return null;
    }
    return await service[method](...args);
  }
}
