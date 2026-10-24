import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_GRANTED, createCodeIntelligenceMcpServer, invokeCodeIntelligence, repositoryNames, type CodeIntelligenceBridgeOptions } from './mcpBridge';
import { mcpServerAppliesToProvider, type McpServerConfig } from '../ai/mcp/mcpServerConfig';

test('stdio searches follow live composer settings for code and knowledge, with explicit overrides', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pci-search-mode-'));
  const mock = path.join(directory, 'service.cjs');
  const settingsPath = path.join(directory, 'settings.json');
  const received = path.join(directory, 'received.json');
  await writeFile(mock, `const fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.writeFileSync(${JSON.stringify(received)},input);console.log(JSON.stringify({schemaVersion:'1.2',repositoryId:request.arguments.repositoryId,indexGeneration:null,queryEpoch:null,error:{code:'INVALID_ARGUMENT',message:'recorded',retryable:false}}));});`);
  const contracts = path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json');
  const client = new Client({ name: 'mode-fixture', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, 'mcpBridge.js'), process.execPath, mock, directory, 'repo', 'codex', contracts],
    env: { ...process.env as Record<string, string>, PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH: settingsPath,
      PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY: '/work/docs' } });
  const configure = (config: unknown) => writeFile(settingsPath, JSON.stringify({ ai: { codeIntelligence: config } }));
  const query = async (tool: string, mode?: string) => {
    await client.callTool({ name: tool, arguments: { query: 'session knowledge', ...(mode ? { mode } : {}) } });
    return JSON.parse(await readFile(received, 'utf8')).arguments;
  };
  try {
    await client.connect(transport);
    for (const mode of ['hybrid', 'lexical', 'vector']) {
      await configure({ searchMode: 'lexical', projectSearchModes: { '/work/docs': mode } });
      for (const tool of ['search_code', 'search_knowledge']) assert.equal((await query(tool)).mode, mode);
    }
    assert.equal((await query('search_code', 'lexical')).mode, 'lexical', 'Explicit tool mode takes precedence');
    await configure({ searchMode: 'hybrid' });
    assert.equal((await query('search_knowledge')).mode, 'hybrid', 'Global preference is the fallback');
    await configure({ searchMode: 'invalid' });
    assert.equal((await query('search_code')).mode, undefined);
    await writeFile(settingsPath, '{broken');
    assert.equal((await query('search_code')).mode, undefined);
    await rm(settingsPath);
    assert.equal((await query('search_code')).mode, undefined);
    await configure({ searchMode: 'vector' });
    await client.callTool({ name: 'get_index_status', arguments: {} });
    assert.equal(JSON.parse(await readFile(received, 'utf8')).arguments.mode, undefined);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

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
    const listed = (await client.listTools()).tools; assert.equal(listed.length, 11);
    // The bridge fixes the repository, so agents are never asked for its opaque ID.
    for (const tool of listed) {
      assert.equal((tool.inputSchema.properties as Record<string, unknown> | undefined)?.repositoryId, undefined, tool.name);
      assert.ok(!(tool.inputSchema.required ?? []).includes('repositoryId'), tool.name);
    }
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
    const read = await client.callTool({ name: 'get_source', arguments: { symbolId: type.symbol.symbolId } }); // ID omitted, as an agent would
    assert.equal(read.isError, false);
    assert.match((content(read).data as { fragments: Array<{ text: string }> }).fragments[0].text, /public class McpNativeExample/);
    const otherRepository = await client.callTool({ name: 'get_index_status', arguments: { repositoryId: 'ungranted-repository' } });
    assert.equal(otherRepository.isError, true);
    assert.equal((content(otherRepository).error as { code: string }).code, 'ACCESS_DENIED');
    const invalid = await client.callTool({ name: 'search_code', arguments: { repositoryId, query: 'McpNativeExample', mode: 'unsupported' } });
    assert.equal(invalid.isError, true);
    assert.equal((content(invalid).error as { code: string }).code, 'INVALID_ARGUMENT');
    assert.equal((await query()).isError, false, 'An invalid request must not break the native MCP session');
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
    const listed = await client.listTools(); assert.equal(listed.tools.length, Object.keys(contracts).length);
    assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint && tool.outputSchema));
    // Every contract tool says when to use it, not just its name.
    assert.ok(listed.tools.every(tool => !tool.description?.includes('registered repository') && tool.description?.includes('may lag edits')), 'every tool has usage guidance');
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


