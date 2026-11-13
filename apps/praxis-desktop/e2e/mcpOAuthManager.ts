import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpOAuthProviderSource, OAuthClientOverride } from '../../../packages/core/out/mcp/clientFactory';
import { setMcpOAuthProviderSource } from '../../../packages/core/out/mcp/clientFactory';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';

const OAUTH_CALLBACK_PATH = '/callback';
const PREFERRED_PORT = 53682;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;

export const OAUTH_SCHEME = 'praxis';
const OAUTH_SCHEME_CALLBACK_URL = `${OAUTH_SCHEME}://oauth-callback`;

type PendingAuthorization = {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function buildServerKey(serverUrl: string): string {
  // A lookup key for a test secret store, not a password hash; keyed so it is not a bare digest.
  return createHmac('sha256', 'praxis.e2e.mcp-oauth.server-key').update(serverUrl).digest('hex');
}

function parseJsonValue<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

const memorySecretsStore = new Map<string, string>();

export const e2eSecretsStore = {
  get: async (key: string): Promise<string | undefined> => memorySecretsStore.get(key),
  store: async (key: string, value: string): Promise<void> => { memorySecretsStore.set(key, value); },
  delete: async (key: string): Promise<void> => { memorySecretsStore.delete(key); },
  clear: () => { memorySecretsStore.clear(); }
};

const CALLBACK_PAGE_OK =
  '<!doctype html><html><body style="font-family:sans-serif;background:#1c1c1c;color:#ddd;' +
  'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<p>Sign-in complete — you can close this tab and return to Praxis.</p></body></html>';

const CALLBACK_PAGE_ERROR =
  '<!doctype html><html><body style="font-family:sans-serif;background:#1c1c1c;color:#ddd;' +
  'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<p>Sign-in failed — return to Praxis for details.</p></body></html>';

class DesktopMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined;

  public constructor(
    private readonly manager: DesktopMcpOAuthManager,
    private readonly serverUrl: string,
    private readonly oauthClient?: OAuthClientOverride
  ) {}

  public get redirectUrl(): string {
    return this.oauthClient?.redirectUrl ?? this.manager.redirectUrl;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Praxis',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.oauthClient?.clientSecret
        ? 'client_secret_basic'
        : 'none',
      ...(this.oauthClient?.scope ? { scope: this.oauthClient.scope } : {})
    };
  }

  public async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.oauthClient) {
      return {
        client_id: this.oauthClient.clientId,
        ...(this.oauthClient.clientSecret
          ? { client_secret: this.oauthClient.clientSecret }
          : {})
      };
    }
    return parseJsonValue<OAuthClientInformationMixed>(
      await e2eSecretsStore.get(this.secretKey('client'))
    );
  }

  public async saveClientInformation(
    clientInformation: OAuthClientInformationMixed
  ): Promise<void> {
    if (this.oauthClient) return;
    await e2eSecretsStore.store(this.secretKey('client'), JSON.stringify(clientInformation));
  }

  public async tokens(): Promise<OAuthTokens | undefined> {
    return parseJsonValue<OAuthTokens>(await e2eSecretsStore.get(this.secretKey('tokens')));
  }

  public async saveTokens(tokens: OAuthTokens): Promise<void> {
    await e2eSecretsStore.store(this.secretKey('tokens'), JSON.stringify(tokens));
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    let url = authorizationUrl;
    const extra = this.oauthClient?.extraAuthorizeParams;
    if (extra) {
      url = new URL(authorizationUrl.toString());
      for (const [key, value] of Object.entries(extra)) {
        if (!url.searchParams.has(key)) {
          url.searchParams.set(key, value);
        }
      }
    }
    await this.manager.startAuthorization(url);
  }

  public async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
    await e2eSecretsStore.store(this.secretKey('verifier'), codeVerifier);
  }

  public async codeVerifier(): Promise<string> {
    if (this.codeVerifierValue) {
      return this.codeVerifierValue;
    }
    const stored = await e2eSecretsStore.get(this.secretKey('verifier'));
    if (!stored) {
      throw new Error('No OAuth code verifier is available for this authorization session.');
    }
    this.codeVerifierValue = stored;
    return stored;
  }

  public async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (this.oauthClient?.authorizationServer) {
      return;
    }
    await e2eSecretsStore.store(this.secretKey('discovery'), JSON.stringify(state));
  }

  public async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const server = this.oauthClient?.authorizationServer;
    if (server) {
      return {
        authorizationServerUrl: server.issuer,
        authorizationServerMetadata: {
          issuer: server.issuer,
          authorization_endpoint: server.authorizationEndpoint,
          token_endpoint: server.tokenEndpoint,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [
            'client_secret_basic',
            'client_secret_post',
            'none'
          ]
        }
      };
    }
    return parseJsonValue<OAuthDiscoveryState>(
      await e2eSecretsStore.get(this.secretKey('discovery'))
    );
  }

  public async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'all' || scope === 'client') {
      await e2eSecretsStore.delete(this.secretKey('client'));
    }
    if (scope === 'all' || scope === 'tokens') {
      await e2eSecretsStore.delete(this.secretKey('tokens'));
    }
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
      await e2eSecretsStore.delete(this.secretKey('verifier'));
    }
    if (scope === 'all' || scope === 'discovery') {
      await e2eSecretsStore.delete(this.secretKey('discovery'));
    }
  }

  private secretKey(kind: 'client' | 'tokens' | 'verifier' | 'discovery'): string {
    const identity = this.serverUrl + (this.oauthClient ? `#${this.oauthClient.clientId}` : '');
    return `praxis.mcp.oauth.${kind}.${buildServerKey(identity)}`;
  }
}

