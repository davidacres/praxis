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
//   - "WITH_USAGE": sends a `usage_update` — context occupancy and a cost.
//   - "WITH_PLAN": streams a three-task `plan` update, worked one at a time —
//     each one a full snapshot, the way TodoWrite/the ACP spec define it, not
//     a diff against the last. Add "STOP_PLAN_MIDWAY" too to stop after the
//     third task is still `in_progress`, for asserting the mid-run state.
//   - "WITH_COMMANDS": sends an `available_commands_update` with fake slash
//     commands, including `/compact` to exercise provider capability gating.
//   - "ECHO_PROMPT": replies with the whole prompt it received — proves what a
//     launch (e.g. a pinned built-in agent) actually handed the runtime.
//   - "IMAGE_ECHO": reports how many image content blocks the prompt carried
//     and their mime types — proves the host actually forwarded pasted images
//     as ACP image content blocks rather than dropping them.
// `session/new` always advertises two Session Modes ("Ask"/"Code") — harmless
// for every other test (nothing else reads `acpAvailableModes`), and it means
// `session/set_mode` can be exercised without a marker: it applies the switch
// and confirms it with `current_mode_update`, the same as a real agent would.

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
  agentCapabilities: {
    mcpCapabilities: { http: true },
    ...(process.env.FAKE_ACP_REPLAY_ON_RESUME === '1'
      ? { sessionCapabilities: { resume: true } }
      : {})
  }
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

// Fake Session Modes for testing `AcpClientWrapper.getSessionModes`/`setMode`
// and the composer's mode chip without a real CLI. Distinct from Praxis's own
// `SessionMode` (chat/analysis/review) — see `agentTypes.ts`.
let currentMode = 'ask';
const availableModes = [
  { id: 'ask', name: 'Ask', description: 'Answers questions without making changes' },
  { id: 'code', name: 'Code', description: 'Makes changes directly' }
];

app.onRequest(acp.AGENT_METHODS.session_new, ctx => {
  browserMcp = (ctx.params.mcpServers ?? []).find(server => server.name === 'praxis-browser');
  return {
    sessionId: 'fake-session-1',
    configOptions: [modelConfigOption()],
    modes: { currentModeId: currentMode, availableModes }
  };
});

app.onRequest(acp.AGENT_METHODS.session_resume, ctx => {
  if (process.env.FAKE_ACP_REPLAY_ON_RESUME === '1') {
    // Some real ACP hosts replay their latest message immediately after the
    // resume response. It belongs to the previous turn and must not be folded
    // into the next prompt's response buffer.
    setTimeout(() => {
      void ctx.client.notify(acp.CLIENT_METHODS.session_update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from the fake ACP agent. (replayed)' }
        }
      });
    }, 0);
  }
  return {};
});

app.onRequest(acp.AGENT_METHODS.session_set_config_option, ctx => {
  if (ctx.params.configId === 'model' && 'value' in ctx.params) {
    currentModel = ctx.params.value;
  }
  return { configOptions: [modelConfigOption()] };
});

app.onRequest(acp.AGENT_METHODS.session_set_mode, async ctx => {
  currentMode = ctx.params.modeId;
  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId: currentMode }
  });
  return {};
});

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = ctx.params.prompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: promptText.includes('DISTINCT_FOLLOW_UP')
          ? 'Fresh response to the current question.'
          : `Hello from the fake ACP agent. (model=${currentModel})`
      }
    }
  });

  if (promptText.includes('ECHO_PROMPT')) {
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PROMPT_ECHO:${promptText}` } }
    });
    return { stopReason: 'end_turn' };
  }

  if (promptText.includes('IMAGE_ECHO')) {
    const images = ctx.params.prompt.filter(block => block.type === 'image');
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `IMAGES_RECEIVED:${images.length}:${images.map(image => image.mimeType).join(',')}`
        }
      }
    });
    return { stopReason: 'end_turn' };
  }

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
      // Deliberately send an opaque title: Praxis should use the tool kind/name
      // in the user-facing permission copy instead of exposing this ID.
      toolCall: { toolCallId: 'call-1', title: 'permission-request-7e4a9f2c1d8b6e5a', name: 'read_file', kind: 'read' },
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

  if (promptText.includes('WITH_USAGE')) {
    // ACP's `usage_update`: context occupancy (`used`/`size`) plus an optional
    // cumulative cost. Note `used` is what is *in the window now*, not tokens
    // spent to date — the protocol reports no cumulative token count at all.
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 74_000,
        size: 100_000,
        // COST_EUR / COST_BIG let a test build a multi-currency or
        // over-budget set without needing several different fixtures.
        cost: {
          amount: promptText.includes('COST_BIG') ? 9 : 0.42,
          currency: promptText.includes('COST_EUR') ? 'EUR' : 'USD'
        }
      }
    });
  }

  if (promptText.includes('WITH_COMMANDS')) {
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'research_codebase', description: 'Research the codebase before making changes' },
          { name: 'create_plan', description: 'Draft a plan for the requested change', input: { hint: 'goal' } },
          { name: 'compact', description: 'Compact the current context window' }
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
    // Give the renderer time to navigate to the session before changing the
    // first snapshot. The test observes every subsequent update, so starting
    // the cadence immediately would make that assertion scheduler-dependent
    // on slower macOS runners.
    if (promptText.includes('STOP_PLAN_MIDWAY')) {
      await wait(2000);
    }
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'pending', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'pending', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(1500);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'in_progress', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'pending', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(1500);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'completed', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'in_progress', priority: 'high' },
      { content: 'Re-run the suite', status: 'pending', priority: 'medium' }
    ]));
    await wait(1500);
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, plan([
      { content: 'Read the failing test', status: 'completed', priority: 'high' },
      { content: 'Fix the off-by-one', status: 'completed', priority: 'high' },
      { content: 'Re-run the suite', status: 'in_progress', priority: 'medium' }
    ]));
    if (!promptText.includes('STOP_PLAN_MIDWAY')) {
      await wait(1500);
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