test('stdio MCP cancellation stops an in-flight RPC child and preserves the session', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pci-cancel-'));
  const mock = path.join(directory, 'rpc.cjs');
  const marker = path.join(directory, 'active.praxis.json');
  await writeFile(mock, `const fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const request=JSON.parse(input);if(request.tool==='search_code'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);}else console.log(JSON.stringify({schemaVersion:'1.2',repositoryId:'repo',indexGeneration:null,queryEpoch:null,error:{code:'INVALID_ARGUMENT',message:'Fixture rejection',retryable:false}}));});`);
  const contractsPath = path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json');
  const client = new Client({ name: 'cancellation-fixture', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, 'mcpBridge.js'), process.execPath, mock, directory, 'repo', 'codex', contractsPath], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  let pid: number | undefined;
  const running = (): boolean => {
    if (pid === undefined) return false;
    try { process.kill(pid, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  try {
    await client.connect(transport);
    const controller = new AbortController();
    const request = client.callTool({ name: 'search_code', arguments: { repositoryId: 'repo', query: 'wait', mode: 'lexical' } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(request, /abort|cancel/i);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = (JSON.parse(await readFile(marker, 'utf8')) as { pid: number }).pid; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(pid, 'Cancellation must occur after the RPC child starts');
    assert.ok(running());
    controller.abort();
    await rejected;
    for (let attempt = 0; attempt < 100 && running(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(running(), false, 'MCP cancellation must terminate the in-flight RPC child');
    const response = await client.callTool({ name: 'get_index_status', arguments: { repositoryId: 'repo' } });
    assert.equal(response.isError, true);
    assert.equal(((response.structuredContent as Record<string, unknown>).error as { code: string }).code, 'INVALID_ARGUMENT');
    assert.equal((await client.listTools()).tools.length, 14);
  } finally {
    await client.close();
    if (running()) process.kill(pid!, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('repository names come from root folders and stay unique when names collide', () => {
  const names = repositoryNames([
    { repositoryId: 'pci:repo:aaaaaa111111', root: '/work/TradeStar.api', state: 'ready' },
    { repositoryId: 'pci:repo:bbbbbb222222', root: '/work/1/tradestar.api/', state: 'unknown' },
    { repositoryId: 'pci:repo:cccccc333333', root: '/work/maze', state: 'ready' }
  ]);
  assert.deepEqual(names.map(entry => entry.name), ['maze', 'TradeStar.api-aaaaaa', 'tradestar.api-bbbbbb']);
  assert.equal(names.find(entry => entry.name === 'maze')?.repositoryId, 'pci:repo:cccccc333333');
});

test('an all-granted bridge serves every granted repository by name and refuses the rest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-multi-'));
  const grants = path.join(directory, 'grants.json');
  const received = path.join(directory, 'received.json');
  // `grants` prints the grant file; `rpc` records what the bridge sent and answers with an envelope.
  const mock = path.join(directory, 'service.cjs');
  await writeFile(mock, `const fs=require('node:fs');if(process.argv.includes('grants')){console.log(fs.readFileSync(${JSON.stringify(grants)},'utf8'));}else{let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.writeFileSync(${JSON.stringify(received)},input);const status={schemaVersion:'1.2',repositoryId:request.arguments.repositoryId,indexGeneration:1,queryEpoch:1,freshness:{state:'current',lastReconciledUtc:null,pendingContextCount:0,basis:'observedSnapshot'},data:{desiredRevision:1,contexts:[],jobsByState:{pending:0,leased:0,succeeded:0,failed:0,obsolete:0},models:[],lastReconciledUtc:null,diagnostics:[],ownerState:'mock'},evidence:[],warnings:[],truncated:false,nextCursor:null};const recorded={schemaVersion:'1.2',repositoryId:request.arguments.repositoryId,indexGeneration:null,queryEpoch:null,error:{code:'INVALID_ARGUMENT',message:'recorded by fixture',retryable:false}};console.log(JSON.stringify(request.tool==='get_index_status'?status:recorded));});}`);
  // Other tools answer with a valid error envelope; what matters is what the bridge sent.
  const grant = (...entries: Array<[string, string]>) => writeFile(grants, JSON.stringify({ data: entries.map(([repositoryId, root]) => ({ repositoryId, root, state: 'ready' })) }));
  const contracts = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json'), 'utf8')) as CodeIntelligenceBridgeOptions['contracts'];
  const server = createCodeIntelligenceMcpServer({ executable: process.execPath, assembly: mock, dataDirectory: directory, repositoryId: ALL_GRANTED, client: 'claude-cli', contracts });
  const client = new Client({ name: 'fixture', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const result = (response: unknown): Record<string, unknown> => (response as { structuredContent: Record<string, unknown> }).structuredContent;
  const code = (response: unknown): string | undefined => (result(response).error as { code: string } | undefined)?.code;
  const sent = async (): Promise<{ tool: string; arguments: Record<string, unknown> }> => JSON.parse(await readFile(received, 'utf8'));
  try {
    await grant(['pci:repo:maze1', '/work/maze']);
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, Object.keys(contracts).length + 1);
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
    const search = tools.find(tool => tool.name === 'search_code')!;
    assert.ok((search.inputSchema.properties as Record<string, unknown>).repository);
    assert.equal((search.inputSchema.properties as Record<string, unknown>).repositoryId, undefined);
    assert.ok(!(search.inputSchema.required ?? []).includes('repository'));

    // One granted repository: the name may be omitted.
    assert.equal(code(await client.callTool({ name: 'get_index_status', arguments: {} })), undefined);
    assert.equal((await sent()).arguments.repositoryId, 'pci:repo:maze1');

    // A grant made while the bridge runs is found without restarting it.
    await grant(['pci:repo:maze1', '/work/maze'], ['pci:repo:shop1', '/work/Shop']);
    const listed = result(await client.callTool({ name: 'list_repositories', arguments: {} }));
    assert.deepEqual(listed.repositories, [{ name: 'maze', state: 'ready' }, { name: 'Shop', state: 'ready' }]);
    const ambiguous = await client.callTool({ name: 'get_index_status', arguments: {} });
    assert.equal(code(ambiguous), 'INVALID_ARGUMENT'); assert.match((result(ambiguous).error as { message: string }).message, /maze, Shop/);

    const searched = await client.callTool({ name: 'search_code', arguments: { repository: 'shop', query: 'basket', mode: 'lexical' } });
    assert.match((result(searched).error as { message: string }).message, /recorded by fixture/);
    const request = await sent();
    assert.equal(request.tool, 'search_code'); assert.equal(request.arguments.repositoryId, 'pci:repo:shop1');
    assert.equal(request.arguments.repository, undefined, 'The readable name never reaches the service');
    assert.equal(request.arguments.query, 'basket');
    assert.equal(code(await client.callTool({ name: 'get_index_status', arguments: { repository: 'pci:repo:maze1' } })), undefined);

    const refused = await client.callTool({ name: 'get_index_status', arguments: { repository: 'secret-client-repo' } });
    assert.equal(code(refused), 'ACCESS_DENIED'); assert.match((result(refused).error as { message: string }).message, /Available: maze, Shop/);

    // A revoked grant disappears on the next lookup that misses.
    await grant(['pci:repo:maze1', '/work/maze']);
    assert.deepEqual(result(await client.callTool({ name: 'list_repositories', arguments: {} })).repositories, [{ name: 'maze', state: 'ready' }]);
    await grant();
    assert.equal(code(await client.callTool({ name: 'list_repositories', arguments: {} })), undefined);
    assert.equal(code(await client.callTool({ name: 'get_index_status', arguments: { repository: 'maze' } })), 'ACCESS_DENIED');
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native all-granted bridge follows grants made and revoked while it runs', { skip: !process.env.PRAXIS_CODE_INTELLIGENCE_EXE, timeout: 120_000 }, async () => {
  const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE!;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pci-multi-'));
  const data = path.join(temporary, 'data'); const orders = path.join(temporary, 'orders'); const billing = path.join(temporary, 'billing');
  await mkdir(orders); await mkdir(billing);
  await writeFile(path.join(orders, 'Orders.cs'), 'public class OrderPlacer { public int Place() => 1; }\n');
  await writeFile(path.join(billing, 'Billing.cs'), 'public class InvoiceIssuer { public int Issue() => 2; }\n');
  const owner = spawn(executable, ['serve', '--data', data], { stdio: 'ignore' });
  const client = new Client({ name: 'native-multi-fixture', version: '1.0' });
  const execute = promisify(execFile);
  const invoke = async (...args: string[]): Promise<Record<string, unknown>> => JSON.parse((await execute(executable, [...args, '--data', data], { timeout: 30_000 })).stdout);
  const result = (response: unknown): Record<string, unknown> => (response as { structuredContent: Record<string, unknown> }).structuredContent;
  const code = (response: unknown): string | undefined => (result(response).error as { code: string } | undefined)?.code;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(path.join(data, 'owner.json')); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const register = async (root: string): Promise<string> => {
      const id = ((await invoke('register', root)).data as { repositoryId: string }).repositoryId; await invoke('index', id); return id;
    };
    const ordersId = await register(orders); const billingId = await register(billing);
    await invoke('grant', ordersId, '--client', 'claude-cli');
    await invoke('grant', billingId, '--client', 'codex'); // a different client's grant must stay invisible
    const contractsPath = path.resolve(__dirname, '../../../../services/code-intelligence/contracts.json');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, 'mcpBridge.js'), executable, '-', data, ALL_GRANTED, 'claude-cli', contractsPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => { });
    await client.connect(transport);
    const list = async () => result(await client.callTool({ name: 'list_repositories', arguments: {} })).repositories;
    const search = (repository: string, query: string) => client.callTool({ name: 'search_code', arguments: { repository, query, mode: 'lexical' } });
    assert.deepEqual(await list(), [{ name: 'orders', state: 'ready' }]);
    const found = await search('orders', 'OrderPlacer'); assert.equal(found.isError, false);
    assert.ok((result(found).data as { matches: Array<{ symbol: { qualifiedName: string } }> }).matches.some(match => match.symbol.qualifiedName === 'OrderPlacer'));
    assert.equal(code(await search('billing', 'InvoiceIssuer')), 'ACCESS_DENIED');
    await invoke('grant', billingId, '--client', 'claude-cli');
    assert.deepEqual(await list(), [{ name: 'billing', state: 'ready' }, { name: 'orders', state: 'ready' }]);
    assert.equal((await search('billing', 'InvoiceIssuer')).isError, false);
    await invoke('revoke', ordersId, '--client', 'claude-cli');
    // Even within the bridge's grant cache window, the owner refuses a revoked repository.
    assert.equal(code(await search('orders', 'OrderPlacer')), 'ACCESS_DENIED');
    assert.deepEqual(await list(), [{ name: 'billing', state: 'ready' }]);
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
