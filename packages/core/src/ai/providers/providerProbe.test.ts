import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { probeOpenAiCompatible } from './providerProbe';

interface MockBehaviour {
  models?: 'ok' | 'missing' | 'unauthorized';
  tools?: boolean;
  rejectStreamOptions?: boolean;
}

/** A tiny OpenAI-compatible server whose gaps are switchable, one per probe step. */
async function withServer(behaviour: MockBehaviour, run: (url: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (behaviour.models === 'unauthorized') return json(401, { error: { message: 'Invalid API key sk-test-secret' } });
      if (req.url === '/v1/models') {
        return behaviour.models === 'missing' ? json(404, { error: 'not found' }) : json(200, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
      }
      const payload = JSON.parse(body) as { stream?: boolean; stream_options?: unknown; tools?: unknown };
      if (payload.stream) {
        if (payload.stream_options && behaviour.rejectStreamOptions) return json(400, { error: { message: 'Unknown field stream_options' } });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        if (payload.stream_options) res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if (payload.tools && behaviour.tools !== false) {
        return json(200, { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_time', arguments: '{"timezone":"UTC"}' } }] } }] });
      }
      return json(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const statuses = (result: Awaited<ReturnType<typeof probeOpenAiCompatible>>) => result.steps.map(step => `${step.id}:${step.status}`);

test('a fully compatible server passes every step', async () => {
  await withServer({}, async (url, seen) => {
    const result = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true, apiKey: 'k' });
    assert.deepEqual(statuses(result), ['models:pass', 'chat:pass', 'streaming:pass', 'tools:pass']);
    assert.deepEqual(result.models, ['model-a', 'model-b']);
    assert.equal(result.capabilities.model, 'model-a');
    assert.equal(result.capabilities.streamUsage, true);
    assert.ok(seen.every(line => line.endsWith('auth=Bearer k')));
  });
});

test('a model without tool calling fails only the tool step', async () => {
  await withServer({ tools: false }, async url => {
    const result = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true, auth: { kind: 'none' } }, 'model-b');
    assert.deepEqual(statuses(result), ['models:pass', 'chat:pass', 'streaming:pass', 'tools:fail']);
    assert.equal(result.capabilities.tools, false);
    assert.equal(result.capabilities.model, 'model-b');
    assert.match(result.steps[3].detail, /answered in text/);
  });
});

test('a server that rejects stream_options still streams, without usage', async () => {
  await withServer({ rejectStreamOptions: true }, async url => {
    const result = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true });
    assert.equal(result.capabilities.streaming, true);
    assert.equal(result.capabilities.streamUsage, false);
    assert.match(result.steps[2].detail, /rejected the usage option/);
  });
});

test('no /models is reported, and the rest runs against the given model', async () => {
  await withServer({ models: 'missing' }, async url => {
    const result = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true }, 'model-a');
    assert.deepEqual(statuses(result), ['models:fail', 'chat:pass', 'streaming:pass', 'tools:pass']);
    const withoutModel = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true });
    assert.deepEqual(statuses(withoutModel), ['models:fail', 'chat:skipped', 'streaming:skipped', 'tools:skipped']);
  });
});

test('a rejected key stops after the first step and never echoes the key', async () => {
  await withServer({ models: 'unauthorized' }, async url => {
    const result = await probeOpenAiCompatible({ url, apiPath: '/v1', exactPath: true, apiKey: 'sk-test-secret' });
    assert.deepEqual(statuses(result), ['models:fail', 'chat:skipped', 'streaming:skipped', 'tools:skipped']);
    assert.match(result.steps[0].detail, /API key rejected/);
    assert.ok(!JSON.stringify(result).includes('sk-test-secret'));
  });
});

test('an unreachable server is a failed first step, not a throw', async () => {
  const result = await probeOpenAiCompatible({ url: 'http://127.0.0.1:9', apiPath: '/v1', exactPath: true });
  assert.equal(result.steps[0].status, 'fail');
  assert.match(result.steps[0].detail, /Can't reach/);
});
