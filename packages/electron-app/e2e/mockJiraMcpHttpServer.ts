// SPDX-License-Identifier: MIT
//
// In-process mock Jira MCP-over-HTTP server for Playwright e2e tests of the
// `@ticket-manager/electron-app` package.
//
// Why two auth modes in one mock: Phase E contract. Test 1 (API token) needs
// every MCP request to carry `Authorization: Basic <base64>` and proves the
// desktop app injects the header from the per-connection secret; Test 2 (full
// OAuth loop) needs the mock to return 401 with `WWW-Authenticate: Bearer` when
// MCP is hit without a Bearer token, then walk RFC 9728 + RFC 8414 discovery,
// DCR, browser-style authorize, and the authorization_code token exchange
// before the desktop app retries MCP with the issued Bearer.
//
// The mock speaks real MCP-over-HTTP through
// `StreamableHTTPServerTransport` (SDK 1.28.0 at the repo root node_modules)
// so the client under test uses its production code path. Discovery endpoints
// (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
// DCR (`POST /register`), the authorization redirect (`GET /authorize`), and
// the token grant (`POST /token`) are plain JSON hand-rolled — the SDK only
// fetches them; it never has to parse anything beyond the response shape
// dictated by the schemas in `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/auth.js`
// (resource → authorization_servers, response_types_supported: ['code'],
// code_challenge_methods_supported: ['S256'], registration_endpoint pointing
// at /register, etc.).
//
// OAuth flow contract the mock honours (verified end-to-end against SDK 1.28):
//   1. `/.well-known/oauth-protected-resource` returns
//      `resource ≡ http://127.0.0.1:<port>/mcp` and lists the mock origin as
//      its sole authorization server so `discoverOAuthServerInfo` picks it up.
//   2. `/.well-known/oauth-authorization-server` advertises
//      `/{authorize,token,register}` endpoints, `response_types_supported:
//      ['code']`, `code_challenge_methods_supported: ['S256']`
//      (startAuthorization rejects otherwise).
//   3. `POST /register` echoes the supplied client metadata and returns a
//      `client_id: 'mock-client-id'` so `OAuthClientInformationFullSchema` is
//      satisfied and `token_endpoint_auth_method: 'none'` matches what the
//      DesktopMcpOAuthProvider registers.
//   4. `GET /authorize?…` 302-redirects to `redirect_uri` (read from query
//      string — must match `http://127.0.0.1:<sdk-bound-port>/callback`,
//      since the desktop app's loopback listener binds a port the mock
//      doesn't know up-front) with `code=mock-auth-code` and the verbatim
//      `state` round-tripped so the SDK's PKCE/state check succeeds.
//   5. `POST /token` validates `grant_type=authorization_code` (form body),
//      returns `access_token: 'mock-access-token'` plus expires_in. The SDK
//      then retries MCP with `Authorization: Bearer mock-access-token`, which
//      the mock accepts.
//
// The ordered event log (`eventLog`) and the last `Authorization` header the
// mock saw on /mcp (`lastAuthorization`) are exposed for assertions — see
// `jiraAuth.spec.ts` for the sequence test of OAuth and the header-match
// test of the API-token path.
//
// Tool coverage intentionally mirrors `mockJiraMcpServer.mjs` (the stdio
// fixture): search + the projects query + the agile-board list. The desktop
// `JiraService.checkConnection` resolves `tools/list` (the SDK listTools call)
// and then `atlassian-jira_get_all_projects`; `resolveTools` requires
// `atlassian-jira_search` to be present so the community adapter is picked,
// throwing "no recognized Jira tools" otherwise.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ServerResult
} from '@modelcontextprotocol/sdk/types.js';

/** The single Bearer token the OAuth flow hands out; the mock rejects any other credential. */
const ACCESS_TOKEN = 'mock-access-token';
/** Static auth code the mock's /authorize redirects land on. */
const AUTH_CODE = 'mock-auth-code';
/** Static client_id the mock's /register echoes back so DCR returns a known id. */
const CLIENT_ID = 'mock-client-id';

