#!/usr/bin/env node
// An ACP agent that behaves like Copilot CLI when a tool is refused: it ends the whole turn
// ("Info: Operation cancelled by user") with nothing produced.
//
// First turn: asks to run `git status` (only reads, so it should be allowed), then `npm test`
// (could write, so a read-only stage refuses it) and stops on the refusal.
// A turn whose prompt says the command was refused produces the plan.
//
// Every permission answer is appended to $REFUSAL_AGENT_LOG as `<command> <outcome>`.

import * as fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'refusal-ends-turn-agent' });
const log = line => { if (process.env.REFUSAL_AGENT_LOG) fs.appendFileSync(process.env.REFUSAL_AGENT_LOG, `${line}\n`); };

app.onRequest(acp.AGENT_METHODS.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: `refusal-${Date.now()}` }));
app.onNotification(acp.AGENT_METHODS.session_cancel, () => {});

const say = (ctx, text) => ctx.client.notify(acp.CLIENT_METHODS.session_update, {
  sessionId: ctx.params.sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
});

async function run(ctx, id, command) {
  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId: id, title: `Run ${command.split(' ')[0]}`, kind: 'execute', status: 'pending', rawInput: { command } }
  });
  const response = await ctx.client.request(acp.CLIENT_METHODS.session_request_permission, {
    sessionId: ctx.params.sessionId,
    toolCall: { toolCallId: id, title: `Run ${command.split(' ')[0]}`, kind: 'execute', rawInput: { command } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ]
  });
  const allowed = response.outcome.outcome === 'selected' && response.outcome.optionId === 'allow';
  log(`${command} ${allowed ? 'allowed' : 'refused'}`);
  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: allowed ? 'completed' : 'failed' }
  });
  return allowed;
}

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const prompt = ctx.params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n');
  if (prompt.includes('was refused because this stage is read-only')) {
    log('continued');
    await say(ctx, '# Plan\n\n1. Change the pager.\n\nPlan status: ready\n');
    return { stopReason: 'end_turn' };
  }
  await say(ctx, 'Looking at the repository first.');
  await run(ctx, 'call-1', 'git status --short');
  if (!(await run(ctx, 'call-2', 'npm test'))) {
    // What Copilot does on any refused tool.
    await say(ctx, 'Info: Operation cancelled by user');
    return { stopReason: 'end_turn' };
  }
  await say(ctx, '# Plan\n\nPlan status: ready\n');
  return { stopReason: 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
