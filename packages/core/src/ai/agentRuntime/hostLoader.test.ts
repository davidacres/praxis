import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DiscoveredAgent } from './manifest';
import { loadAgentHost } from './hostLoader';

function httpHost(url: string): DiscoveredAgent {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'stub-http-host',
      name: 'Stub HTTP host',
      type: 'http',
      entry: { url }
    },
    manifestPath: '/agents/stub-http-host/agent.json',
    rootPath: '/agents/stub-http-host',
    scope: 'global',
    trusted: true,
    errors: []
  };
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('HTTP host reports native skill activation only after accepting it', async () => {
  let activationBody = '';
  await withServer((request, response) => {
    if (request.url === '/capabilities') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ supportsSkills: true, supportsTools: true, version: 'stub-1' }));
      return;
    }
    if (request.url === '/skills/activate' && request.method === 'POST') {
      request.setEncoding('utf8');
      request.on('data', chunk => { activationBody += chunk; });
      request.on('end', () => {
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  }, async url => {
    const host = await loadAgentHost(httpHost(url));
    assert.equal(host.capabilities.supportsSkills, true);
    assert.equal(host.capabilities.version, 'stub-1');
    assert.equal(await host.activateSkill?.({ name: 'review', path: '/skills/review', instructions: 'Review it.' }), true);
  });
  assert.deepEqual(JSON.parse(activationBody), {
    name: 'review',
    path: '/skills/review',
    instructions: 'Review it.'
  });
});

test('HTTP host does not claim native activation when the endpoint refuses it', async () => {
  await withServer((request, response) => {
    if (request.url === '/capabilities') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ supportsSkills: true }));
      return;
    }
    response.statusCode = request.url === '/skills/activate' ? 409 : 404;
    response.end();
  }, async url => {
    const host = await loadAgentHost(httpHost(url));
    assert.equal(await host.activateSkill?.({ name: 'review', path: '/skills/review', instructions: 'Review it.' }), false);
  });
});