/** Public handle returned to the playwright spec — mirrors `MockGitLabServer`. */
export interface MockJiraMcpHttpServer {
  /** `http://127.0.0.1:<port>` — bind directly into the connection's httpUrl. */
  baseUrl: string;
  /** The MCP URL the client should hit (always baseUrl + '/mcp'). */
  mcpUrl: string;
  /** Ordered event log — push-style instead of counters so order-sensitive
   *  assertions (register → authorize → token → initialize) read naturally. */
  eventLog: string[];
  /** Most-recent raw `Authorization` header value the mock saw on /mcp,
   *  irrespective of auth mode. `null` means nothing arrived (yet). */
  lastAuthorization: string | null;
  /** Most-recent raw `Authorization` header value the mock saw on POST /token,
   *  i.e. the client-credential material the SDK applied at the token endpoint.
   *  `null` means the SDK never sent an Authorization header (e.g. public-client
   *  DCR flow that posts `client_id` in the body instead). Used by the BYO test
   *  to assert SDK selected Basic auth and encoded the override secret. */
  lastTokenEndpointAuth: string | null;
  /** Most-recent query-string snapshot from GET /authorize, restricted to the
   *  keys the spec cares about (scope, redirect_uri, state, code_challenge).
   *  `null` means /authorize has not been hit yet this run. Captured per request
   *  so duplicate calls overwrite — useful when the SDK retries auth mid-flow. */
  lastAuthorizeQuery: {
    scope?: string;
    redirect_uri?: string;
    state?: string;
    code_challenge?: string;
  } | null;
  /** Client IDs that MUST present `Authorization: Basic …` on POST /token.
   *  Empty by default — the existing tests' DCR'd public client posts
   *  `client_id` in the body and skips Basic. Pre-registering a client id here
   *  matches a confidential OAuth app's contract: if the SDK tries /token
   *  without Basic auth, the mock returns a 4xx that does not match
   *  `invalid_client`/`invalid_grant`, so `auth()` rethrows (no invalidate,
   *  no retry loop) and the parent request fails cleanly. Used by the BYO
   *  spec to force a fresh OAuth after the secret is stored — without this
   *  guard, an auto-triggered OAuth that runs with the BYO connection set up
   *  but no secret yet would race ahead and cache a public-client Bearer,
   *  which the follow-up `connection.check` would silently reuse. */
  confidentialClientIds: Set<string>;
  /** Stops the http server. Safe to call multiple times. */
  close(): Promise<void>;
  /** Wait until a given event appears in the log (race-free assertion helper). */
  waitForEvent(name: string, timeoutMs?: number): Promise<void>;
}

/** Internal state the request handlers mutate. Constructed per `start…()` call
 *  so restarting between tests gives a clean event log and no leaked sessions. */
interface MockState {
  mode: 'token' | 'oauth';
  serverUrl: string;
  eventLog: string[];
  lastAuthorization: string | null;
  lastTokenEndpointAuth: string | null;
  lastAuthorizeQuery: {
    scope?: string;
    redirect_uri?: string;
    state?: string;
    code_challenge?: string;
  } | null;
  /** See the matching field on `MockJiraMcpHttpServer`. */
  confidentialClientIds: Set<string>;
}

function createEmptyState(mode: 'token' | 'oauth'): MockState {
  return {
    mode,
    serverUrl: '',
    eventLog: [],
    lastAuthorization: null,
    lastTokenEndpointAuth: null,
    lastAuthorizeQuery: null,
    confidentialClientIds: new Set<string>()
  };
}

/**
 * Push a named entry to the event log. Drops consecutive duplicates so the
 * initialize / tools/list sequence reads cleanly across retries — the SDK
 * may call initialize twice (once before auth, once after) but the test only
 * cares about order-presence.
 */
function pushEvent(state: MockState, name: string): void {
  const last = state.eventLog[state.eventLog.length - 1];
  if (last !== name) {
    state.eventLog.push(name);
  }
}

/**
 * Build the JSON body the desktop app's PRM probe expects. `resource` is
 * the MCP endpoint URL (serverUrl + '/mcp'); `authorization_servers` includes
 * the mock origin so the SDK picks it as the authorization server without
 * having to fall back to the MCP server URL itself.
 */
