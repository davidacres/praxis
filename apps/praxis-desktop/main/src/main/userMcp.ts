import {
  McpClientPool,
  createMcpToolExtension,
  describeMcpServerProblem,
  enabledMcpServers,
  mcpServerSlug,
  sanitizeMcpServers,
  type AcpMcpServer,
  type McpServerConfig,
  type McpTestResult,
  type McpToolExtension
} from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';

/**
 * The MCP servers the user added (Settings → AI Provider → Tools), put in
 * front of their agents.
 *
 * - CLI agents (Claude Code, Codex…) are handed the servers at session start
 *   and connect to them themselves, over ACP.
 * - API providers have no MCP client, so the servers' tools are bridged into
 *   the session's ordinary tool list.
 *
 * Both are full-tools sessions only, like the in-app browser: a user-added
 * server can do whatever its tools allow, so a read-only session never gets it.
 */

const pool = new McpClientPool(line => console.warn(line));

function activeServers(toolMode: string | undefined): McpServerConfig[] {
  if (toolMode !== 'full') return [];
  return enabledMcpServers(getSettingsBackend().read().ai.mcpServers);
}

/** The `mcpServers` entries for an ACP session. */
export function userMcpAcpServers(toolMode: string | undefined): AcpMcpServer[] {
  return activeServers(toolMode).map((server): AcpMcpServer =>
    server.transport === 'http'
      ? { name: mcpServerSlug(server.name), url: server.url ?? '', headers: server.headers }
      : { name: mcpServerSlug(server.name), command: server.command ?? '', args: server.args, env: server.env }
  );
}

/** The tool extension for an API-provider session, or `undefined` when no server contributes a tool. */
export async function userMcpToolExtension(toolMode: string | undefined): Promise<McpToolExtension | undefined> {
  const servers = activeServers(toolMode);
  // A server the user removed or switched off should not keep a process alive.
  const keep = new Set(servers.map(server => server.id));
  for (const server of getSettingsBackend().read().ai.mcpServers ?? []) {
    if (!keep.has(server.id)) void pool.close(server.id);
  }
  if (servers.length === 0) return undefined;
  const extension = await createMcpToolExtension(servers, pool);
  for (const skipped of extension?.unavailable ?? []) {
    console.warn(`[mcp] ${skipped.name} was skipped for this session: ${skipped.reason}`);
  }
  return extension;
}

/** Connects once and lists the tools — what the settings "Test" button shows. */
export async function testUserMcpServer(candidate: McpServerConfig): Promise<McpTestResult> {
  const problem = describeMcpServerProblem(candidate);
  if (problem) return { ok: false, error: problem };
  const [config] = sanitizeMcpServers([{ ...candidate, id: candidate.id || 'test' }]);
  if (!config) return { ok: false, error: 'That server configuration is not valid.' };
  try {
    const result = await pool.probe(config);
    return {
      ok: true,
      serverName: result.serverName,
      tools: result.tools.map(tool => ({ name: tool.name, description: tool.description }))
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function disposeUserMcp(): Promise<void> {
  return pool.closeAll();
}
