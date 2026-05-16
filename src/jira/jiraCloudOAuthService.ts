import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AppConfigStore } from '../config/jiraConfig';
import { initializeMcpOAuthManager } from '../mcp/oauthManager';

const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const JIRA_CLOUD_CALLBACK_PATH = '/jira-cloud-auth-callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 2 * 60 * 1000;
const CLIENT_SECRET_KEY = 'ticketManager.jiraCloudOAuth.clientSecret';
const TOKENS_KEY = 'ticketManager.jiraCloudOAuth.tokens';

interface PendingAuthorization {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  state: string;
  timer: ReturnType<typeof setTimeout>;
}

interface JiraOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

export interface JiraCloudResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
  avatarUrl?: string;
}

interface AtlassianTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function parseJsonValue<T>(value: string | undefined): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseAccessibleResources(value: unknown): JiraCloudResource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => {
      if (!isRecord(item)) {
        return undefined;
      }

      const id = asString(item.id)?.trim();
      const name = asString(item.name)?.trim();
      const url = asString(item.url)?.trim();
      const scopes = Array.isArray(item.scopes)
        ? item.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [];
      if (!id || !name || !url || !scopes.some(scope => scope.includes('jira'))) {
        return undefined;
      }

      const resource: JiraCloudResource = {
        id,
        name,
        url,
        scopes
      };
      const avatarUrl = asString(item.avatarUrl);
      if (avatarUrl) {
        resource.avatarUrl = avatarUrl;
      }
      return resource;
    })
    .filter((item): item is JiraCloudResource => Boolean(item));
}

export function buildJiraCloudApiBaseUrl(cloudId: string): string {
  const trimmed = cloudId.trim();
  if (!trimmed) {
    throw new Error('No Jira Cloud site is selected.');
  }

  return `https://api.atlassian.com/ex/jira/${encodeURIComponent(trimmed)}`;
}

