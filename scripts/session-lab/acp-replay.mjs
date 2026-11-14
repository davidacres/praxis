#!/usr/bin/env node
// Offline fixture agent: never spawns a process, performs a tool, or opens a network connection.
import readline from 'node:readline';
import { readJson, validateBundle } from './format.mjs';
import { replaySegments, matchesRequest } from './replay.mjs';
if (process.argv.includes('--version')) { console.log('Praxis Session Lab replay v1'); process.exit(0); }
const bundle = validateBundle(readJson(process.env.PRAXIS_SESSION_LAB_BUNDLE));
let candidates = bundle.processes.filter(p => p.frames.some(f => f.message.method === 'session/prompt')).map(p => ({ segments: replaySegments(p.frames), index: 0 }));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  let actual;
  try {
    actual = JSON.parse(line);
    // Host notifications may arrive after the recorded turn finished.
    if (actual.method === 'session/cancel' && actual.id === undefined) continue;
    candidates = candidates.filter(candidate => candidate.segments[candidate.index] && matchesRequest(candidate.segments[candidate.index].request, actual, bundle.scenario.prompts));
    if (!candidates.length) throw new Error(`Unexpected replay request: ${actual.method || 'response'}`);
    const segment = candidates[0].segments[candidates[0].index];
    let previousAt = segment.at;
    for (const [index, reply] of segment.replies.entries()) {
      // Let the host consume notifications before the prompt response settles the turn.
      // A zero-delay burst can otherwise overtake its asynchronous update queue.
      const speed = Number(process.env.PRAXIS_SESSION_LAB_SPEED || 4);
      const delay = (segment.replyTimes[index] - previousAt) / speed;
      await new Promise(resolve => setTimeout(resolve, Math.max(!reply.method ? 25 : 1, delay)));
      previousAt = segment.replyTimes[index];
      const result = structuredClone(reply);
      if (!result.method && result.id === segment.request.id) result.id = actual.id;
      // Every recorded runtime session maps to one isolated replay session.
      const replace = value => {
        if (Array.isArray(value)) return value.map(replace);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'sessionId' ? 'session-lab-replay' : replace(child)]));
      };
      send(replace(result));
    }
    for (const candidate of candidates) candidate.index++;
  } catch (error) {
    console.error(error.message);
    if (actual?.id !== undefined) send({ jsonrpc: '2.0', id: actual.id, error: { code: -32602, message: error.message } });
    process.exitCode = 1;
    break;
  }
}
