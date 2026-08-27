import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, shell } from 'electron';
import type { McpOAuthProviderSource, OAuthClientOverride } from '@ticket-manager/core';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';
import { getSecretsStore } from './connectionStoreInstance';

/**
 * Desktop port of the extension's `mcp/oauthManager.ts`. The three host swaps:
 *
 * - `context.secrets` → the shared `ElectronSecretsStore` (same sha256 key scheme).
 * - `vscode://` UriHandler → a loopback `node:http` listener on a fixed
 *   preferred port (fallback: OS-assigned), callback path `/callback`.
 * - `vscode.env.openExternal` → `shell.openExternal`, with an e2e seam:
 *   `TICKET_MANAGER_E2E_NO_BROWSER=1` performs the authorization GET in-process
 *   (following redirects) so the loopback callback fires without a real browser.
 */
const OAUTH_CALLBACK_PATH = '/callback';
const PREFERRED_PORT = 53682;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;

/**
 * Custom URI scheme carrying OAuth callbacks back into the app (the desktop
 * analog of the extension's `vscode://` redirect). A stable scheme URL is what
 * org admins allowlist — a localhost port reads as an untrusted app to
 * Atlassian orgs with redirect-URL restrictions.
 */
export const OAUTH_SCHEME = 'ticketmanager';
const OAUTH_SCHEME_CALLBACK_URL = `${OAUTH_SCHEME}://oauth-callback`;

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
    // A pre-registered app may require the exact redirect URI registered in
    // its console (e.g. one the org admin has allowlisted).
    return this.oauthClient?.redirectUrl ?? this.manager.redirectUrl;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Praxis',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Confidential pre-registered apps authenticate at the token endpoint;
      // DCR/public clients are PKCE-only.
      token_endpoint_auth_method: this.oauthClient?.clientSecret
        ? 'client_secret_basic'
        : 'none',
      ...(this.oauthClient?.scope ? { scope: this.oauthClient.scope } : {})
    };
  }

  public async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // A pre-registered client short-circuits dynamic registration entirely.
    if (this.oauthClient) {
      return {
        client_id: this.oauthClient.clientId,
        ...(this.oauthClient.clientSecret
          ? { client_secret: this.oauthClient.clientSecret }
          : {})
      };
    }
    return parseJsonValue<OAuthClientInformationMixed>(
      await getSecretsStore().get(this.secretKey('client'))
    );
  }

  public async saveClientInformation(
    clientInformation: OAuthClientInformationMixed
  ): Promise<void> {
    if (this.oauthClient) {
      // Never let a DCR response overwrite (or shadow) user-supplied credentials.
      return;
    }
    await getSecretsStore().store(this.secretKey('client'), JSON.stringify(clientInformation));
  }

  public async tokens(): Promise<OAuthTokens | undefined> {
    return parseJsonValue<OAuthTokens>(await getSecretsStore().get(this.secretKey('tokens')));
  }

  public async saveTokens(tokens: OAuthTokens): Promise<void> {
    await getSecretsStore().store(this.secretKey('tokens'), JSON.stringify(tokens));
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
    await getSecretsStore().store(this.secretKey('verifier'), codeVerifier);
  }

  public async codeVerifier(): Promise<string> {
    if (this.codeVerifierValue) {
      return this.codeVerifierValue;
    }

    const stored = await getSecretsStore().get(this.secretKey('verifier'));
    if (!stored) {
      throw new Error('No OAuth code verifier is available for this authorization session.');
    }

    this.codeVerifierValue = stored;
    return stored;
  }

  public async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (this.oauthClient?.authorizationServer) {
      // The state is synthesized from the override on every run — persisting
      // it would only risk going stale when settings change.
      return;
    }
    await getSecretsStore().store(this.secretKey('discovery'), JSON.stringify(state));
  }

  public async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const server = this.oauthClient?.authorizationServer;
    if (server) {
      // BYO 3LO: skip discovery against the MCP server entirely — its own
      // authorization server only recognizes DCR-registered clients. Hand the
      // SDK a complete synthetic metadata document for the real AS; per the
      // SDK's auth flow a cached authorizationServerMetadata is used as-is
      // (no fetch, no issuer validation), and the absent resourceMetadata
      // means no RFC 8707 `resource` param is sent.
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
      await getSecretsStore().get(this.secretKey('discovery'))
    );
  }

  public async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    const secrets = getSecretsStore();
    if (scope === 'all' || scope === 'client') {
      await secrets.delete(this.secretKey('client'));
    }
    if (scope === 'all' || scope === 'tokens') {
      await secrets.delete(this.secretKey('tokens'));
    }
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
      await secrets.delete(this.secretKey('verifier'));
    }
    if (scope === 'all' || scope === 'discovery') {
      await secrets.delete(this.secretKey('discovery'));
    }
  }

  private secretKey(kind: 'client' | 'tokens' | 'verifier' | 'discovery'): string {
    // Include the client id so a BYO-client connection and a DCR connection
    // to the same server never share cached tokens/verifiers.
    const identity = this.serverUrl + (this.oauthClient ? `#${this.oauthClient.clientId}` : '');
    return `ticketManager.mcp.oauth.${kind}.${buildServerKey(identity)}`;
  }
}

