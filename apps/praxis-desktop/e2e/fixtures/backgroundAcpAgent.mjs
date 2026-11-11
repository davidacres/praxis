#!/usr/bin/env node
// Real JSON-RPC framing with the negotiated AIR asyncTasks extension. It deliberately
// finishes the foreground turn before its task, so prompt-only consumers lose the result.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const sessionId = randomUUID();
let asyncEnabled = false;
let nativeEnabled = false;
let timer;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  switch (request.method) {
    case 'initialize':
      asyncEnabled = request.params.clientCapabilities?._meta?.jetbrains?.air?.capabilities?.includes('asyncTasks');
      nativeEnabled = request.params.clientCapabilities?._meta?.jetbrains?.air?.capabilities?.includes('nativeSubagentSessions');
      reply({ protocolVersion: request.params.protocolVersion, agentCapabilities: { sessionCapabilities: { close: true } }, authMethods: [], agentInfo: { name: 'background-fixture', version: '1' } });
      break;
    case 'session/new':
      // Historical replay before any prompt must never produce a live notification.
      update({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'historical', state: 'completed' });
      reply({ sessionId, configOptions: [] });
      break;
    case 'session/prompt': {
      const prompt = request.params.prompt.map(part => part.text || '').join('\n');
      if (!asyncEnabled) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Host did not negotiate asyncTasks' } });
        break;
      }
      if (prompt.includes('FOLLOW_UP_ONLY')) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Follow-up received while background work continues.' } });
        reply({ stopReason: 'end_turn' });
        break;
      }
      const native = prompt.includes('NATIVE_SUBAGENT');
      const airChild = prompt.includes('AIR_SUBAGENT');
      if (airChild) {
        if (!nativeEnabled) throw new Error('Host did not negotiate nativeSubagentSessions');
        update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-session', name: 'Background reviewer', task: 'Review the changes', capabilities: {} });
      } else if (native) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'spawn-1', title: 'Start subagent background-reviewer', status: 'in_progress' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1', status: 'completed' });
      } else {
        update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-1', name: 'Background checks', description: 'Run background checks', taskType: 'shell', toolCallId: 'launch-1' });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I started the background checks. This reply finishes before they do.' } });
      reply({ stopReason: 'end_turn' });
      if (prompt.includes('DROP_CONNECTION')) {
        timer = setTimeout(() => process.exit(1), 2800);
      } else {
        timer = setTimeout(() => {
          const failed = prompt.includes('BACKGROUND_FAIL');
          if (airChild) {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'child-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child review complete: no findings.' } } } });
            update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-session', state: 'completed' });
          } else if (native) {
            update({ sessionUpdate: 'tool_call', toolCallId: 'finish-1', title: 'Complete subagent background-reviewer', status: 'in_progress' });
            update({ sessionUpdate: 'tool_call_update', toolCallId: 'finish-1', status: failed ? 'failed' : 'completed' });
          } else {
            const terminal = { sessionUpdate: 'async_task_state_update', asyncTaskId: 'bg-1', state: failed ? 'failed' : 'completed', summary: failed ? 'Background checks failed: fixture failure.' : 'All background checks passed.' };
            update({ sessionUpdate: 'async_task_progress', asyncTaskId: 'bg-1', summary: 'Finishing background checks.' });
            update(terminal);
            update(terminal); // Duplicate terminal updates are harmless.
            update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-1', description: 'Run background checks' }); // A late replay cannot resurrect it.
          }
        }, Number(process.env.BACKGROUND_DELAY_MS || 6000));
      }
      break;
    }
    case 'session/close':
      clearTimeout(timer);
      reply({});
      break;
    case 'session/cancel':
      clearTimeout(timer);
      break;
    default:
      if (request.id !== undefined) reply({});
  }
});
process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
