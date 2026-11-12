#!/usr/bin/env node
// An ACP agent that answers the prompt-clarity checklist: for any prompt it replies with a fixed,
// valid JSON read ("everything is clear" unless the prompt says `VAGUE_TARGET`). It also writes each
// prompt it receives to $CLARITY_AGENT_LOG, so a test can prove the one-shot CLI path was used.

if (process.argv.includes('--version')) {
  console.log('clarity-acp-agent 1.0.0');
  process.exit(0);
}

import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'clarity-acp-agent' });

app.onRequest(acp.AGENT_METHODS.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: 'clarity-session-1' }));
app.onNotification(acp.AGENT_METHODS.session_cancel, () => {});

function reply(prompt) {
  const vague = prompt.includes('VAGUE_TARGET');
  const checks = Object.fromEntries(['target', 'outcome', 'done', 'context-gap', 'ambiguity'].map(id => [id, {
    answer: id === 'context-gap' || id === 'ambiguity' ? 'no' : 'yes', evidence: '', fix: ''
  }]));
  if (vague) checks.target = { answer: 'no', evidence: 'VAGUE_TARGET', fix: 'Name the file or component to change.' };
  const unknown = { text: '', evidence: '', source: 'unknown' };
  return JSON.stringify({ kind: 'instruction', checks, interpretation: { target: unknown, change: unknown, result: unknown } });
}

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = (ctx.params.prompt ?? []).map(block => block.text ?? '').join('\n');
  if (process.env.CLARITY_AGENT_LOG) appendFileSync(process.env.CLARITY_AGENT_LOG, `${JSON.stringify({ promptText })}\n`);
  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply(promptText) } }
  });
  return { stopReason: 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
