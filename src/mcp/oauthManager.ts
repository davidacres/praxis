import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';

const OAUTH_CALLBACK_PATH = '/mcp-auth-callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

type ExternalUriHandler = (uri: vscode.Uri) => boolean | void;

type PendingAuthorization = {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function buildServerKey(serverUrl: string): string {
  return createHash('sha256').update(serverUrl).digest('hex');
}

function parseJsonValue<T>(value: string | undefined): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

class VsCodeMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: McpOAuthManager,
    private readonly serverUrl: string
  ) {}

  public get redirectUrl(): string {
    return `${vscode.env.uriScheme}://${this.context.extension.id}${OAUTH_CALLBACK_PATH}`;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Ticket Manager',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  public async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return parseJsonValue<OAuthClientInformationMixed>(
      await this.context.secrets.get(this.secretKey('client'))
    );
  }

  public async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.context.secrets.store(this.secretKey('client'), JSON.stringify(clientInformation));
  }

  public async tokens(): Promise<OAuthTokens | undefined> {
    return parseJsonValue<OAuthTokens>(await this.context.secrets.get(this.secretKey('tokens')));
  }

  public async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.context.secrets.store(this.secretKey('tokens'), JSON.stringify(tokens));
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.manager.startAuthorization(authorizationUrl);
  }

  public async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
    await this.context.secrets.store(this.secretKey('verifier'), codeVerifier);
  }

  public async codeVerifier(): Promise<string> {
    if (this.codeVerifierValue) {
      return this.codeVerifierValue;
    }

    const stored = await this.context.secrets.get(this.secretKey('verifier'));
    if (!stored) {
      throw new Error('No OAuth code verifier is available for this authorization session.');
    }

    this.codeVerifierValue = stored;
    return stored;
  }

  public async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.context.secrets.store(this.secretKey('discovery'), JSON.stringify(state));
  }

  public async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return parseJsonValue<OAuthDiscoveryState>(
      await this.context.secrets.get(this.secretKey('discovery'))
    );
  }

  public async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'all' || scope === 'client') {
      await this.context.secrets.delete(this.secretKey('client'));
    }
    if (scope === 'all' || scope === 'tokens') {
      await this.context.secrets.delete(this.secretKey('tokens'));
    }
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
      await this.context.secrets.delete(this.secretKey('verifier'));
    }
    if (scope === 'all' || scope === 'discovery') {
      await this.context.secrets.delete(this.secretKey('discovery'));
    }
  }

  private secretKey(kind: 'client' | 'tokens' | 'verifier' | 'discovery'): string {
    return `ticketManager.mcp.oauth.${kind}.${buildServerKey(this.serverUrl)}`;
  }
}

export class McpOAuthManager implements vscode.UriHandler, vscode.Disposable {
  private pendingAuthorization: PendingAuthorization | undefined;
  private readonly externalHandlers = new Set<ExternalUriHandler>();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public createProvider(serverUrl: string): OAuthClientProvider {
    return new VsCodeMcpOAuthProvider(this.context, this, serverUrl);
  }

  public registerExternalHandler(handler: ExternalUriHandler): vscode.Disposable {
    this.externalHandlers.add(handler);
    return new vscode.Disposable(() => this.externalHandlers.delete(handler));
  }

  public async startAuthorization(authorizationUrl: URL): Promise<void> {
    this.ensurePendingAuthorization();
    await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl.toString()));
    void vscode.window.showInformationMessage('Complete sign-in in your browser, then return to VS Code.');
  }

  public async waitForAuthorizationCode(): Promise<string> {
    return this.ensurePendingAuthorization().promise;
  }

  public handleUri(uri: vscode.Uri): void {
    for (const handler of this.externalHandlers) {
      if (handler(uri) === true) {
        return;
      }
    }

    if (uri.path !== OAUTH_CALLBACK_PATH) {
      return;
    }

    const pending = this.pendingAuthorization;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;

    const params = new URLSearchParams(uri.query);
    const error = params.get('error');
    const errorDescription = params.get('error_description');
    const code = params.get('code');

    if (error) {
      pending.reject(new Error(errorDescription ? `${error}: ${errorDescription}` : error));
      return;
    }

    if (!code) {
      pending.reject(new Error('OAuth callback did not include an authorization code.'));
      return;
    }

    pending.resolve(code);
  }

  public dispose(): void {
    if (!this.pendingAuthorization) {
      return;
    }

    clearTimeout(this.pendingAuthorization.timer);
    this.pendingAuthorization.reject(new Error('OAuth flow was cancelled.'));
    this.pendingAuthorization = undefined;
  }

  private ensurePendingAuthorization(): PendingAuthorization {
    if (this.pendingAuthorization) {
      return this.pendingAuthorization;
    }

    let resolvePromise!: (code: string) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      if (!this.pendingAuthorization) {
        return;
      }
      this.pendingAuthorization = undefined;
      rejectPromise(new Error('Timed out waiting for OAuth sign-in to complete.'));
    }, AUTH_TIMEOUT_MS);

    this.pendingAuthorization = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer
    };

    return this.pendingAuthorization;
  }
}

let manager: McpOAuthManager | undefined;

export function initializeMcpOAuthManager(context: vscode.ExtensionContext): McpOAuthManager {
  if (!manager) {
    manager = new McpOAuthManager(context);
    context.subscriptions.push(vscode.window.registerUriHandler(manager), manager);
  }

  return manager;
}

export function getMcpOAuthManager(): McpOAuthManager | undefined {
  return manager;
}