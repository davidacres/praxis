import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface CodeIntelligenceBridgeOptions {
  executable: string;
  assembly?: string;
  dataDirectory: string;
  repositoryId: string;
  client: string;
  contracts: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>;
}
const MAXIMUM_REQUEST = 1024 * 1024;
const MAXIMUM_RESPONSE = 128 * 1024;

function failure(repositoryId: string, code: string, message: string): Record<string, unknown> {
  return { schemaVersion: '1.2', repositoryId, indexGeneration: null, queryEpoch: null, error: { code, message, retryable: code === 'CANCELLED' } };
}

export function invokeCodeIntelligence(options: CodeIntelligenceBridgeOptions, tool: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!options.contracts[tool]) return Promise.resolve(failure(options.repositoryId, 'INVALID_ARGUMENT', 'Unknown read-only tool.'));
  if (arguments_.repositoryId !== options.repositoryId) return Promise.resolve(failure(options.repositoryId, 'ACCESS_DENIED', 'This bridge is scoped to one repository.'));
  const payload = JSON.stringify({ tool, arguments: arguments_ });
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

export function createCodeIntelligenceMcpServer(options: CodeIntelligenceBridgeOptions): Server {
  const server = new Server({ name: 'praxis-code-intelligence', version: '1.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(options.contracts).map(([name, schemas]) => ({
    name, description: `Read-only ${name.replaceAll('_', ' ')} for the registered repository. Static facts do not prove runtime behavior.`,
    inputSchema: { ...schemas.inputSchema, type: 'object' as const }, outputSchema: { ...schemas.outputSchema, type: 'object' as const },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await invokeCodeIntelligence(options, request.params.name, request.params.arguments ?? {}, extra.signal);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(result.error) };
  });
  return server;
}

if (require.main === module) {
  const [executable, assembly, dataDirectory, repositoryId, client, contractsPath] = process.argv.slice(2);
  if (!executable || !assembly || !dataDirectory || !repositoryId || !client || !contractsPath) process.exitCode = 2;
  else {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8')) as CodeIntelligenceBridgeOptions['contracts'];
    void createCodeIntelligenceMcpServer({ executable, ...(assembly === '-' ? {} : { assembly }), dataDirectory, repositoryId, client, contracts })
      .connect(new StdioServerTransport()).catch(() => { process.exitCode = 5; });
  }
}
