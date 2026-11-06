import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantIpc, DurableConversation } from '@praxis/core';
import { STALE_READ_RETRIES, subscribeConversation } from '../src/assistant/conversationSubscription.ts';

const snapshot = (revision: number) => ({ id: 'c', revision }) as unknown as DurableConversation;
const settle = () => new Promise(resolve => setTimeout(resolve, 1500));

test('a read that never reaches the notified revision is retried a bounded number of times', async () => {
  let reads = 0;
  let notify!: (update: { revision: number }) => void;
  const bridge = {
    getConversation: async () => { reads += 1; return snapshot(1); },
    subscribeConversation: (_id: string, listener: (update: { revision: number }) => void) => { notify = listener; return () => undefined; }
  } as unknown as AssistantIpc;
  const published: number[] = [];
  const dispose = subscribeConversation(bridge, 'c', value => { if (value) published.push(value.revision); }, error => { throw error; });
  await settle();
  const baseline = reads;
  notify({ revision: 5 });
  await settle();
  dispose();
  assert.equal(reads - baseline, STALE_READ_RETRIES + 1);
  assert.ok(published.every(revision => revision === 1));
});

test('a lagging read that catches up publishes the notified revision', async () => {
  let revision = 1;
  let notify!: (update: { revision: number }) => void;
  const bridge = {
    getConversation: async () => snapshot(revision++),
    subscribeConversation: (_id: string, listener: (update: { revision: number }) => void) => { notify = listener; return () => undefined; }
  } as unknown as AssistantIpc;
  const published: number[] = [];
  const dispose = subscribeConversation(bridge, 'c', value => { if (value) published.push(value.revision); }, error => { throw error; });
  await settle();
  notify({ revision: 4 });
  await settle();
  dispose();
  assert.equal(published.at(-1), 4);
});

test('a conversation-update error is surfaced at the loaded revision while snapshot ordering stays monotonic', async () => {
  let revision = 3;
  let reads = 0;
  let notify!: (update: { revision: number; error?: string }) => void;
  const bridge = {
    getConversation: async () => { reads += 1; return snapshot(revision); },
    subscribeConversation: (_id: string, listener: typeof notify) => { notify = listener; return () => undefined; }
  } as unknown as AssistantIpc;
  const published: number[] = [];
  const errors: unknown[] = [];
  const dispose = subscribeConversation(bridge, 'c', value => { if (value) published.push(value.revision); }, error => { errors.push(error); });
  await Promise.resolve();
  assert.deepEqual(published, [3]);
  assert.equal(reads, 1);
  // Completion-write fault at the already observed revision: error reaches the caller without a stale re-read.
  notify({ revision: 3, error: 'ENOSPC: no space left on device. Restart Praxis to recover this team chat.' });
  assert.deepEqual(errors, ['ENOSPC: no space left on device. Restart Praxis to recover this team chat.']);
  assert.equal(reads, 1);
  // A newer revision still refreshes in order, and an older revision never regresses the snapshot.
  revision = 5;
  notify({ revision: 5, error: 'Halted again. Restart Praxis to recover this team chat.' });
  await Promise.resolve();
  revision = 2;
  notify({ revision: 2 });
  await Promise.resolve();
  dispose();
  assert.deepEqual(published, [3, 5]);
  assert.deepEqual(errors, [
    'ENOSPC: no space left on device. Restart Praxis to recover this team chat.',
    'Halted again. Restart Praxis to recover this team chat.'
  ]);
});

/**
 * A bridge holding one server-side conversation. It exposes only reads and the subscription:
 * the client has no mutation method to call, so nothing it does can replay work.
 */
function server(initial: number) {
  let revision = initial;
  let reads = 0;
  let notify!: (update: { revision: number }) => void;
  const bridge = {
    getConversation: async () => { reads += 1; return snapshot(revision); },
    subscribeConversation: (_id: string, listener: (update: { revision: number }) => void) => { notify = listener; return () => undefined; }
  } as unknown as AssistantIpc;
  return { bridge, commit: (next: number) => { revision = next; notify({ revision: next }); }, replay: (old: number) => notify({ revision: old }), reads: () => reads };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('TASK-479 AC2 new window: loads the snapshot, then applies each newer revision', async () => {
  const s = server(3);
  const published: number[] = [];
  const dispose = subscribeConversation(s.bridge, 'c', value => { if (value) published.push(value.revision); }, error => { throw error; });
  await tick();
  s.commit(4); await tick();
  s.commit(5); await tick();
  dispose();
  assert.deepEqual(published, [3, 4, 5]);
});

test('TASK-479 AC2 duplicates: repeated and older revision events cause no read and no publish', async () => {
  const s = server(5);
  const published: number[] = [];
  const dispose = subscribeConversation(s.bridge, 'c', value => { if (value) published.push(value.revision); }, error => { throw error; });
  await tick();
  const baseline = s.reads();
  s.replay(5); s.replay(5); s.replay(2);
  await tick();
  dispose();
  assert.equal(s.reads(), baseline, 'no extra getConversation');
  assert.deepEqual(published, [5], 'no extra publish');
});

test('TASK-479 AC2 gap: a revision gap triggers exactly one fresh snapshot without replaying work', async () => {
  const s = server(3);
  const published: number[] = [];
  const dispose = subscribeConversation(s.bridge, 'c', value => { if (value) published.push(value.revision); }, error => { throw error; });
  await tick();
  const baseline = s.reads();
  s.commit(9);
  await tick();
  dispose();
  assert.equal(s.reads() - baseline, 1, 'one snapshot read covers the gap');
  assert.deepEqual(published, [3, 9]);
});
