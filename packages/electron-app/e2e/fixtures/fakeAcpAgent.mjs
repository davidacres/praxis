#!/usr/bin/env node
// Minimal ACP agent fixture for e2e-testing `AcpAgentHost`/`AcpClientWrapper`
// without a real Claude Code / Codex CLI install. Speaks real ACP JSON-RPC
// over stdio via the same `@agentclientprotocol/sdk` real agents use — not a
// hand-rolled protocol stub — so it exercises the actual wire framing.
//
// On `session/prompt` it streams one text chunk, then completes the turn —
// unless the prompt contains a marker:
//   - "HANG_UNTIL_CANCELLED": stays in-flight until `session/cancel` arrives.
//   - "WITH_PERMISSION": also announces a tool call and round-trips a real
//     `session/request_permission` request first (electron-app has no
//     permission-approval UI/IPC wired up yet — see AcpAgentHost's own
//     `respondToPermission`, which is equally unreachable for the existing
//     local-tools path — so this marker is exercised via `AcpClientWrapper`
//     directly in manual verification, not through the full app's IPC).

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

const app = acp.agent({ name: 'fake-acp-agent' });

let resolveCancel;
const cancelled = new Promise(resolve => {
  resolveCancel = resolve;
});
app.onNotification(acp.AGENT_METHODS.session_cancel, () => {
  resolveCancel();
});

app.onRequest(acp.AGENT_METHODS.initialize, () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: {}
}));

app.onRequest(acp.AGENT_METHODS.session_new, () => ({
  sessionId: 'fake-session-1'
}));

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = ctx.params.prompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello from the fake ACP agent.' }
    }
  });

  if (promptText.includes('HANG_UNTIL_CANCELLED')) {
    // Stay in-flight until the client sends `session/cancel` (tested via abort).
    await cancelled;
    return { stopReason: 'cancelled' };
  }

  if (promptText.includes('WITH_PERMISSION')) {
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read a file',
        kind: 'read',
        status: 'pending'
      }
    });

    const response = await ctx.client.request(acp.CLIENT_METHODS.session_request_permission, {
      sessionId: ctx.params.sessionId,
      toolCall: { toolCallId: 'call-1', title: 'Read a file' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    });

    const outcome = response.outcome;
    const wasAllowed = outcome.outcome === 'selected' && outcome.optionId.startsWith('allow');

    if (promptText.includes('REJECT_ME') && wasAllowed) {
      process.stderr.write('FAKE_ACP_ASSERTION_FAILED: expected the permission to be denied\n');
    }
    if (!promptText.includes('REJECT_ME') && !wasAllowed) {
      process.stderr.write('FAKE_ACP_ASSERTION_FAILED: expected the permission to be allowed\n');
    }

    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: wasAllowed ? 'completed' : 'failed'
      }
    });
  }

  return { stopReason: 'end_turn' };
});

const app_ = app.connect(stream);
await app_.closed;