function buildProtectedResourceMetadata(serverUrl: string): Record<string, unknown> {
  return {
    resource: `${serverUrl}/mcp`,
    authorization_servers: [serverUrl],
    scopes_supported: ['read:jira-work', 'write:jira-work', 'offline_access'],
    bearer_methods_supported: ['header']
  };
}

/**
 * Required fields per the upstream OAuthMetadataSchema: `issuer`,
 * `authorization_endpoint`, `token_endpoint`, `response_types_supported: ['code']`.
 * PKCE is mandatory — `startAuthorization` throws if
 * `code_challenge_methods_supported` is missing or does not include `S256`.
 * The mock advertises both `none` (so the public DCR flow used by the second
 * test still posts `client_id` in the body) and `client_secret_basic` (so the
 * BYO flow in the third test, which carries a per-connection secret, has a
 * server-advertised method to match). Order does not matter — the SDK's
 * `selectClientAuthMethod` honours the method on `clientInformation` first
 * (post-DCR BYO flows leave `token_endpoint_auth_method` set, so they skip this
 * list entirely).
 */
function buildOAuthMetadata(serverUrl: string): Record<string, unknown> {
  return {
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/authorize`,
    token_endpoint: `${serverUrl}/token`,
    registration_endpoint: `${serverUrl}/register`,
    scopes_supported: ['read:jira-work', 'write:jira-work', 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256']
  };
}

/** Fixture projects/issues/boards mirror mockJiraMcpServer.mjs so
 *  `checkConnection` sees a non-empty result regardless of which community
 *  tool path the resolver picks. */
const PROJECTS: Array<Record<string, string>> = [
  { id: '1', key: 'DEMO', name: 'Demo Project' }
];

const ISSUES: Array<Record<string, unknown>> = [
  {
    id: '10000',
    key: 'DEMO-1',
    self: 'http://mock-jira/rest/api/3/issue/DEMO-1',
    fields: {
      summary: 'Bootstrap mock Jira MCP server',
      status: { name: 'To Do', statusCategory: { name: 'todo' } },
      issuetype: { name: 'Task' },
      assignee: { displayName: 'Alex Agent' },
      reporter: { displayName: 'Alex Agent' },
      priority: { name: 'Medium' },
      created: '2026-08-20T08:00:00.000Z',
      updated: '2026-08-20T08:15:00.000Z',
      project: { key: 'DEMO', name: 'Demo Project' },
      description: 'Wire the HTTP mock so the desktop e2e suite can drive Jira.',
      comment: { comments: [] }
    }
  }
];

const BOARDS: Array<Record<string, unknown>> = [
  {
    id: '42',
    name: 'Demo Board',
    type: 'scrum',
    location: {
      projectKey: 'DEMO',
      projectName: 'Demo Project',
      name: 'Demo Project'
    }
  }
];

/** Tool descriptors mirror the stdio mock — see the comment at top of file. */
const TOOL_DESCRIPTORS: Array<Record<string, unknown>> = [
  {
    name: 'atlassian-jira_get_all_projects',
    description: 'Return the mock Jira project list.',
    inputSchema: {
      type: 'object',
      properties: { include_archived: { type: 'boolean' } }
    }
  },
  {
    name: 'atlassian-jira_search',
    description: 'Search mock Jira issues using a permissive JQL match.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string' },
        fields: { type: 'string' },
        limit: { type: 'number' },
        start_at: { type: 'number' }
      }
    }
  },
  {
    name: 'atlassian-jira_get_agile_boards',
    description: 'List mock Jira agile boards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_name: { type: 'string' },
        project_key: { type: 'string' },
        board_type: { type: 'string' },
        start_at: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  }
];

/** Standard MCP envelope: a single text-content block wrapping JSON. */
function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message) }]
  };
}

type ToolHandler = (
  args: Record<string, unknown>
) => Promise<CallToolResult> | CallToolResult;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  'atlassian-jira_get_all_projects': () => jsonResult(PROJECTS),
  'atlassian-jira_search': () => jsonResult({
    issues: ISSUES,
    total: ISSUES.length,
    isLast: true
  }),
  'atlassian-jira_get_agile_boards': () =>
    jsonResult({ values: BOARDS, total: BOARDS.length, isLast: true })
};

function attachToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<ServerResult> => {
      const params = (request?.params ?? {}) as { name?: string };
      const name = params.name;
      const handler = name ? TOOL_HANDLERS[name] : undefined;
      if (!handler) {
        return errorResult(`Unknown tool: ${name}`);
      }
      try {
        return await handler({});
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}

/** Drain the request body once into a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Send a JSON response with optional extra headers (e.g. WWW-Authenticate). */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify(body));
}

/**
 * Authorisation gate for /mcp traffic. Token mode demands
 * `Authorization: Basic <anything-with-a-colon>`; OAuth mode demands
 * `Authorization: Bearer mock-access-token` (otherwise 401 + WWW-Authenticate
 * so the SDK kicks off the OAuth flow). The exact `Authorization` header is
 * captured into `state.lastAuthorization` so the test can read it back to
 * assert it equals `Basic ${base64(email:token)}` (token mode) or
 * `Bearer mock-access-token` (oauth mode post-auth).
 */
function checkMcpAuth(
  req: IncomingMessage,
  state: MockState
): { ok: true } | { ok: false; response: { status: number; body: unknown; extraHeaders?: Record<string, string> } } {
  const rawHeader = req.headers.authorization;
  const header = typeof rawHeader === 'string' ? rawHeader : null;
  state.lastAuthorization = header;

  if (state.mode === 'token') {
    if (header && header.startsWith('Basic ')) {
      return { ok: true };
    }
    return {
      ok: false,
      response: { status: 401, body: { error: 'missing_basic_auth' } }
    };
  }

  // OAuth mode
  if (header && header === `Bearer ${ACCESS_TOKEN}`) {
    return { ok: true };
  }
  // RFC 6750 §3 says the WWW-Authenticate response carries the resource
  // metadata URL so the SDK can find PRM without an extra probe. We point
  // at the well-known PRM URL the mock also serves from the bare origin.
  return {
    ok: false,
    response: {
      status: 401,
      body: { error: 'missing_bearer_token' },
      extraHeaders: {
        'WWW-Authenticate':
          `Bearer realm="mcp", resource_metadata="${state.serverUrl}/.well-known/oauth-protected-resource"`
      }
    }
  };
}

/**
 * Approximate "message kind" classifier used to label events. We only care
 * whether it is `initialize`, `tools/list`, a `tools/call` (and which tool),
 * or some other request — the OAuth flow asserts order, not exact method
 * name, so coarse naming fits. Returns `null` for non-assertable traffic
 * (notifications, pings) so they're skipped instead of polluting the log.
 */
function summarizeMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const obj = message as { method?: unknown; params?: { name?: unknown } };
  const method = typeof obj.method === 'string' ? obj.method : '';
  if (method === 'initialize') {
    return 'initialize';
  }
  if (method === 'tools/list') {
    return 'tools/list';
  }
  if (method === 'tools/call') {
    const toolName = typeof obj.params?.name === 'string' ? obj.params.name : 'unknown';
    return `call:${toolName}`;
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    return null;
  }
  return method || null;
}

/**
 * Build the StreamableHTTPServerTransport + Server pair. The transport is
 * stateful (randomUUID per `initialize`) so multiple MCP client connections
 * coexist inside the single `start…()` instance — important because
 * `auth()` refreshes the connection after the OAuth callback fires, which
 * means we see a second `initialize` from the same logical client.
 */
function buildMcpServer(state: MockState): { server: Server; transport: StreamableHTTPServerTransport } {
  const server = new Server(
    { name: 'mock-jira-mcp-http', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  attachToolHandlers(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  transport.onmessage = (message: unknown) => {
    const summary = summarizeMessage(message);
    if (summary) {
      pushEvent(state, summary);
    }
  };

  return { server, transport };
}

/**
 * Start a fresh mock MCP-over-HTTP server. Each call returns an isolated
 * fixture (separate event log, fresh session IDs, separate port). The
 * `mode` option decides the auth expectation on `/mcp`:
 *
 *   • `'token'` — every /mcp request must include `Authorization: Basic
 *     <base64>`; mock returns 401 otherwise and does NOT trigger any OAuth
 *     endpoints.
 *   • `'oauth'` — Bearer token expectation; mock returns 401 with
 *     `WWW-Authenticate: Bearer realm=…, resource_metadata=<serverUrl>` so
 *     the SDK runs the full RFC 9728 + RFC 8414 + RFC 7591 dance against
 *     `/register`, `/authorize`, and `/token` before retrying `/mcp` with
 *     `Authorization: Bearer mock-access-token`.
 */
export async function startMockJiraMcpHttpServer(
  options?: { mode?: 'token' | 'oauth' }
): Promise<MockJiraMcpHttpServer> {
  const mode: 'token' | 'oauth' = options?.mode === 'oauth' ? 'oauth' : 'token';
  const state = createEmptyState(mode);
  const { server: mcpServer, transport } = buildMcpServer(state);

  const httpServer = http.createServer(async (req, res) => {
    try {
      await route(req, res, state, transport);
    } catch (error) {
      // Last-ditch error surface — keeps the test output useful when the
      // mock itself blows up rather than the app under test.
      sendJson(res, 500, {
        error: 'mock_internal_error',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  state.serverUrl = baseUrl;
  // Connect the MCP server to its transport so the SDK can drive it through
  // /mcp. `server.connect` is fire-and-forget for streamable HTTP — the
  // transport handles requests on demand.
  await mcpServer.connect(transport);

  let closed = false;
  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    eventLog: state.eventLog,
    get lastAuthorization(): string | null {
      return state.lastAuthorization;
    },
    get lastTokenEndpointAuth(): string | null {
      return state.lastTokenEndpointAuth;
    },
    get lastAuthorizeQuery(): MockJiraMcpHttpServer['lastAuthorizeQuery'] {
      return state.lastAuthorizeQuery;
    },
    /** Direct passthrough so the BYO spec can register `my-3lo-client-id`
     *  (its confidential pre-registered client id) BEFORE launchTestApp
     *  without flushing between steps. */
    get confidentialClientIds(): Set<string> {
      return state.confidentialClientIds;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await transport.close();
      } catch {
        // ignored — transport may already be closed when the http server
        // finishes dropping its keep-alive sockets
      }
      try {
        mcpServer.close();
      } catch {
        // ignored — `Server.close()` is best-effort
      }
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
    /** Wait (poll) until `name` appears in `eventLog`. Honours `timeoutMs`. */
    async waitForEvent(name: string, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.eventLog.includes(name)) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(
        `Mock event '${name}' did not appear within ${timeoutMs}ms. Observed: ${JSON.stringify(state.eventLog)}`
      );
    }
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockState,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // MCP endpoint — always `/mcp`. Auth gate runs before delegating so the
  // 401 path never leaks into the SDK's session bookkeeping.
  if (pathname === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
    const auth = checkMcpAuth(req, state);
    if (!auth.ok) {
      sendJson(res, auth.response.status, auth.response.body, auth.response.extraHeaders);
      return;
    }
    let body: string | object | undefined;
    if (method === 'POST') {
      const raw = await readBody(req);
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  // ── Discovery endpoints ────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/.well-known/oauth-protected-resource') {
    pushEvent(state, 'prm:discovery');
    sendJson(res, 200, buildProtectedResourceMetadata(state.serverUrl));
    return;
  }
  if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
    pushEvent(state, 'oauth:discovery');
    sendJson(res, 200, buildOAuthMetadata(state.serverUrl));
    return;
  }
  if (method === 'GET' && pathname === '/.well-known/openid-configuration') {
    // The SDK's buildDiscoveryUrls also probes the OIDC URL when the AS path
    // is non-root; serve the same shape so we don't break that probe.
    pushEvent(state, 'oidc:discovery');
    sendJson(res, 200, buildOAuthMetadata(state.serverUrl));
    return;
  }

  // ── DCR ────────────────────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/register') {
    const raw = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignored — empty body / non-JSON just yields an empty client blob
    }
    pushEvent(state, 'register');
    sendJson(res, 201, {
      client_id: CLIENT_ID,
      client_name: parsed['client_name'] ?? 'mock-client',
      redirect_uris: parsed['redirect_uris'] ?? [],
      grant_types: parsed['grant_types'] ?? ['authorization_code', 'refresh_token'],
      response_types: parsed['response_types'] ?? ['code'],
      token_endpoint_auth_method: parsed['token_endpoint_auth_method'] ?? 'none',
      scope: parsed['scope'],
      client_id_issued_at: Math.floor(Date.now() / 1000)
    });
    return;
  }

  // ── Authorize (browser stand-in) ───────────────────────────────────────────
  if (method === 'GET' && pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const stateParam = url.searchParams.get('state') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    // Snapshot the outbound authorize request the SDK just sent so the spec
    // can prove `scope`/`redirect_uri` made it through the desktop provider.
    // The POST-BODY routes do not need to be exposed (the SDK only GETs here).
    state.lastAuthorizeQuery = {
      scope: url.searchParams.get('scope') ?? undefined,
      redirect_uri: redirectUri ?? undefined,
      state: stateParam || undefined,
      code_challenge: codeChallenge || undefined
    };
    pushEvent(state, 'authorize');
    if (!redirectUri) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri missing' });
      return;
    }
    // The mock verifies code_challenge was supplied — actual PKCE verification
    // belongs to /token, not /authorize, but a missing param is structurally
    // bogus and would have surfaced in the SDK's startAuthorization path.
    void codeChallenge;
    const target = new URL(redirectUri);
    target.searchParams.set('code', AUTH_CODE);
    target.searchParams.set('state', stateParam);
    res.statusCode = 302;
    res.setHeader('Location', target.toString());
    res.end();
    return;
  }

  // ── Token exchange ────────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/token') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const grantType = params.get('grant_type') ?? '';
    const clientId = params.get('client_id') ?? '';
    // Record the inbound Authorization header so the spec can prove the SDK
    // applied Basic auth for the BYO case. A public/DCR'd client leaves this
    // unset and posts `client_id` in the body (`applyPublicAuth`), so the field
    // stays `null` for the existing OAuth test.
    const tokenAuthRaw = req.headers.authorization;
    state.lastTokenEndpointAuth =
      typeof tokenAuthRaw === 'string' ? tokenAuthRaw : null;

    // Confidential-client enforcement: clients registered via the
    // `confidentialClientIds` set MUST present Basic auth at /token. A 4xx
    // here that is NOT `invalid_client`/`invalid_grant` falls through to a
    // generic ServerError in the SDK, which `auth()` rethrows without
    // invalidating any state — so the parent request fails cleanly and the
    // client does not loop. The BYO spec uses this guard to flatten the
    // refresh-Boards → secret-stored race: the auto-triggered OAuth without
    // the secret fails its /token, the connection is dropped, and the
    // follow-up `connection.check` rebuilds a fresh service whose provider
    // carries the secret and gets Basic auth through this gate.
    if (
      clientId.length > 0 &&
      state.confidentialClientIds.has(clientId) &&
      !(typeof tokenAuthRaw === 'string' && tokenAuthRaw.startsWith('Basic '))
    ) {
      pushEvent(state, 'token:error');
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: `${clientId} requires Basic auth at /token`
      });
      return;
    }

    if (grantType !== 'authorization_code') {
      pushEvent(state, 'token:error');
      sendJson(res, 400, {
        error: 'unsupported_grant_type',
        error_description: `grant_type ${grantType} is not supported`
      });
      return;
    }
    pushEvent(state, 'token');
    sendJson(res, 200, {
      access_token: ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: params.get('scope') ?? undefined
    });
    return;
  }

  // Anything else is treated as 404 — fail loud so a route typo in the
  // contract or the SDK is visible in the test output.
  sendJson(res, 404, {
    error: 'mock_route_not_found',
    detail: `${method} ${pathname}`
  });
}
