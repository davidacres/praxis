#!/usr/bin/env node
// An ACP agent fixture that works slowly, so a test can see whether cancelling a
// turn really stops it. Everything it does is recorded in its working folder:
//
//   agent-log.txt  one line per lifecycle event (prompt received, cancel received, exit)
//   ticks.txt      a line every 100 ms while it "works" — written directly, as a CLI
//                  agent's own edit tool would, not through Praxis
//   late.txt       written by a subprocess it starts (a tool's command) after 4 s
//
// SLOW_START_MS delays the handshake, like a CLI that takes a moment to start.
// IGNORE_CANCEL=1 makes it ignore `session/cancel`, like a wedged agent.

import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);
const log = line => appendFileSync('agent-log.txt', `${Date.now()} ${line}\n`);
// Praxis also starts the agent just to check it (from its own folder): only a run that was
// given work records how it ended.
let prompted = false;
process.on('exit', () => prompted && log('exit'));
process.on('SIGTERM', () => {
  if (prompted) log('sigterm');
  process.exit(0);
});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'slow-work-acp-agent' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let cancelled = false;

app.onRequest(acp.AGENT_METHODS.initialize, async () => {
  await sleep(Number(process.env.SLOW_START_MS) || 0);
  return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };
});
app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: 'slow-session-1' }));
app.onRequest(acp.AGENT_METHODS.session_load, () => ({}));
app.onNotification(acp.AGENT_METHODS.session_cancel, () => {
  log('cancel-received');
  if (process.env.IGNORE_CANCEL !== '1') cancelled = true;
});

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  cancelled = false;
  prompted = true;
  log('prompt-received');
  // A tool's command, as a real agent's shell tool would start it.
  spawn('/bin/sh', ['-c', 'sleep 4; echo late > late.txt'], { stdio: 'ignore' });
  for (let tick = 0; tick < 80 && !cancelled; tick += 1) {
    appendFileSync('ticks.txt', `tick ${tick}\n`);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } }
    });
    await sleep(100);
  }
  log(cancelled ? 'stopped-on-cancel' : 'finished');
  return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
