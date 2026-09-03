#!/usr/bin/env node
// A minimal ACP agent fixture that performs a *real* code edit, for
// end-to-end testing the "hand a ticket to AI" flow without a Claude Code /
// Codex CLI install or a model call.
//
// On `session/prompt` it:
//   1. reads the target file via the real `fs/read_text_file` client request
//      (served by AcpClientWrapper against the session's sandboxed cwd),
//   2. applies a small deterministic fix — turns the first `a - b` in a
//      `return` into `a + b`,
//   3. writes it back via `fs/write_text_file`,
//   4. announces the change as an ACP `edit` tool call with a diff block,
//   5. streams a short summary and ends the turn.
//
// The file it touches is named in the prompt (the ticket's goal); it falls
// back to `sum.js`. Everything here is real ACP wire traffic over stdio via
// the same `@agentclientprotocol/sdk` a real agent uses.

import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Praxis spawns this agent with `cwd` set to the session's working folder,
// which is an arbitrary project directory with no `node_modules` above it.
// Resolve the SDK from *this file's* location instead of the cwd.
const require = createRequire(import.meta.url);
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'coding-acp-agent' });

app.onRequest(acp.AGENT_METHODS.initialize, () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: {}
}));

app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: 'coding-session-1' }));

const say = (ctx, text) =>
  ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  });

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = ctx.params.prompt.map(b => (b.type === 'text' ? b.text : '')).join('');
  const named = promptText.match(/([A-Za-z0-9_.-]+\.(?:js|ts|mjs|py))/);
  const targetPath = named ? named[1] : 'sum.js';

  await say(ctx, `Looking at \`${targetPath}\`.`);

  let before;
  try {
    const read = await ctx.client.request(acp.CLIENT_METHODS.fs_read_text_file, {
      sessionId: ctx.params.sessionId,
      path: targetPath
    });
    before = read.content;
  } catch (error) {
    await say(ctx, `Could not read ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { stopReason: 'end_turn' };
  }

  // The bug: subtraction where the ticket wants a sum.
  const after = before.replace(/return\s+([A-Za-z_$][\w$]*)\s*-\s*([A-Za-z_$][\w$]*)/, 'return $1 + $2');
  if (after === before) {
    await say(ctx, 'Nothing to change — the function already looks correct.');
    return { stopReason: 'end_turn' };
  }

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: `Edit ${targetPath}`, kind: 'edit', status: 'pending' }
  });

  try {
    await ctx.client.request(acp.CLIENT_METHODS.fs_write_text_file, {
      sessionId: ctx.params.sessionId,
      path: targetPath,
      content: after
    });
  } catch (error) {
    await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'failed' }
    });
    await say(ctx, `Could not write \`${targetPath}\`: ${error instanceof Error ? error.message : String(error)}`);
    return { stopReason: 'end_turn' };
  }

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      content: [{ type: 'diff', path: targetPath, oldText: before, newText: after }]
    }
  });

  await say(ctx, `Fixed \`${targetPath}\`: the return now adds the two operands instead of subtracting. Ready for review.`);
  return { stopReason: 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
