import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GatewayToolDefinition } from '../gateway';
import type { PermissionDecision } from '../tools';
import { mcpServerSlug, type McpServerConfig } from './mcpServerConfig';

/**
 * Gives API-provider sessions the tools of the MCP servers the user added.
 *
 * CLI agents (ACP) connect to those servers themselves; an API provider has no
 * MCP client of its own, so Praxis connects, lists each server's tools, offers
 * them to the model as ordinary tools named `mcp__<server>__<tool>`, and routes
 * the calls back. One connection per configured server is kept in a pool, so a
 * local (stdio) server is started once rather than per session.
 */

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** A tool result is read by the model, so an oversized one is cut rather than flooding the context. */
const MAX_RESULT_CHARS = 60_000;
const MAX_TOOL_NAME = 64;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpProbeResult {
  serverName?: string;
  tools: McpToolInfo[];
}

interface Connection {
  client: Client;
  tools: McpToolInfo[];
  serverName?: string;
  close(): Promise<void>;
}

function signatureOf(config: McpServerConfig): string {
  return JSON.stringify([config.transport, config.url, config.headers, config.command, config.args, config.env]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openConnection(
  config: McpServerConfig,
  log: (line: string) => void,
  onClosed: () => void
): Promise<Connection> {
  const client = new Client({ name: 'praxis', version: '0.0.1' }, { capabilities: {} });
  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
          requestInit: { headers: config.headers }
        })
      : new StdioClientTransport({
          command: config.command ?? '',
          args: config.args ?? [],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            ),
            ...config.env
          },
          stderr: 'pipe'
        });

  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) log(`[mcp ${config.name}] ${text}`);
    });
  }
  client.onclose = onClosed;

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Servers may page their tool list; a few pages is plenty and bounds a misbehaving one.
    for (let page = 0; page < 10; page += 1) {
      const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const tool of response.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined
        });
      }
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return {
      client,
      tools,
      serverName: client.getServerVersion()?.name,
      close: () => client.close()
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** Flattens an MCP tool result to the text a model can read. */
function resultText(response: unknown): { ok: boolean; content: string } {
  const record = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const item of Array.isArray(record.content) ? record.content : []) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
      const text = (block.resource as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    } else if (typeof block.type === 'string') {
      parts.push(`[${block.type} content omitted]`);
    }
  }
  if (parts.length === 0 && 'structuredContent' in record) parts.push(JSON.stringify(record.structuredContent));
  let content = parts.join('\n') || '(no output)';
  if (content.length > MAX_RESULT_CHARS) {
    content = `${content.slice(0, MAX_RESULT_CHARS)}\n… output truncated (${content.length.toLocaleString()} characters).`;
  }
  return { ok: record.isError !== true, content };
}

export class McpClientPool {
  private readonly connections = new Map<string, { signature: string; promise: Promise<Connection> }>();

  public constructor(private readonly log: (line: string) => void = () => undefined) {}

  /** The server's tools, connecting first if need be. */
  public async tools(config: McpServerConfig): Promise<McpToolInfo[]> {
    return (await this.acquire(config)).tools;
  }

  public async callTool(
    config: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; content: string }> {
    try {
      const connection = await this.acquire(config);
      const response = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS }
      );
      return resultText(response);
    } catch (error) {
      return { ok: false, content: `${config.name} › ${toolName} failed: ${errorText(error)}` };
    }
  }

  /** Connects once without pooling — what the settings "Test" button runs. */
  public async probe(config: McpServerConfig): Promise<McpProbeResult> {
    const connection = await openConnection(config, this.log, () => undefined);
    try {
      return { serverName: connection.serverName, tools: connection.tools };
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  public async close(id: string): Promise<void> {
    const entry = this.connections.get(id);
    this.connections.delete(id);
    if (entry) await entry.promise.then(connection => connection.close(), () => undefined);
  }

  public async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map(id => this.close(id)));
  }

  private acquire(config: McpServerConfig): Promise<Connection> {
    const signature = signatureOf(config);
    const current = this.connections.get(config.id);
    if (current?.signature === signature) return current.promise;
    // The server was edited: drop the old process/connection before starting afresh.
    if (current) void this.close(config.id);

    const entry: { signature: string; promise: Promise<Connection> } = {
      signature,
      promise: openConnection(config, this.log, () => {
        // A server that exits or drops reconnects on the next call.
        if (this.connections.get(config.id) === entry) this.connections.delete(config.id);
      })
    };
    this.connections.set(config.id, entry);
    entry.promise.catch(() => {
      if (this.connections.get(config.id) === entry) this.connections.delete(config.id);
    });
    return entry.promise;
  }
}

/** `mcp__<server>__<tool>`, kept to provider limits and characters. */
export function mcpToolName(server: McpServerConfig, tool: string): string {
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `mcp__${mcpServerSlug(server.name)}__${safeTool}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 6);
  return `${full.slice(0, MAX_TOOL_NAME - 7)}_${hash}`;
}

export interface McpToolExtension {
  definitions: GatewayToolDefinition[];
  execute(
    name: string,
    args: Record<string, unknown>,
    requestPermission: (request: { kind: string; description: string; detail?: string; toolName?: string }) => Promise<PermissionDecision>
  ): Promise<{ ok: boolean; content: string }>;
  /** Servers that were enabled but could not be reached, with why — for the session log. */
  unavailable: Array<{ name: string; reason: string }>;
}

/**
 * The tool extension for a session: every enabled server's tools. A server
 * that cannot be reached is skipped (and reported), never fatal to the session.
 * Returns `undefined` when no server contributed a tool.
 */
export async function createMcpToolExtension(
  servers: readonly McpServerConfig[],
  pool: McpClientPool
): Promise<McpToolExtension | undefined> {
  const settled = await Promise.allSettled(servers.map(server => pool.tools(server)));
  const definitions: GatewayToolDefinition[] = [];
  const owners = new Map<string, { server: McpServerConfig; tool: string }>();
  const unavailable: McpToolExtension['unavailable'] = [];

  settled.forEach((result, index) => {
    const server = servers[index];
    if (result.status === 'rejected') {
      unavailable.push({ name: server.name, reason: errorText(result.reason) });
      return;
    }
    for (const tool of result.value) {
      let name = mcpToolName(server, tool.name);
      for (let n = 2; owners.has(name); n += 1) name = `${mcpToolName(server, tool.name).slice(0, MAX_TOOL_NAME - 3)}_${n}`;
      owners.set(name, { server, tool: tool.name });
      definitions.push({
        name,
        description: `[${server.name}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} }
      });
    }
  });

  if (definitions.length === 0) return undefined;
  return {
    definitions,
    unavailable,
    async execute(name, args, requestPermission) {
      const owner = owners.get(name);
      if (!owner) return { ok: false, content: `Unknown MCP tool: ${name}` };
      if (owner.server.requireApproval) {
        const detail = JSON.stringify(args, null, 2);
        const decision = await requestPermission({
          kind: 'mcp-tool',
          toolName: name,
          description: `Permission requested: ${owner.server.name} › ${owner.tool}`,
          detail: detail.length > 1_500 ? `${detail.slice(0, 1_500)}…` : detail
        });
        if (decision === 'deny') return { ok: false, content: `Permission denied for ${owner.tool}.` };
      }
      return pool.callTool(owner.server, owner.tool, args);
    }
  };
}
