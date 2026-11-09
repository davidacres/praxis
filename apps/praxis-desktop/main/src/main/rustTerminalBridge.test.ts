import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';
import { OPT_IN_MIGRATED_CHANNELS, resolveInitialMigratedChannels } from './rustHostInstance';
import type { TerminalSessionInfo, TerminalContext } from '@praxis/core';

test('terminal selection is complete even when only one stateful channel is requested', t => {
  const before = process.env.PRAXIS_RUST_CHANNELS;
  t.after(() => { if (before === undefined) delete process.env.PRAXIS_RUST_CHANNELS; else process.env.PRAXIS_RUST_CHANNELS = before; });
  process.env.PRAXIS_RUST_CHANNELS = 'terminal:create,settings:set';
  assert.deepEqual(resolveInitialMigratedChannels(false).sort(), OPT_IN_MIGRATED_CHANNELS.filter(channel => channel.startsWith('terminal:')).sort());
  assert.deepEqual(resolveInitialMigratedChannels(true), []);
});

test('real Rust terminal bridge streams, resizes, reports context and cleans up PTYs', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-terminal-'));
  const bridge = new RustHostBridge({ transport: new StdioRustHostTransport({ userDataDir: dir, settingsPath: path.join(dir, 'settings.json') }), getWindows: () => [] });
  t.after(async () => { await bridge.invoke('terminal:dispose').catch(() => undefined); await bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  let output = '';
  let exit = false;
  bridge.onEvent(event => {
    if (event.channel === 'terminal:output') output += (event.payload as { data: string }).data;
    if (event.channel === 'terminal:exit') exit = true;
  });
  const session = await bridge.invoke<TerminalSessionInfo>('terminal:create', { cwd: dir, cols: 80, rows: 24 });
  await bridge.invoke('terminal:write', session.id, 'echo RustTerminalProof\r');
  const deadline = Date.now() + 5000;
  while (!output.includes('RustTerminalProof') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /RustTerminalProof/);
  await bridge.invoke('terminal:resize', session.id, 100, 30);
  const sessions = await bridge.invoke<TerminalSessionInfo[]>('terminal:list');
  assert.ok(sessions.some(item => item.id === session.id));
  assert.match(await bridge.invoke<string>('terminal:getBuffer', session.id), /RustTerminalProof/);
  assert.match((await bridge.invoke<TerminalContext>('terminal:getContext', session.id)).output, /RustTerminalProof/);
  await bridge.invoke('terminal:kill', session.id);
  const exitDeadline = Date.now() + 5000;
  while (!exit && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(exit, true);
});
