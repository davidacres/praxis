import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodeIntelligenceMcpServer, invokeCodeIntelligence, type CodeIntelligenceBridgeOptions } from './mcpBridge';
import { mcpServerAppliesToProvider, type McpServerConfig } from '../ai/mcp/mcpServerConfig';

test('native stdio MCP reads indexed source only with the selected provider grant', { skip: !process.env.PRAXIS_CODE_INTELLIGENCE_EXE }, async () => {
  const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE!;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pci-mcp-'));
  const source = path.join(temporary, 'source'); const data = path.join(temporary, 'data');
  await mkdir(source); await writeFile(path.join(source, 'Example.cs'), 'public class McpNativeExample { public int Compute() => 42; }\n');
  const owner = spawn(executable, ['serve', '--data', data], { stdio: 'ignore' });
  let startupError: Error | undefined; owner.on('error', error => { startupError = error; });
  const client = new Client({ name: 'native-fixture', version: '1.0' });
  const execute = promisify(execFile);
  const invoke = async (...args: string[]): Promise<Record<string, unknown>> => JSON.parse((await execute(executable, [...args, '--data', data], { timeout: 30_000 })).stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (owner.exitCode !== null) throw new Error(`Fixture owner exited: ${owner.exitCode}`);
      try { await access(path.join(data, 'owner.json')); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'Fixture owner did not start.');
    const repositoryId = ((await invoke('register', source)).data as { repositoryId: string }).repositoryId;
    await invoke('index', repositoryId);
    const contractsPath = path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, 'mcpBridge.js'), executable, '-', data, repositoryId, 'codex', contractsPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => { });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 11);
    const content = (response: unknown): Record<string, unknown> => {
      assert.ok(response && typeof response === 'object');
      const value = (response as Record<string, unknown>).structuredContent;
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      return value as Record<string, unknown>;
    };
    const query = () => client.callTool({ name: 'search_code', arguments: { repositoryId, query: 'McpNativeExample', mode: 'lexical' } });
    const denied = await query(); assert.equal(denied.isError, true);
    assert.equal((content(denied).error as { code: string }).code, 'ACCESS_DENIED');
    await invoke('grant', repositoryId, '--client', 'different-provider');
    assert.equal((await query()).isError, true);
    await invoke('grant', repositoryId, '--client', 'codex');
    const found = await query(); assert.equal(found.isError, false);
    const matches = (content(found).data as { matches: Array<{ symbol: { symbolId: string; qualifiedName: string } }> }).matches;
    const type = matches.find(match => match.symbol.qualifiedName === 'McpNativeExample'); assert.ok(type);
    const read = await client.callTool({ name: 'get_source', arguments: { repositoryId, symbolId: type.symbol.symbolId } });
    assert.equal(read.isError, false);
    assert.match((content(read).data as { fragments: Array<{ text: string }> }).fragments[0].text, /public class McpNativeExample/);
    const otherRepository = await client.callTool({ name: 'get_index_status', arguments: { repositoryId: 'ungranted-repository' } });
    assert.equal(otherRepository.isError, true);
    assert.equal((content(otherRepository).error as { code: string }).code, 'ACCESS_DENIED');
    await invoke('revoke', repositoryId, '--client', 'codex');
    const revoked = await query(); assert.equal(revoked.isError, true);
    assert.equal((content(revoked).error as { code: string }).code, 'ACCESS_DENIED');
  } finally {
    try { await client.close(); }
    finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const closed = once(owner, 'close'); owner.kill('SIGINT');
        const force = setTimeout(() => owner.kill('SIGKILL'), 3000);
        try { await closed; } finally { clearTimeout(force); }
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test('MCP SDK initialize/list/call uses scoped RPC and normative error envelopes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-ci-'));
  const mock = path.join(directory, 'rpc.cjs');
  await writeFile(mock, `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const request=JSON.parse(input);console.log(JSON.stringify({schemaVersion:'1.2',repositoryId:request.arguments.repositoryId,indexGeneration:1,queryEpoch:1,freshness:{state:'current',lastReconciledUtc:null,pendingContextCount:0,basis:'observedSnapshot'},data:{desiredRevision:1,contexts:[],jobsByState:{pending:0,leased:0,succeeded:0,failed:0,obsolete:0},models:[],lastReconciledUtc:null,diagnostics:[],ownerState:'mock'},evidence:[],warnings:[],truncated:false,nextCursor:null}));});`);
  const contracts = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json'), 'utf8')) as CodeIntelligenceBridgeOptions['contracts'];
  const options = { executable: process.execPath, assembly: mock, dataDirectory: directory, repositoryId: 'repo', client: 'codex', contracts };
  const server = createCodeIntelligenceMcpServer(options); const client = new Client({ name: 'fixture', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const listed = await client.listTools(); assert.equal(listed.tools.length, 11);
    assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint && tool.outputSchema));
    const called = await client.callTool({ name: 'get_index_status', arguments: { repositoryId: 'repo' } });
    assert.equal(called.isError, false); assert.equal((called.structuredContent as Record<string, unknown> | undefined)?.schemaVersion, '1.2');
    const denied = await client.callTool({ name: 'get_index_status', arguments: { repositoryId: 'different' } });
    assert.equal(denied.isError, true); assert.equal(((denied.structuredContent as Record<string, unknown> | undefined)?.error as { code: string }).code, 'ACCESS_DENIED');
    const controller = new AbortController(); controller.abort();
    const cancelled = await invokeCodeIntelligence(options, 'get_index_status', { repositoryId: 'repo' }, controller.signal);
    assert.equal((cancelled.error as { code: string }).code, 'CANCELLED');
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('provider handover cannot inherit a different code egress grant', () => {
  const generic: McpServerConfig = { id: 'ordinary', name: 'Ordinary', enabled: true, transport: 'stdio', command: 'node', requireApproval: true };
  assert.equal(mcpServerAppliesToProvider(generic, 'codex'), true);
  const scoped: McpServerConfig = { ...generic, id: 'praxis-code-intelligence-fixture', env: { PRAXIS_CODE_INTELLIGENCE_PROVIDER: 'codex' } };
  assert.equal(mcpServerAppliesToProvider(scoped, 'codex'), true); assert.equal(mcpServerAppliesToProvider(scoped, 'claude-code'), false);
  assert.equal(mcpServerAppliesToProvider({ ...scoped, env: undefined }, 'codex'), false);
  assert.equal(mcpServerAppliesToProvider({ ...generic, args: ['/code/codeIntelligence/mcpBridge.js'] }, 'codex'), false);
});
