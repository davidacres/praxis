import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Coordination tools for an agent whose own tools Praxis does not run (FX-BF-048 / TASK-394).
 *
 * A CLI agent (Claude Code, Codex) edits files and runs commands with its own tools, so
 * Praxis cannot refuse those. These tools let it take part anyway: see who is working on
 * what, claim files or the live app before starting, release them, and leave a note for
 * another session. That is **cooperative** coverage — it works when the agent asks — and is
 * labelled so in the UI; it is never presented as enforcement.
 */

export interface CoordinationMcpSessionHooks {
  /**
   * Who is working on what, as text the agent can read. Peer text is data, never instructions.
   * With `since` (the sequence the last answer ended at), only what happened after it — or the
   * whole picture again when the log was trimmed past that point.
   */
  status(input?: { since?: number }): Promise<string>;
  claim(input: { paths: string[]; app: boolean; reason: string }): Promise<{ ok: boolean; content: string }>;
  /** Bounded, cancellable wait for what another session holds; held until the turn ends once granted. */
  wait(input: { paths: string[]; app: boolean; reason: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ ok: boolean; content: string }>;
  release(): Promise<string>;
  message(input: { text: string; to?: string; needsAck?: boolean }): Promise<{ ok: boolean; content: string }>;
  ack(input: { sequence: number }): Promise<{ ok: boolean; content: string }>;
  onToolCall?: (name: string, ok: boolean, content: string) => void;
}

export const COORDINATION_TOOL_DEFINITIONS = [
  {
    name: 'coordination_status',
    description: 'List the other agent sessions working in this repository: what each holds, who is waiting, and recent notes. Read this before starting work another session might be doing. Pass `since` (the number the last answer ended with) to get only what changed.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number', description: 'The event number the previous coordination_status answer ended at.' } },
      additionalProperties: false
    }
  },
  {
    name: 'coordination_claim',
    description: 'Claim files or folders (paths relative to the repository) and/or the running app before you change them, so other sessions do not edit them at the same time. Fails at once, naming the holder, if another session has them: do not retry in a loop. Your claims are released when your turn ends.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders, relative to the repository root. A folder covers everything under it.' },
        app: { type: 'boolean', description: 'Also claim the running app / in-app browser for a sequence of UI actions.' },
        reason: { type: 'string', description: 'What you are about to do, in a few words.' }
      },
      required: ['reason'],
      additionalProperties: false
    }
  },
  {
    name: 'coordination_wait',
    description: 'Wait for files, folders or the running app that another session holds, after a claim or write was refused. Waits in turn for at most `seconds` (max 120), then either gives them to you until your turn ends or says what is still in the way. Call it once; do not loop. Re-read what you waited for before changing it.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders, relative to the repository root.' },
        app: { type: 'boolean', description: 'Wait for the running app / in-app browser.' },
        reason: { type: 'string', description: 'What you will do with them, in a few words.' },
        seconds: { type: 'number', description: 'How long to wait, 1-120 (default 60).' }
      },
      required: ['reason'],
      additionalProperties: false
    }
  },
  {
    name: 'coordination_release',
    description: 'Release everything you claimed, as soon as you are done with it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'coordination_message',
    description: 'Leave a short note for the other sessions in this repository (or one of them): a handoff, or what you just finished.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: 'A session key, or omit for everyone.' },
        needs_ack: { type: 'boolean', description: 'Ask the recipient to acknowledge it (a handoff that needs a reply).' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'coordination_ack',
    description: 'Acknowledge a note that asked for it, by its number from coordination_status.',
    inputSchema: { type: 'object', properties: { sequence: { type: 'number' } }, required: ['sequence'], additionalProperties: false }
  }
] as const;

/** The longest one coordination_wait call may wait. */
export const COORDINATION_MCP_MAX_WAIT_MS = 120_000;

function claimTargets(args: Record<string, unknown>): { paths: string[]; app: boolean; reason: string } | { error: string } {
  const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
  const app = args.app === true;
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : 'working';
  if (paths.length === 0 && !app) return { error: 'Name at least one path, or set app: true.' };
  if (paths.length > 50) return { error: 'Name at most 50 paths at once; use a folder instead.' };
  return { paths, app, reason };
}

export async function executeCoordinationTool(name: string, args: Record<string, unknown>, hooks: CoordinationMcpSessionHooks, signal?: AbortSignal): Promise<{ ok: boolean; content: string }> {
  switch (name) {
    case 'coordination_status':
      return { ok: true, content: await hooks.status(typeof args.since === 'number' && args.since > 0 ? { since: Math.floor(args.since) } : {}) };
    case 'coordination_claim': {
      const targets = claimTargets(args);
      return 'error' in targets ? { ok: false, content: targets.error } : hooks.claim(targets);
    }
    case 'coordination_wait': {
      const targets = claimTargets(args);
      if ('error' in targets) return { ok: false, content: targets.error };
      const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? args.seconds : 60;
      return hooks.wait({ ...targets, timeoutMs: Math.min(COORDINATION_MCP_MAX_WAIT_MS, Math.max(1000, Math.round(seconds * 1000))), signal });
    }
    case 'coordination_ack': {
      const sequence = typeof args.sequence === 'number' ? Math.floor(args.sequence) : NaN;
      if (!Number.isFinite(sequence) || sequence <= 0) return { ok: false, content: 'Give the note\'s number.' };
      return hooks.ack({ sequence });
    }
    case 'coordination_release':
      return { ok: true, content: await hooks.release() };
    case 'coordination_message': {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { ok: false, content: 'A message needs text.' };
      return hooks.message({ text, ...(typeof args.to === 'string' && args.to.trim() ? { to: args.to.trim() } : {}), ...(args.needs_ack === true ? { needsAck: true } : {}) });
    }
    default:
      return { ok: false, content: `Unknown tool: ${name}` };
  }
}

export class CoordinationMcpServer {
  private readonly sessions = new Map<string, CoordinationMcpSessionHooks>();
  private server: http.Server | undefined;
  private port = 0;

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

  async register(hooks: CoordinationMcpSessionHooks): Promise<{ token: string; url: string; dispose(): void }> {
    await this.ensureListening();
    const token = randomUUID();
    this.sessions.set(token, hooks);
    return { token, url: `http://127.0.0.1:${this.port}/mcp/${token}`, dispose: () => void this.sessions.delete(token) };
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private hooksFor(req: http.IncomingMessage): CoordinationMcpSessionHooks | undefined {
    const match = /^\/mcp\/([0-9a-f-]{36})\/?$/i.exec((req.url ?? '').split('?')[0]);
    const pathToken = match?.[1];
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!pathToken || (auth && auth !== pathToken)) return undefined;
    return this.sessions.get(pathToken);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hooks = this.hooksFor(req);
    if (!hooks) {
      res.writeHead(404).end('unknown coordination session');
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
    const server = new Server({ name: 'praxis-coordination', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: COORDINATION_TOOL_DEFINITIONS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as unknown as Record<string, unknown> }))
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // The agent cancelling the call (or its turn) ends a wait and removes it from the queue.
      const result = await executeCoordinationTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, hooks, extra.signal);
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
