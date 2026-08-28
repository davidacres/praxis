#!/usr/bin/env node
// Minimal fake `@github/copilot` CLI runtime for e2e-testing
// `CopilotAgentHost`/`CopilotClientWrapper` without a real Copilot install
// or auth. Speaks the SDK's real raw JSON-RPC wire protocol (Content-Length
// framed, LSP-style) over stdio via `vscode-jsonrpc` — the same transport
// library `@github/copilot-sdk` itself depends on — not a hand-rolled
// protocol stub. Implements just the RPC surface `CopilotClient`/
// `CopilotSession` exercise for one session's lifecycle: the `connect`
// handshake, `session.create`, `session.send` (streaming
// `assistant.message_delta` / `assistant.message` / `session.idle` events
// via `session.event` notifications), an optional `permission.requested`
// round trip, `session.abort`, and `session.destroy`.
//
// Prompt markers (mirroring fakeAcpAgent.mjs's convention):
//   - "WITH_PERMISSION": requests a `read` permission before completing.
//   - "REJECT_ME" (with WITH_PERMISSION): asserts the received decision was
//     a rejection — writes "FAKE_COPILOT_ASSERTION_FAILED" to stderr if not.
//     Without it, asserts the decision was NOT a rejection.
//   - "HANG_UNTIL_CANCELLED": stays in-flight until `session.abort` arrives.

import { randomUUID } from 'node:crypto';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

/** requestId -> resolve(decision) for the one pending permission request, if any. */
let pendingPermissionResolve;
/** Resolves when `session.abort` arrives, for the HANG_UNTIL_CANCELLED path. */
let pendingAbortResolve;

function nowIso() {
  return new Date().toISOString();
}

function sendEvent(sessionId, type, data) {
  connection.sendNotification('session.event', {
    sessionId,
    event: { id: randomUUID(), parentId: null, timestamp: nowIso(), type, data }
  });
}

connection.onRequest('connect', () => ({ protocolVersion: 3 }));

connection.onRequest('session.create', params => ({
  sessionId: params.sessionId ?? randomUUID(),
  workspacePath: undefined,
  capabilities: {}
}));

connection.onRequest('session.send', params => {
  const messageId = randomUUID();
  // Ack immediately — the real turn streams asynchronously via `session.event`.
  setImmediate(() => {
    void runTurn(params.sessionId, messageId, params.prompt ?? '');
  });
  return { messageId };
});

connection.onRequest('session.permissions.handlePendingPermissionRequest', params => {
  pendingPermissionResolve?.(params.result);
  pendingPermissionResolve = undefined;
  return {};
});

connection.onRequest('session.abort', () => {
  pendingAbortResolve?.();
  pendingAbortResolve = undefined;
  return {};
});

connection.onRequest('session.destroy', () => ({}));

connection.onRequest('runtime.shutdown', () => ({}));

async function runTurn(sessionId, messageId, prompt) {
  const abortPromise = new Promise(resolve => {
    pendingAbortResolve = resolve;
  });

  if (prompt.includes('HANG_UNTIL_CANCELLED')) {
    await abortPromise;
    sendEvent(sessionId, 'session.idle', {});
    return;
  }

  if (prompt.includes('WITH_PERMISSION')) {
    const requestId = randomUUID();
    const decisionPromise = new Promise(resolve => {
      pendingPermissionResolve = resolve;
    });
    sendEvent(sessionId, 'permission.requested', {
      requestId,
      permissionRequest: {
        kind: 'read',
        intention: 'Read a file to answer the prompt',
        path: '/tmp/fake-copilot-file.txt'
      }
    });

    const decision = await Promise.race([decisionPromise, abortPromise]);
    const expectRejected = prompt.includes('REJECT_ME');
    const wasRejected = decision?.kind === 'reject';
    if (expectRejected !== wasRejected) {
      process.stderr.write(
        `FAKE_COPILOT_ASSERTION_FAILED: expected rejected=${expectRejected} but got decision ${JSON.stringify(decision)}\n`
      );
    }
    if (wasRejected) {
      sendEvent(sessionId, 'assistant.message', { messageId, content: 'Permission denied; stopping.' });
      sendEvent(sessionId, 'session.idle', {});
      return;
    }
  }

  const text = 'Hello from the fake Copilot runtime.';
  sendEvent(sessionId, 'assistant.message_delta', { messageId, deltaContent: text });
  sendEvent(sessionId, 'assistant.message', { messageId, content: text });
  sendEvent(sessionId, 'session.idle', {});
}

connection.listen();
