import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, createMcpToolExtension, mcpToolName } from './mcpToolBridge';
import type { McpServerConfig } from './mcpServerConfig';

const FIXTURE = path.join(__dirname, 'fixtures', 'echoServer.mjs');

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'stdio-1',
    name: 'Echo Tools',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    requireApproval: true,
    ...overrides
  };
}

test('tools are offered as mcp__<server>__<tool> and calls reach the server', async () => {
  const pool = new McpClientPool();
  try {
    const extension = await createMcpToolExtension([stdioServer({ requireApproval: false })], pool);
    assert.ok(extension);
    assert.deepEqual(
      extension.definitions.map(tool => tool.name).sort(),
      ['mcp__echo_tools__echo', 'mcp__echo_tools__fail', 'mcp__echo_tools__whoami']
    );
    const result = await extension.execute('mcp__echo_tools__echo', { text: 'hi' }, async () => 'allow_once');
    assert.deepEqual(result, { ok: true, content: 'echo:hi' });
    const failed = await extension.execute('mcp__echo_tools__fail', {}, async () => 'allow_once');
    assert.equal(failed.ok, false);
    assert.match(failed.content, /boom/);
  } finally {
    await pool.closeAll();
  }
});

test('environment values reach a stdio server', async () => {
  const pool = new McpClientPool();
  try {
    const extension = await createMcpToolExtension(
      [stdioServer({ requireApproval: false, env: { FIXTURE_NAME: 'praxis' } })],
      pool
    );
    const result = await extension!.execute('mcp__echo_tools__whoami', {}, async () => 'allow_once');
    assert.equal(result.content, 'name=praxis');
  } finally {
    await pool.closeAll();
  }
});

test('a server that requires approval asks first, and a denial never reaches it', async () => {
  const pool = new McpClientPool();
  try {
    const extension = await createMcpToolExtension([stdioServer()], pool);
    const asked: Array<{ kind: string; description: string }> = [];
    const denied = await extension!.execute('mcp__echo_tools__echo', { text: 'x' }, async request => {
      asked.push(request);
      return 'deny';
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].kind, 'mcp-tool');
    assert.match(asked[0].description, /Echo Tools › echo/);
    assert.equal(denied.ok, false);
    assert.match(denied.content, /denied/i);
  } finally {
    await pool.closeAll();
  }
});

test('an unreachable server is skipped and reported, not fatal', async () => {
  const pool = new McpClientPool();
  try {
    const broken = stdioServer({ id: 'broken', name: 'Broken', command: process.execPath, args: ['-e', 'process.exit(1)'] });
    const extension = await createMcpToolExtension([broken, stdioServer({ requireApproval: false })], pool);
    assert.ok(extension);
    assert.ok(extension.definitions.some(tool => tool.name.startsWith('mcp__echo_tools__')));
    assert.equal(extension.unavailable.length, 1);
    assert.equal(extension.unavailable[0].name, 'Broken');
    // Nothing reachable at all means no extension, so the session simply has no extra tools.
    assert.equal(await createMcpToolExtension([broken], pool), undefined);
  } finally {
    await pool.closeAll();
  }
});

test('probe lists a server\'s tools without keeping a connection', async () => {
  const pool = new McpClientPool();
  const result = await pool.probe(stdioServer());
  assert.equal(result.serverName, 'echo-fixture');
  assert.deepEqual(result.tools.map(tool => tool.name).sort(), ['echo', 'fail', 'whoami']);
});

test('an HTTP server works too, and headers are sent', async () => {
  const seen: Array<string | undefined> = [];
  const web = http.createServer((req, res) => {
    seen.push(req.headers['x-test-token'] as string | undefined);
    const server = new Server({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'ping', description: 'Pong', inputSchema: { type: 'object', properties: {} } }]
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  const pool = new McpClientPool();
  try {
    const { port } = web.address() as AddressInfo;
    const config: McpServerConfig = {
      id: 'http-1',
      name: 'Remote',
      enabled: true,
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { 'x-test-token': 'secret' },
      requireApproval: false
    };
    const extension = await createMcpToolExtension([config], pool);
    assert.equal(extension?.definitions[0].name, 'mcp__remote__ping');
    const result = await extension!.execute('mcp__remote__ping', {}, async () => 'allow_once');
    assert.deepEqual(result, { ok: true, content: 'pong' });
    assert.ok(seen.every(token => token === 'secret'));
  } finally {
    await pool.closeAll();
    web.close();
  }
});

test('tool names stay within provider limits', () => {
  const server = stdioServer({ name: 'A Rather Long Server Name For Testing' });
  const name = mcpToolName(server, 'x'.repeat(80));
  assert.ok(name.length <= 64);
  assert.match(name, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(mcpToolName(server, 'x'.repeat(80)), mcpToolName(server, 'y'.repeat(80)));
});
