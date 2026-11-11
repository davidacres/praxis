#!/usr/bin/env node
// An ACP agent that accepts a turn, never answers it, and ignores
// `session/cancel` — while staying alive with its streams open.
//
// This is the case the host cannot detect from the transport: nothing closes,
// nothing errors, the turn simply never settles. It is what
// `AcpAgentHost.stopTask()`'s waits used to block on forever.

// The provider preflight runs `--version`. Answer it like a real CLI: started as an
// agent, the probe outlived each test's app and leaked one process per run.
if (process.argv.includes('--version')) {
  console.log('deaf-acp-agent 1.0.0');
  process.exit(0);
}

import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'deaf-acp-agent' });

app.onRequest(acp.AGENT_METHODS.initialize, () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: {}
}));
app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: 'deaf-session-1' }));

// Deliberately no session_cancel handler: cancel notifications are dropped.
app.onRequest(acp.AGENT_METHODS.session_prompt, () => new Promise(() => {}));

// Keep the process alive indefinitely so nothing closes the transport.
setInterval(() => {}, 1 << 30);

const connection = app.connect(stream);
await connection.closed;
