#!/usr/bin/env node
// An ACP agent that records whether the run's dependencies are installed when its stage starts:
// it appends `installed` or `missing` (for node_modules/praxis-fixture-dep under the session's
// working directory) to $DEPENDENCY_PROBE_LOG, then returns a plan.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'dependency-probe-agent' });
const cwds = new Map();

app.onRequest(acp.AGENT_METHODS.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
app.onRequest(acp.AGENT_METHODS.session_new, ctx => {
  const sessionId = `probe-${Date.now()}`;
  cwds.set(sessionId, ctx.params.cwd);
  return { sessionId };
});
app.onNotification(acp.AGENT_METHODS.session_cancel, () => {});
app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const cwd = cwds.get(ctx.params.sessionId) ?? process.cwd();
  const installed = fs.existsSync(path.join(cwd, 'node_modules', 'praxis-fixture-dep'));
  if (process.env.DEPENDENCY_PROBE_LOG) fs.appendFileSync(process.env.DEPENDENCY_PROBE_LOG, `${installed ? 'installed' : 'missing'}\n`);
  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Plan\n\n1. Validate.\n\nPlan status: ready\n' } }
  });
  return { stopReason: 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
