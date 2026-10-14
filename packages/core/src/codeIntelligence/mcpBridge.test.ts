import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodeIntelligenceMcpServer, invokeCodeIntelligence, type CodeIntelligenceBridgeOptions } from './mcpBridge';
import { mcpServerAppliesToProvider, type McpServerConfig } from '../ai/mcp/mcpServerConfig';

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
