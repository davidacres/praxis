/**
 * MCP servers the user adds for their AI agents (Settings → AI Provider →
 * Tools). Two transports, because both are common: a remote `http` endpoint,
 * or a local `stdio` command Praxis launches.
 *
 * Deliberately dependency-free: `config/appSettings.ts` sanitizes these on
 * read and merge, and the ACP host and the gateway tool bridge both consume
 * them, so none of those may pull each other in.
 */

export type McpTransport = 'http' | 'stdio';

export interface McpServerConfig {
  /** Stable id, generated when the server is added. */
  id: string;
  /** Shown in the UI and used to name the server's tools (`mcp__<name>__<tool>`). */
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** `http`: the server's endpoint. */
  url?: string;
  /** `http`: request headers, e.g. `Authorization`. */
  headers?: Record<string, string>;
  /** `stdio`: the executable to launch. */
  command?: string;
  /** `stdio`: its arguments. */
  args?: string[];
  /** `stdio`: extra environment variables. */
  env?: Record<string, string>;
  /**
   * Ask before every tool call. On by default because a user-added server can
   * do anything its tools allow; turn off only for a server you trust.
   */
  requireApproval: boolean;
}

/** Names the model sees must stay within provider limits (64 chars, `[a-zA-Z0-9_-]`). */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SERVERS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringMap(value: unknown, namePattern: RegExp): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && namePattern.test(key)) out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps only well-formed entries; a malformed one is dropped rather than failing the whole list. */
export function sanitizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const raw of value) {
    if (out.length >= MAX_SERVERS) break;
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!id || seenIds.has(id) || !NAME_PATTERN.test(name)) continue;
    // Tool names are derived from the name, so two servers may not share one.
    if (seenNames.has(mcpServerSlug(name))) continue;

    const transport: McpTransport | undefined =
      raw.transport === 'http' || raw.transport === 'stdio' ? raw.transport : undefined;
    if (!transport) continue;

    const base = {
      id,
      name,
      enabled: raw.enabled !== false,
      transport,
      requireApproval: raw.requireApproval !== false
    };
    let entry: McpServerConfig;
    if (transport === 'http') {
      const url = readUrl(raw.url);
      if (!url) continue;
      const headers = readStringMap(raw.headers, HEADER_NAME_PATTERN);
      entry = { ...base, url, ...(headers ? { headers } : {}) };
    } else {
      const command = typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!command) continue;
      const args = Array.isArray(raw.args)
        ? raw.args.filter((arg): arg is string => typeof arg === 'string')
        : [];
      const env = readStringMap(raw.env, ENV_NAME_PATTERN);
      entry = { ...base, command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) };
    }
    seenIds.add(id);
    seenNames.add(mcpServerSlug(name));
    out.push(entry);
  }
  return out;
}

/** `GitHub Tools` → `github_tools`: the server's part of a tool name. */
export function mcpServerSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'server';
}

/** Why a config cannot be used, or `undefined` when it is complete. For the settings form. */
export function describeMcpServerProblem(config: Partial<McpServerConfig>): string | undefined {
  const name = config.name?.trim() ?? '';
  if (!NAME_PATTERN.test(name)) {
    return 'Name must start with a letter or number and use letters, numbers, spaces, dots, dashes or underscores (48 characters at most).';
  }
  if (config.transport === 'http') {
    if (!readUrl(config.url)) return 'Enter a full http:// or https:// URL.';
    return undefined;
  }
  if (config.transport === 'stdio') {
    if (!config.command?.trim()) return 'Enter the command to run.';
    return undefined;
  }
  return 'Choose a transport.';
}

/** Servers an agent session should be given: enabled ones only. */
export function enabledMcpServers(servers: readonly McpServerConfig[] | undefined): McpServerConfig[] {
  return (servers ?? []).filter(server => server.enabled);
}

/** What the settings "Test" button shows: the server's tools, or why it could not be reached. */
export type McpTestResult =
  | { ok: true; serverName?: string; tools: Array<{ name: string; description?: string }> }
  | { ok: false; error: string };
