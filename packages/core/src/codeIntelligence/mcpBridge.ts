import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface CodeIntelligenceBridgeOptions {
  executable: string;
  assembly?: string;
  dataDirectory: string;
  /** One repository ID, or {@link ALL_GRANTED} to serve every repository granted to `client`. */
  repositoryId: string;
  client: string;
  /** Read the composer's saved preference for each query, including changes mid-session. */
  settingsPath?: string;
  workingDirectory?: string;
  contracts: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>;
}
/** Bridge repository argument meaning "every repository this client holds a grant for". */
export const ALL_GRANTED = '*';
export interface GrantedRepository { name: string; repositoryId: string; state: string }
const MAXIMUM_REQUEST = 1024 * 1024;
const MAXIMUM_RESPONSE = 128 * 1024;
const GRANT_CACHE_MS = 10_000;

function failure(repositoryId: string, code: string, message: string): Record<string, unknown> {
  return { schemaVersion: '1.2', repositoryId, indexGeneration: null, queryEpoch: null, error: { code, message, retryable: code === 'CANCELLED' } };
}

export function invokeCodeIntelligence(options: CodeIntelligenceBridgeOptions, tool: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!options.contracts[tool]) return Promise.resolve(failure(options.repositoryId, 'INVALID_ARGUMENT', 'Unknown read-only tool.'));
  // The bridge serves exactly one repository: an omitted ID means that one; any other ID is refused.
  if (arguments_.repositoryId !== undefined && arguments_.repositoryId !== options.repositoryId) return Promise.resolve(failure(options.repositoryId, 'ACCESS_DENIED', 'This bridge is scoped to one repository.'));
  const mode = savedSearchMode(options, tool, arguments_);
  const payload = JSON.stringify({ tool, arguments: { ...arguments_, ...(mode ? { mode } : {}), repositoryId: options.repositoryId } });
  if (Buffer.byteLength(payload) > MAXIMUM_REQUEST) return Promise.resolve(failure(options.repositoryId, 'INPUT_TOO_LARGE', 'Query exceeds the request limit.'));
  if (signal?.aborted) return Promise.resolve(failure(options.repositoryId, 'CANCELLED', 'Query cancelled.'));
  return new Promise(resolve => {
    const args = [...(options.assembly ? [options.assembly] : []), 'rpc', '--data', options.dataDirectory, '--client', options.client];
    const child = spawn(options.executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const decoder = new StringDecoder('utf8'); let output = ''; let bytes = 0; let settled = false;
    const finish = (value: Record<string, unknown>): void => { if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', cancel); resolve(value); };
    const cancel = (): void => { child.kill(); finish(failure(options.repositoryId, 'CANCELLED', 'Query cancelled.')); };
    const timeout = setTimeout(() => { child.kill(); finish(failure(options.repositoryId, 'TIMEOUT', 'Local query timed out.')); }, 120_000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAXIMUM_RESPONSE) { child.kill(); finish(failure(options.repositoryId, 'INPUT_TOO_LARGE', 'Local response exceeds the limit.')); }
      else output += decoder.write(chunk);
    });
    child.stderr.on('data', () => { /* Never copy local diagnostics/paths into a provider response. */ });
    child.stdin.on('error', () => { });
    child.on('error', () => finish(failure(options.repositoryId, 'CAPABILITY_UNAVAILABLE', 'Local code intelligence service could not start.')));
    child.on('close', () => {
      if (settled) return;
      try {
        const value: unknown = JSON.parse(output + decoder.end());
        if (typeof value !== 'object' || value === null || Array.isArray(value) || !('schemaVersion' in value)) throw new Error();
        finish(value as Record<string, unknown>);
      } catch { finish(failure(options.repositoryId, 'INTERNAL_ERROR', 'Local service returned no valid tool envelope.')); }
    });
    child.stdin.end(payload);
  });
}

function savedSearchMode(options: CodeIntelligenceBridgeOptions, tool: string, arguments_: Record<string, unknown>): string | undefined {
  if ((tool !== 'search_code' && tool !== 'search_knowledge') || arguments_.mode !== undefined || !options.settingsPath) return undefined;
  try {
    const settings = JSON.parse(readFileSync(options.settingsPath, 'utf8'));
    const config = settings?.ai?.codeIntelligence;
    const directory = options.workingDirectory;
    const mode = (directory ? config?.projectSearchModes?.[directory] ?? config?.projectSearchModes?.[path.resolve(directory)] : undefined)
      ?? config?.searchMode;
    return mode === 'hybrid' || mode === 'lexical' || mode === 'vector' ? mode : undefined;
  } catch {
    // Missing or unreadable settings retain the service's automatic search policy.
    return undefined;
  }
}