export class DesktopMcpOAuthManager implements McpOAuthProviderSource {
  private pendingAuthorization: PendingAuthorization | undefined;
  private server: http.Server | undefined;
  private boundPort: number = PREFERRED_PORT;
  private listenPromise: Promise<void> | undefined;
  /**
   * Scheme redirect is the default; index.ts flips this off if protocol
   * registration failed, falling back to the loopback listener (which also
   * stays up for connections whose `jiraOAuthRedirectUrl` points at it).
   */
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

  /**
   * Entry point for `ticketmanager://` URLs delivered by the OS (second-instance
   * argv on Windows/Linux, `open-url` on macOS — wired in index.ts).
   */
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

  /**
   * Starts the loopback listener. Called once at app ready (the SDK reads
   * `redirectUrl` synchronously, so the port must be settled before any OAuth
   * flow starts — app-ready gives that head start). Prefers the fixed port so
   * a registered client's redirect_uris stay valid across restarts; falls back
   * to an OS-assigned port when it is taken.
   */
  public async init(): Promise<void> {
    if (this.listenPromise) {
      return this.listenPromise;
    }

    this.listenPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          // Preferred port taken — bind an OS-assigned port instead.
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

    app.on('will-quit', () => {
      this.server?.close();
    });

    return this.listenPromise;
  }

  public async startAuthorization(authorizationUrl: URL): Promise<void> {
    await this.init();
    this.ensurePendingAuthorization();

    // Log the authorize target — which AS the browser hits (and whether the
    // org-specific params made it) is the first thing to check when sign-in
    // fails. Local console only; the query holds no secrets (PKCE challenge,
    // not the verifier).
    console.log(`[oauth] Opening authorization URL: ${authorizationUrl.toString()}`);

    if (process.env.TICKET_MANAGER_E2E_NO_BROWSER === '1') {
      // e2e seam: follow the authorization redirect chain in-process so the
      // loopback callback fires without launching a real browser.
      void this.followRedirectsInProcess(authorizationUrl.toString(), MAX_REDIRECTS).catch(
        error => this.failPending(error instanceof Error ? error : new Error(String(error)))
      );
      return;
    }

    await shell.openExternal(authorizationUrl.toString());
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

  /**
   * Shared callback settlement for both delivery channels (loopback HTTP and
   * the `ticketmanager://` protocol URL). Resolves or rejects the pending
   * authorization from the callback's query params.
   */
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
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;
    pending.reject(error);
  }

  /**
   * e2e-only browser stand-in: GET the authorization URL, following 3xx
   * redirects (the last hop lands on our loopback listener, which resolves the
   * pending authorization). Bodies are discarded.
   */
  private async followRedirectsInProcess(url: string, redirectsLeft: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url, response => {
        response.resume();
        response.on('end', () => {
          const location = response.headers.location;
          if (location && location.startsWith(`${OAUTH_SCHEME}:`)) {
            // The authorization server redirected to our custom scheme — the OS
            // would deliver this to the protocol handler; in-process we feed it
            // straight to the same handler.
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

let manager: DesktopMcpOAuthManager | undefined;

export function getDesktopMcpOAuthManager(): DesktopMcpOAuthManager {
  if (!manager) {
    manager = new DesktopMcpOAuthManager();
  }
  return manager;
}
