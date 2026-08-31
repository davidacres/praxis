import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { PermissionDecision } from './tools';
import { BROWSER_TOOL_DEFINITIONS, executeBrowserTool, type BrowserBridge } from './tools/browserTools';

/**
 * An HTTP MCP server that exposes the in-app browser tools to ACP agents
 * (Claude Code, Codex) — the counterpart to the gateway path's `toolExtension`.
 * It is bound to loopback, one endpoint per registered session
 * (`/mcp/<token>`), and drives the same `BrowserBridge` (i.e. the same
 * `WebContentsView`). Navigation permission is delegated back to the caller so
 * it can surface in that session's permission card.
 */

export interface BrowserMcpSessionHooks {
  /** Host allow-list for this session (read live, so Settings edits take effect). */
  allowedHosts(): readonly string[];
  /** Prompt the user to allow a navigation to `host`; resolves to their choice. */
  requestNavigatePermission(host: string, url: string): Promise<PermissionDecision>;
  /** Persist a host the user chose "always allow" for. */
  onHostAllowed(host: string): void;
  /** Report each completed tool call so the host can log it on the session. */
  onToolCall?(name: string, ok: boolean, content: string): void;
}

export interface BrowserMcpRegistration {
  /** Opaque per-session token; the path segment and bearer value. */
  token: string;
  /** `http://127.0.0.1:<port>/mcp/<token>` — pass as an ACP `http` MCP server url. */
  url: string;
  /** Remove this session's endpoint. */
  dispose(): void;
}

export interface BrowserMcpServerOptions {
  bridge: BrowserBridge;
  /** Test/dev seam: permit loopback + private hosts. */
  allowPrivateHosts?: boolean;
}

const TOOL_LIST = BROWSER_TOOL_DEFINITIONS.map(tool => ({
  name: tool.name,
  description: tool.description ?? '',
  inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
}));

export class BrowserMcpServer {
  private readonly sessions = new Map<string, BrowserMcpSessionHooks>();
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly options: BrowserMcpServerOptions) {}

  private async ensureListening(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async register(hooks: BrowserMcpSessionHooks): Promise<BrowserMcpRegistration> {
    await this.ensureListening();
    const token = randomUUID();
    this.sessions.set(token, hooks);
    return {
      token,
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      // Only removes this session's endpoint — the shared loopback listener
      // stays up (it's idle and cheap) so re-registering, or another session,
      // never has to rebind on a new port mid-run.
      dispose: () => {
        this.sessions.delete(token);
      }
    };
  }

  /** Full teardown — closes the loopback listener. Not called per session. */
  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private hooksFor(req: http.IncomingMessage): BrowserMcpSessionHooks | undefined {
    const match = /^\/mcp\/([0-9a-f-]{36})\/?$/i.exec((req.url ?? '').split('?')[0]);
    const pathToken = match?.[1];
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    // Both the path segment and the bearer header must name the same live session.
    if (!pathToken || (auth && auth !== pathToken)) return undefined;
    return this.sessions.get(pathToken);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hooks = this.hooksFor(req);
    if (!hooks) {
      res.writeHead(404).end('unknown browser session');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const server = new Server(
      { name: 'praxis-in-app-browser', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const result = await executeBrowserTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        {
          bridge: this.options.bridge,
          allowedHosts: hooks.allowedHosts(),
          allowPrivateHosts: this.options.allowPrivateHosts,
          requestNavigatePermission: hooks.requestNavigatePermission,
          onHostAllowed: hooks.onHostAllowed
        }
      );
      hooks.onToolCall?.(request.params.name, result.ok, result.content);
      return { content: [{ type: 'text', text: result.content }], isError: !result.ok };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
