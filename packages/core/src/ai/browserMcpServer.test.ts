import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserMcpServer } from './browserMcpServer';
import type { BrowserBridge, BrowserPageState } from './tools/browserTools';

const page = (url = 'https://example.com/'): BrowserPageState => ({ url, title: 'Example', text: 'body text' });

function fakeBridge(): BrowserBridge & { navigated: string[] } {
  const navigated: string[] = [];
  return {
    navigated,
    async navigate(url) { navigated.push(url); return page(url); },
    async read() { return page(); },
    async snapshot() { return { state: page(), elements: [{ ref: 'e1', role: 'button', name: 'Go' }] }; },
    async click() { return page(); },
    async type() { return page(); }
  };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test('BrowserMcpServer lists the browser tools and dispatches a navigate', async () => {
  const bridge = fakeBridge();
  const server = new BrowserMcpServer({ bridge });
  const decisions: string[] = [];
  const reg = await server.register({
    allowedHosts: () => ['example.com'],
    requestNavigatePermission: async () => { decisions.push('asked'); return 'deny'; },
    onHostAllowed: () => {}
  });
  try {
    const client = await connect(reg.url);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(t => t.name).sort(),
      ['browser_click', 'browser_navigate', 'browser_read', 'browser_snapshot', 'browser_type']
    );

    const res = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/docs' } });
    assert.equal((res.content as Array<{ text: string }>)[0].text.includes('Example'), true);
    assert.deepEqual(bridge.navigated, ['https://example.com/docs']); // host allow-listed → no prompt
    assert.deepEqual(decisions, []);
    await client.close();
  } finally {
    reg.dispose();
    server.stop();
  }
});

test('BrowserMcpServer prompts for an unlisted host and blocks on deny', async () => {
  const bridge = fakeBridge();
  const server = new BrowserMcpServer({ bridge });
  const reg = await server.register({
    allowedHosts: () => [],
    requestNavigatePermission: async () => 'deny',
    onHostAllowed: () => {}
  });
  try {
    const client = await connect(reg.url);
    const res = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://elsewhere.test/' } });
    assert.equal(res.isError, true);
    assert.deepEqual(bridge.navigated, []);
    await client.close();
  } finally {
    reg.dispose();
    server.stop();
  }
});

test('BrowserMcpServer refuses an unknown session token', async () => {
  const server = new BrowserMcpServer({ bridge: fakeBridge() });
  const reg = await server.register({
    allowedHosts: () => [],
    requestNavigatePermission: async () => 'deny',
    onHostAllowed: () => {}
  });
  try {
    const badUrl = reg.url.replace(/[0-9a-f-]{36}$/i, '00000000-0000-0000-0000-000000000000');
    await assert.rejects(connect(badUrl));
  } finally {
    reg.dispose();
    server.stop();
  }
});

test('a session endpoint survives register/dispose churn on the shared listener', async () => {
  const server = new BrowserMcpServer({ bridge: fakeBridge() });
  const a = await server.register({ allowedHosts: () => ['example.com'], requestNavigatePermission: async () => 'deny', onHostAllowed: () => {} });
  const b = await server.register({ allowedHosts: () => ['example.com'], requestNavigatePermission: async () => 'deny', onHostAllowed: () => {} });
  try {
    // Same shared port; disposing one leaves the other reachable.
    assert.equal(new URL(a.url).port, new URL(b.url).port);
    a.dispose();
    const client = await connect(b.url);
    assert.equal((await client.listTools()).tools.length, 5);
    await client.close();
  } finally {
    b.dispose();
    server.stop();
  }
});