/**
 * Readable names for granted repositories: the root folder's name, with a short ID suffix
 * when two roots share a name (ignoring case, so `TradeStar.api` and `tradestar.api` differ).
 */
export function repositoryNames(entries: ReadonlyArray<{ repositoryId: string; root: string; state: string }>): GrantedRepository[] {
  const base = (root: string): string => path.basename(root.replace(/[/\\]+$/, '')) || 'repository';
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(base(entry.root).toLowerCase(), (counts.get(base(entry.root).toLowerCase()) ?? 0) + 1);
  return entries.map(entry => {
    const name = base(entry.root);
    const suffix = entry.repositoryId.replace(/^pci:repo:/, '').slice(0, 6);
    return { name: (counts.get(name.toLowerCase()) ?? 0) > 1 ? `${name}-${suffix}` : name, repositoryId: entry.repositoryId, state: entry.state };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** Repositories `options.client` may currently query, read from the owner's grant records. */
export function listGrantedRepositories(options: CodeIntelligenceBridgeOptions): Promise<GrantedRepository[]> {
  return new Promise((resolve, reject) => {
    const args = [...(options.assembly ? [options.assembly] : []), 'grants', '--data', options.dataDirectory, '--client', options.client];
    const child = spawn(options.executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const decoder = new StringDecoder('utf8'); let output = ''; let bytes = 0;
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAXIMUM_RESPONSE) child.kill(); else output += decoder.write(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', () => {
      clearTimeout(timeout);
      try {
        const value = JSON.parse(output + decoder.end()) as { data?: unknown };
        if (!Array.isArray(value.data)) throw new Error('Grant listing failed.');
        resolve(repositoryNames(value.data.filter((entry): entry is { repositoryId: string; root: string; state: string } =>
          typeof entry?.repositoryId === 'string' && typeof entry?.root === 'string' && typeof entry?.state === 'string')));
      } catch (error) { reject(error instanceof Error ? error : new Error('Grant listing failed.')); }
    });
  });
}

// Agents cannot know the opaque repository ID, and the bridge already fixes it.
function withoutRepository(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, unknown> | undefined) }; delete properties.repositoryId;
  const required = Array.isArray(schema.required) ? schema.required.filter(name => name !== 'repositoryId') : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

// When to reach for each tool. The generic contract name alone gave agents no reason to prefer it over grep.
const TOOL_GUIDANCE: Record<string, string> = {
  search_code: 'Find code by concept or name when you do not know the exact identifier ("where is session handover handled"). Leave mode unset to follow the session composer\'s saved search preference, or automatic search when none is saved.',
  find_symbol: 'Find where a class, function, method or field is declared, by name or qualified name. Returns symbol IDs for the other tools.',
  get_symbol: 'Get the declaration, kind and signature of a symbol ID.',
  get_source: 'Read the source of a symbol, file or range found by another tool, without opening the whole file.',
  explain_symbol: 'Get the structural facts about a symbol, with evidence and any uncertainties, as an orientation before reading its source.',
  get_callers: 'List what calls a symbol. Use instead of grepping for its name: it skips comments, strings and look-alike names.',
  get_callees: 'List what a symbol calls.',
  trace_flow: 'Follow call paths from a symbol, outgoing or incoming, several levels deep in one call.',
  find_related: 'Find structural and semantic neighbours of a symbol, each with the reason it is related.',
  summarize_project: 'Summarize one project\'s components, index coverage and unresolved boundaries.',
  get_index_status: 'Check whether the index is current. Call it when results look empty, partial or stale.',
  search_knowledge: 'Search the repository\'s docs and plans (Markdown and similar) by concept or keyword. Leave mode unset to follow the session composer\'s saved search preference.',
  get_knowledge_section: 'Read one docs section found by search_knowledge.',
  find_related_knowledge: 'Find docs that mention a symbol, file or ticket.'
};
const STATIC_CAVEAT = 'Read-only and static: results do not prove runtime behavior, and may lag edits made moments ago.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REPOSITORY_ARGUMENT = { type: 'string', minLength: 1, maxLength: 512,
  description: 'Repository name from list_repositories. May be omitted when only one repository is available.' };

