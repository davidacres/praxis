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
