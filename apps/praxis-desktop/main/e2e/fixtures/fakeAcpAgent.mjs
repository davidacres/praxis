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
//   - "WITH_PLAN": streams a three-task `plan` update, worked one at a time —
//     each one a full snapshot, the way TodoWrite/the ACP spec define it, not
//     a diff against the last. Add "STOP_PLAN_MIDWAY" too to stop after the
//     third task is still `in_progress`, for asserting the mid-run state.

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
  // Advertise the http MCP transport so the client hands us `mcpServers`
  // (the in-app browser). Real Claude Code advertises this too.
  agentCapabilities: { mcpCapabilities: { http: true } }
}));

// Captured from `session/new` — the in-app browser MCP endpoint the client passes.
let browserMcp;

// Fake model selector for testing `AcpClientWrapper.getModelOption`/
// `setConfigOption` and the composer's model picker (aiCliAgentHost.spec.ts's
// model-selection coverage) without a real Claude Code/Codex CLI.
let currentModel = 'fake-default';
const modelConfigOption = () => ({
  id: 'model',
  name: 'Model',
  description: 'Fake model selector',
  category: 'model',
  type: 'select',
  currentValue: currentModel,
  options: [
    { value: 'fake-default', name: 'Fake Default' },
    { value: 'fake-fast', name: 'Fake Fast' }
  ]
});

app.onRequest(acp.AGENT_METHODS.session_new, ctx => {
  browserMcp = (ctx.params.mcpServers ?? []).find(server => server.name === 'praxis-browser');
  return { sessionId: 'fake-session-1', configOptions: [modelConfigOption()] };
});

app.onRequest(acp.AGENT_METHODS.session_set_config_option, ctx => {
  if (ctx.params.configId === 'model' && 'value' in ctx.params) {
    currentModel = ctx.params.value;
  }
  return { configOptions: [modelConfigOption()] };
});

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = ctx.params.prompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Hello from the fake ACP agent. (model=${currentModel})` }
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

  if (promptText.includes('USE_BROWSER')) {
    // Connect to the in-app browser MCP server the client handed us in
    // `session/new`, drive one navigation, and stream the result back.
    if (!browserMcp) {
      await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BROWSER RESULT:\nNO_MCP_SERVER' } }
      });
      return { stopReason: 'end_turn' };
    }
    let text;
    try {
      const headers = Object.fromEntries((browserMcp.headers ?? []).map(h => [h.name, h.value]));
      const mcp = new McpClient({ name: 'fake-acp-agent', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(browserMcp.url), { requestInit: { headers } }));
      const result = await mcp.callTool({
        name: 'browser_navigate',
        arguments: { url: process.env.FAKE_ACP_BROWSER_URL ?? 'https://example.com/' }
      });
      text = (result.content ?? []).map(part => (part.type === 'text' ? part.text : '')).join('\n');
      await mcp.close();
    } catch (error) {
      text = `MCP_CALL_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`FAKE_ACP: ${text}\n`);
    }
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `BROWSER RESULT:\n${text}` } }
    });
    return { stopReason: 'end_turn' };
  }

  if (promptText.includes('WITH_DIFF')) {
    // Announce an edit tool call, then complete it with a `diff` content block —
    // the shape `acpAgentHost.readAcpToolContent` turns into a rendered diff.
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'diff-1',
        title: 'Edit notes.md',
        kind: 'edit',
        status: 'pending'
      }
    });
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'diff-1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'notes.md',
            oldText: 'first line\n',
            newText: 'first line\nsecond line added by the agent\n'
          }
        ]
      }
    });
  }

  if (promptText.includes('WITH_PLAN')) {
    // Claude Code's TodoWrite and Codex's plan tool both stream a `plan`
    // update per change — each one a full snapshot, not a diff (the ACP spec:
    // "the client replaces the entire plan with each update"). Three tasks,
    // worked one at a time, so the host has to actually replace on every event
    // rather than merge — a case that would still look right if it forgot one
    // task's status update and only mixed the two together.
    const plan = entries => ({
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'plan', entries }
    });
    // Real agents take real seconds between finishing one task and the next —
    // paced here so a client watching the session actually gets a chance to
    // observe each intermediate snapshot, not just the last one to land before
    // the turn ends.
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'pending', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'pending', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(150);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'in_progress', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'pending', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(150);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'completed', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'in_progress', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(150);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'completed', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'completed', priority: 'high' },
      { content: 'Re-run the suite', status: 'in_progress', priority: 'medium' }
    ]));
    if (!promptText.includes('STOP_PLAN_MIDWAY')) {
      await wait(150);
      await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
        { content: 'Read the failing test', status: 'completed', priority: 'high' },
        { content: 'Fix the off-by-one', status: 'completed', priority: 'high' },
        { content: 'Re-run the suite', status: 'completed', priority: 'medium' }
      ]));
    }
  }

  return { stopReason: 'end_turn' };
});

const app_ = app.connect(stream);
await app_.closed;