export class DesktopMcpOAuthManager implements McpOAuthProviderSource {
  private pendingAuthorization: PendingAuthorization | undefined;
  private server: http.Server | undefined;
  private boundPort: number = PREFERRED_PORT;
  private listenPromise: Promise<void> | undefined;
  private schemeRedirectEnabled = true;

  public createProvider(serverUrl: string, oauthClient?: OAuthClientOverride): OAuthClientProvider {
    return new DesktopMcpOAuthProvider(this, serverUrl, oauthClient);
  }

  public setSchemeRedirectEnabled(enabled: boolean): void {
    this.schemeRedirectEnabled = enabled;
  }

  public get redirectUrl(): string {
    return this.schemeRedirectEnabled
      ? OAUTH_SCHEME_CALLBACK_URL
      : `http://127.0.0.1:${this.boundPort}${OAUTH_CALLBACK_PATH}`;
  }

  public handleProtocolUrl(urlString: string): void {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      return;
    }
    if (url.protocol !== `${OAUTH_SCHEME}:` || url.hostname !== 'oauth-callback') {
      return;
    }
    this.settlePending(url);
  }

  public async init(): Promise<void> {
    if (this.listenPromise) {
      return this.listenPromise;
    }

    this.listenPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          server.listen(0, '127.0.0.1');
          return;
        }
        reject(error);
      });
      server.once('listening', () => {
        const address = server.address() as AddressInfo;
        this.boundPort = address.port;
        this.server = server;
        resolve();
      });
      server.listen(PREFERRED_PORT, '127.0.0.1');
    });

    return this.listenPromise;
  }

  public close(): void {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = undefined;
    }
    this.listenPromise = undefined;
    if (this.pendingAuthorization) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization = undefined;
    }
  }

  public async startAuthorization(authorizationUrl: URL): Promise<void> {
    await this.init();
    this.ensurePendingAuthorization();

    console.log(`[oauth] Opening authorization URL: ${authorizationUrl.toString()}`);

    if (process.env.PRAXIS_E2E_NO_BROWSER === '1' || process.env.TICKET_MANAGER_E2E_NO_BROWSER === '1') {
      void this.followRedirectsInProcess(authorizationUrl.toString(), MAX_REDIRECTS).catch(
        error => this.failPending(error instanceof Error ? error : new Error(String(error)))
      );
      return;
    }

    throw new Error('Real browser launch not supported in headless test harness; set PRAXIS_E2E_NO_BROWSER=1');
  }

  public async waitForAuthorizationCode(): Promise<string> {
    return this.ensurePendingAuthorization().promise;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort}`);
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }

    const outcome = this.settlePending(url);
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(outcome === 'rejected' ? CALLBACK_PAGE_ERROR : CALLBACK_PAGE_OK);
  }

  private settlePending(url: URL): 'resolved' | 'rejected' | 'none' {
    const pending = this.pendingAuthorization;
    if (!pending) {
      return 'none';
    }

    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;

    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    const code = url.searchParams.get('code');

    if (error) {
      pending.reject(new Error(errorDescription ? `${error}: ${errorDescription}` : error));
      return 'rejected';
    }

    if (!code) {
      pending.reject(new Error('OAuth callback did not include an authorization code.'));
      return 'rejected';
    }

    pending.resolve(code);
    return 'resolved';
  }

  private failPending(error: Error): void {
    const pending = this.pendingAuthorization;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;
    pending.reject(error);
  }

  private async followRedirectsInProcess(url: string, redirectsLeft: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url, response => {
        response.resume();
        response.on('end', () => {
          const location = response.headers.location;
          if (location && (location.startsWith(`${OAUTH_SCHEME}:`) || location.startsWith('ticketmanager:'))) {
            this.handleProtocolUrl(location);
            resolve();
            return;
          }
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            location &&
            redirectsLeft > 0
          ) {
            resolve(
              this.followRedirectsInProcess(new URL(location, url).toString(), redirectsLeft - 1)
            );
            return;
          }
          resolve();
        });
      });
      request.on('error', reject);
    });
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
      if (!this.pendingAuthorization) return;
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

let manager: DesktopMcpOAuthManager | undefined;

export function getDesktopMcpOAuthManager(): DesktopMcpOAuthManager {
  if (!manager) {
    manager = new DesktopMcpOAuthManager();
    setMcpOAuthProviderSource(() => manager);
  }
  return manager;
}