export function createCodeIntelligenceMcpServer(options: CodeIntelligenceBridgeOptions): Server {
  const server = new Server({ name: 'praxis-code-intelligence', version: '1.2.0' }, { capabilities: { tools: {} } });
  const multiple = options.repositoryId === ALL_GRANTED;
  let granted: { at: number; repositories: Promise<GrantedRepository[]> } | undefined;
  const repositories = (refresh: boolean): Promise<GrantedRepository[]> => {
    if (refresh || !granted || Date.now() - granted.at > GRANT_CACHE_MS) {
      granted = { at: Date.now(), repositories: listGrantedRepositories(options) };
      granted.repositories.catch(() => { granted = undefined; });
    }
    return granted.repositories;
  };
  // A repository named by the agent: its readable name (any case) or its ID. Failures name
  // what was requested (or '*'): the envelope's repositoryId must be a non-empty string. The cache only
  // speeds this up; the owner re-checks the grant on every query.
  const resolve = async (requested: string | undefined): Promise<GrantedRepository | Record<string, unknown>> => {
    for (const refresh of [false, true]) {
      const available = await repositories(refresh);
      if (requested === undefined) {
        if (available.length === 1) return available[0];
        if (refresh) return failure(ALL_GRANTED, available.length ? 'INVALID_ARGUMENT' : 'ACCESS_DENIED', available.length
          ? `Name the repository: ${available.map(entry => entry.name).join(', ')}.` : 'No repository has been granted to this client.');
        continue;
      }
      const found = available.find(entry => entry.name === requested || entry.repositoryId === requested)
        ?? available.find(entry => entry.name.toLowerCase() === requested.toLowerCase());
      if (found) return found;
    }
    const names = (await repositories(false)).map(entry => entry.name);
    return failure(requested ?? ALL_GRANTED, 'ACCESS_DENIED', `Repository is not available to this client.${names.length ? ` Available: ${names.join(', ')}.` : ''}`);
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    ...(multiple ? [{
      name: 'list_repositories', description: 'Lists the repositories these code intelligence tools can read, with their index state. Pass a name as `repository` to the other tools.',
      inputSchema: { type: 'object' as const, properties: {} }, annotations: READ_ONLY
    }] : []),
    ...Object.entries(options.contracts).map(([name, schemas]) => {
      const input = withoutRepository(schemas.inputSchema);
      return {
        name, description: `${TOOL_GUIDANCE[name] ?? `${name.replaceAll('_', ' ')} for ${multiple ? 'a granted repository' : 'the registered repository'}.`} ${STATIC_CAVEAT}`,
        inputSchema: { ...input, ...(multiple ? { properties: { repository: REPOSITORY_ARGUMENT, ...(input.properties as Record<string, unknown> | undefined) } } : {}), type: 'object' as const },
        outputSchema: { ...schemas.outputSchema, type: 'object' as const }, annotations: READ_ONLY
      };
    })
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const respond = (result: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(result.error) });
    const arguments_ = { ...(request.params.arguments ?? {}) };
    if (!multiple) return respond(await invokeCodeIntelligence(options, request.params.name, arguments_, extra.signal));
    try {
      if (request.params.name === 'list_repositories') {
        const available = await repositories(true);
        return respond({ repositories: available.map(entry => ({ name: entry.name, state: entry.state })) });
      }
      const requested = arguments_.repository ?? arguments_.repositoryId;
      delete arguments_.repository; delete arguments_.repositoryId;
      if (requested !== undefined && typeof requested !== 'string') return respond(failure(ALL_GRANTED, 'INVALID_ARGUMENT', 'repository must be a string.'));
      const target = await resolve(requested);
      if ('error' in target) return respond(target);
      return respond(await invokeCodeIntelligence({ ...options, repositoryId: (target as GrantedRepository).repositoryId }, request.params.name, arguments_, extra.signal));
    } catch {
      return respond(failure(ALL_GRANTED, 'CAPABILITY_UNAVAILABLE', 'Local code intelligence service could not list granted repositories.'));
    }
  });
  return server;
}

if (require.main === module) {
  // repositoryId may be ALL_GRANTED ('*'): one server for every repository granted to the client.
  const [executable, assembly, dataDirectory, repositoryId, client, contractsPath] = process.argv.slice(2);
  if (!executable || !assembly || !dataDirectory || !repositoryId || !client || !contractsPath) process.exitCode = 2;
  else {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8')) as CodeIntelligenceBridgeOptions['contracts'];
    void createCodeIntelligenceMcpServer({ executable, ...(assembly === '-' ? {} : { assembly }), dataDirectory, repositoryId, client, contracts,
      settingsPath: process.env.PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH,
      workingDirectory: process.env.PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY })
      .connect(new StdioServerTransport()).catch(() => { process.exitCode = 5; });
  }
}