export class JiraCloudOAuthService implements vscode.Disposable {
  private pendingAuthorization: PendingAuthorization | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore
  ) {
    const oauthManager = initializeMcpOAuthManager(context);
    this.disposables.push(oauthManager.registerExternalHandler(uri => this.handleUri(uri)));
  }

  public get redirectUri(): string {
    return `${vscode.env.uriScheme}://${this.context.extension.id}${JIRA_CLOUD_CALLBACK_PATH}`;
  }

  public async connect(): Promise<JiraCloudResource> {
    const clientId = this.configStore.getJiraOAuthClientId();
    if (!clientId) {
      throw new Error('Configure the Atlassian OAuth client ID before connecting Jira Cloud.');
    }

    const clientSecret = await this.getOrPromptClientSecret();
    const pending = this.createPendingAuthorization();
    const authorizeUrl = new URL(ATLASSIAN_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('audience', 'api.atlassian.com');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('scope', this.configStore.getJiraOAuthScopes().join(' '));
    authorizeUrl.searchParams.set('redirect_uri', this.redirectUri);
    authorizeUrl.searchParams.set('state', pending.state);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('prompt', 'consent');

    await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
    void vscode.window.showInformationMessage('Complete Jira Cloud authorization in your browser, then return to VS Code.');

    const code = await pending.promise;
    const tokens = await this.exchangeAuthorizationCode(clientId, clientSecret, code);
    await this.saveTokens(tokens);

    const resources = await this.listAccessibleResources();
    if (resources.length === 0) {
      throw new Error('No accessible Jira Cloud sites were returned by Atlassian.');
    }

    const selected = resources.length === 1 ? resources[0] : await this.pickResource(resources);
    await this.configStore.setJiraCloudSite(selected);
    return selected;
  }

  public async disconnect(): Promise<void> {
    await Promise.all([
      this.context.secrets.delete(TOKENS_KEY),
      this.configStore.setJiraCloudSite(undefined)
    ]);
  }

  public async getAccessToken(): Promise<string> {
    const tokens = await this.getTokens();
    if (!tokens) {
      throw new Error('Jira Cloud is not connected.');
    }

    if (tokens.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new Error('Jira Cloud access has expired. Reconnect with Atlassian.');
    }

    const clientId = this.configStore.getJiraOAuthClientId();
    const clientSecret = await this.getClientSecret();
    if (!clientId || !clientSecret) {
      throw new Error('Jira Cloud OAuth app credentials are incomplete.');
    }

    const refreshed = await this.refreshAccessToken(clientId, clientSecret, tokens.refreshToken);
    await this.saveTokens(refreshed);
    return refreshed.accessToken;
  }

  public getCloudApiBaseUrl(): string {
    return buildJiraCloudApiBaseUrl(this.configStore.getJiraCloudId());
  }

  public async listAccessibleResources(): Promise<JiraCloudResource[]> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(this.extractErrorMessage(payload, response.status, response.statusText));
    }
    return parseAccessibleResources(payload);
  }

  public dispose(): void {
    if (this.pendingAuthorization) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization.reject(new Error('Jira Cloud OAuth flow was cancelled.'));
      this.pendingAuthorization = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private handleUri(uri: vscode.Uri): boolean {
    if (uri.path !== JIRA_CLOUD_CALLBACK_PATH) {
      return false;
    }

    const pending = this.pendingAuthorization;
    if (!pending) {
      return true;
    }

    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;

    const params = new URLSearchParams(uri.query);
    const state = params.get('state');
    const error = params.get('error');
    const errorDescription = params.get('error_description');
    const code = params.get('code');

    if (state !== pending.state) {
      pending.reject(new Error('Jira Cloud OAuth state did not match the pending authorization.'));
      return true;
    }

    if (error) {
      pending.reject(new Error(errorDescription ? `${error}: ${errorDescription}` : error));
      return true;
    }

    if (!code) {
      pending.reject(new Error('Jira Cloud OAuth callback did not include an authorization code.'));
      return true;
    }

    pending.resolve(code);
    return true;
  }

  private createPendingAuthorization(): PendingAuthorization {
    if (this.pendingAuthorization) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization.reject(new Error('A new Jira Cloud OAuth flow was started.'));
    }

    let resolvePromise!: (code: string) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingAuthorization = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      state: randomBytes(24).toString('base64url'),
      timer: setTimeout(() => {
        if (this.pendingAuthorization !== pending) {
          return;
        }
        this.pendingAuthorization = undefined;
        rejectPromise(new Error('Timed out waiting for Jira Cloud authorization to complete.'));
      }, AUTH_TIMEOUT_MS)
    };
    this.pendingAuthorization = pending;
    return pending;
  }

  private async exchangeAuthorizationCode(
    clientId: string,
    clientSecret: string,
    code: string
  ): Promise<JiraOAuthTokens> {
    return this.requestToken({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: this.redirectUri
    });
  }

  private async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string
  ): Promise<JiraOAuthTokens> {
    const refreshed = await this.requestToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    });
    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? refreshToken
    };
  }

  private async requestToken(body: Record<string, string>): Promise<JiraOAuthTokens> {
    const response = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => undefined) as AtlassianTokenResponse | undefined;
    if (!response.ok || !payload?.access_token) {
      throw new Error(this.extractErrorMessage(payload, response.status, response.statusText));
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Math.max(0, payload.expires_in ?? 0) * 1000,
      scope: payload.scope
    };
  }

  private async pickResource(resources: JiraCloudResource[]): Promise<JiraCloudResource> {
    const picked = await vscode.window.showQuickPick(
      resources.map(resource => ({
        label: resource.name,
        description: resource.url,
        resource
      })),
      { title: 'Select Jira Cloud Site', ignoreFocusOut: true }
    );
    if (!picked) {
      throw new Error('No Jira Cloud site was selected.');
    }
    return picked.resource;
  }

  private async getTokens(): Promise<JiraOAuthTokens | undefined> {
    return parseJsonValue<JiraOAuthTokens>(await this.context.secrets.get(TOKENS_KEY));
  }

  private async saveTokens(tokens: JiraOAuthTokens): Promise<void> {
    await this.context.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
  }

  private async getClientSecret(): Promise<string | undefined> {
    const configured = this.configStore.getJiraOAuthClientSecret().trim();
    if (configured.length > 0) {
      return configured;
    }
    return (await this.context.secrets.get(CLIENT_SECRET_KEY))?.trim() || undefined;
  }

  private async getOrPromptClientSecret(): Promise<string> {
    const existing = await this.getClientSecret();
    if (existing) {
      return existing;
    }

    const entered = await vscode.window.showInputBox({
      title: 'Atlassian OAuth Client Secret',
      prompt: 'Enter the client secret for the Ticket Manager Atlassian OAuth app.',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Client secret is required.'
    });
    const secret = entered?.trim();
    if (!secret) {
      throw new Error('Atlassian OAuth client secret is required to connect Jira Cloud.');
    }

    await this.context.secrets.store(CLIENT_SECRET_KEY, secret);
    return secret;
  }

  private extractErrorMessage(payload: unknown, status: number, statusText: string): string {
    if (isRecord(payload)) {
      const error = asString(payload.error);
      const description = asString(payload.error_description);
      if (error || description) {
        return description ? `${error ?? statusText}: ${description}` : error ?? description ?? statusText;
      }
    }
    return `Atlassian OAuth request failed (${status} ${statusText}).`;
  }
}

let jiraCloudOAuthService: JiraCloudOAuthService | undefined;

export function initializeJiraCloudOAuthService(
  context: vscode.ExtensionContext,
  configStore: AppConfigStore
): JiraCloudOAuthService {
  if (!jiraCloudOAuthService) {
    jiraCloudOAuthService = new JiraCloudOAuthService(context, configStore);
    context.subscriptions.push(jiraCloudOAuthService);
  }
  return jiraCloudOAuthService;
}

export function getJiraCloudOAuthService(): JiraCloudOAuthService {
  if (!jiraCloudOAuthService) {
    throw new Error('Jira Cloud OAuth service has not been initialized.');
  }
  return jiraCloudOAuthService;
}