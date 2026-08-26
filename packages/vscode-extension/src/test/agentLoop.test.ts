import * as assert from 'assert';
import * as http from 'node:http';
import { resolveProviderAdapter, runAgentLoop } from '../ai/agentRuntime';
import type { GatewayToolDefinition } from '../ai/gateway';

suite('agentLoop', () => {
  test('runs tool call then completes on second model turn', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/chat/completions')) {
        res.statusCode = 404;
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        requestCount += 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'close'
        });

        if (requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"content":"I will list files."}}]}\n\n'
          );
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_dir","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n'
          );
          res.write('data: [DONE]\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    const tools: GatewayToolDefinition[] = [
      {
        name: 'list_dir',
        description: 'List directory',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
      }
    ];

    const events: string[] = [];
    try {
      const result = await runAgentLoop({
        adapter: resolveProviderAdapter('vercel-gateway'),
        gateway: { url: `http://127.0.0.1:${port}`, apiKey: 'test-key' },
        modelId: 'test/model',
        systemPrompt: 'You are a test agent.',
        tools,
        userPrompt: 'List files',
        maxSteps: 10,
        timeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        toolExecutor: {
          async execute(name, args) {
            assert.strictEqual(name, 'list_dir');
            assert.deepStrictEqual(args, { path: '.' });
            return { ok: true, content: 'a.ts\nb.ts' };
          }
        },
        onEvent: event => {
          events.push(event.type);
        }
      });

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.text, 'Done.');
      assert.strictEqual(result.stepCount, 1);
      assert.ok(events.includes('tool_start'));
      assert.ok(events.includes('tool_complete'));
      assert.ok(events.includes('completed'));
      assert.strictEqual(requestCount, 2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      );
    }
  });
});
