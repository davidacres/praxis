import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StdioRustHostTransport } from './rustHostBridge';

/**
 * A stand-in `praxis-host`: emits `ready`, then one `call` frame, and echoes the
 * `callResponse` it receives back as an `event` so the test can observe the wire reply.
 */
function writeFakeHost(dir: string, callMethod: string): string {
  const script = path.join(dir, 'fake-host.js');
  fs.writeFileSync(script, `#!/usr/bin/env node
const readline = require('node:readline');
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ kind: 'ready', status: { protocolVersion: 1 }, registeredChannels: [] });
out({ kind: 'call', id: 'c1', method: ${JSON.stringify(callMethod)}, params: { n: 1 } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.kind === 'callResponse') out({ kind: 'event', envelope: { channel: 'test:reply', payload: msg } });
});
`, { mode: 0o755 });
  return script;
}

async function runCall(onCall: ((method: string, params: unknown) => Promise<unknown>) | undefined, method = 'mobile.read'): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-host-call-'));
  try {
    const transport = new StdioRustHostTransport({
      executablePath: writeFakeHost(dir, method),
      userDataDir: dir,
      settingsPath: path.join(dir, 'settings.json'),
      ...(onCall ? { onCall } : {})
    });
    const reply = new Promise<unknown>(resolve => {
      transport.onEvent(envelope => {
        if (envelope.channel === 'test:reply') resolve(envelope.payload);
      });
    });
    await transport.start();
    const payload = await reply;
    await transport.dispose();
    return payload;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('host call frames are served by onCall and answered with a callResponse', async () => {
  const seen: Array<[string, unknown]> = [];
  const payload = await runCall(async (method, params) => {
    seen.push([method, params]);
    return { echoed: params };
  });
  assert.deepEqual(seen, [['mobile.read', { n: 1 }]]);
  assert.deepEqual(payload, { kind: 'callResponse', id: 'c1', ok: true, result: { echoed: { n: 1 } } });
});

test('a throwing handler becomes an ok:false callResponse', async () => {
  const payload = await runCall(async () => {
    throw new Error('denied');
  });
  assert.deepEqual(payload, { kind: 'callResponse', id: 'c1', ok: false, error: 'denied' });
});

test('without a handler the call is refused immediately rather than left to time out', async () => {
  const payload = (await runCall(undefined, 'mobile.command')) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /No handler for host call "mobile.command"/);
});
