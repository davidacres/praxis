import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyValueStore } from '../../host/stateStore';
import { GADGET_CONTRACT_VERSION, type AnyGadgetEnvelope, type ChatBlock, type GadgetAction } from './contracts';
import {
  applyGadgetUpdate,
  collectSupersededIds,
  describeInertState,
  isGadgetActionable,
  resolveGadgetState
} from './lifecycle';
import { authorizeGadgetAction, gatePolicyFromOpenGates, PERMISSIVE_GADGET_POLICY } from './scope';
import {
  GadgetActionLedger,
  admitGadgetAction,
  completeGadgetAction,
  digestActionValue,
  failGadgetAction
} from './actionLedger';
import { GadgetService } from './gadgetService';

const HOST = 'host-1';
const SCOPE = { hostId: HOST, projectId: 'project-1', sessionId: 'session-1', workId: 'FX-1', revision: 2 };
const SCOPE_CONTEXT = { hostId: HOST, sessionId: 'session-1', projectId: 'project-1', workId: 'FX-1', revision: 2 };

function gadget(overrides: Partial<AnyGadgetEnvelope> = {}): AnyGadgetEnvelope {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: 'g-1',
    kind: 'choice',
    scope: SCOPE,
    issuedAt: '2026-09-13T10:00:00.000Z',
    fallbackText: 'What next? local / handoff',
    payload: { question: 'What next?', options: [{ value: 'local', label: 'Keep local' }, { value: 'handoff', label: 'Handoff' }] },
    actions: [{ actionId: 'submit', label: 'Continue', effect: 'informational' }],
    state: 'active',
    ...overrides
  } as AnyGadgetEnvelope;
}

function action(overrides: Partial<GadgetAction> = {}): GadgetAction {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: 'g-1',
    actionId: 'submit',
    scope: SCOPE,
    idempotencyKey: 'key-1',
    correlationId: 'corr-1',
    submittedAt: '2026-09-13T10:01:00.000Z',
    value: { kind: 'choice', selected: 'local' },
    ...overrides
  };
}

/** Synchronous in-memory store matching the host's KeyValueStore contract. */
function fakeStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown) {
      // Round-trip through JSON so the test sees what a real file-backed store
      // would return, not a live reference to the service's own objects.
      data.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────

test('a gadget past its expiry stops accepting input', () => {
  const expiring = gadget({ expiresAt: '2026-09-13T10:05:00.000Z' });
  assert.equal(resolveGadgetState(expiring, { now: '2026-09-13T10:04:59.000Z' }), 'active');
  assert.equal(resolveGadgetState(expiring, { now: '2026-09-13T10:05:00.000Z' }), 'expired');
  assert.equal(isGadgetActionable('expired'), false);
});

test('a recorded answer outranks supersession and expiry', () => {
  // Relabelling a decision the user made as "expired" would read as though
  // their answer had been discarded.
  const stale = gadget({ expiresAt: '2026-09-13T10:05:00.000Z' });
  const context = { now: '2026-09-13T11:00:00.000Z', supersededIds: new Set(['g-1']) };
  assert.equal(resolveGadgetState(stale, { ...context, submissionStatus: 'completed' }), 'completed');
  assert.equal(resolveGadgetState(stale, { ...context, submissionStatus: 'accepted' }), 'submitted');
  // A refused attempt leaves it answerable, so the stale reasons apply again.
  assert.equal(resolveGadgetState(stale, { ...context, submissionStatus: 'rejected' }), 'superseded');
});

test('disconnection only silences an otherwise-live gadget', () => {
  assert.equal(resolveGadgetState(gadget(), { now: '2026-09-13T10:01:00.000Z', connected: false }), 'disconnected');
  assert.equal(
    resolveGadgetState(gadget(), { now: '2026-09-13T10:01:00.000Z', connected: false, submissionStatus: 'completed' }),
    'completed'
  );
});

test('a supersession chain leaves exactly one live gadget', () => {
  const blocks: ChatBlock[] = [
    { type: 'gadget', blockId: 'b1', gadget: gadget({ gadgetId: 'a' }) },
    { type: 'gadget', blockId: 'b2', gadget: gadget({ gadgetId: 'b', supersedes: 'a' }) },
    { type: 'gadget', blockId: 'b3', gadget: gadget({ gadgetId: 'c', supersedes: 'b' }) }
  ];
  const superseded = collectSupersededIds(blocks);
  assert.deepEqual([...superseded].sort(), ['a', 'b']);
  const live = blocks.filter(
    block => block.type === 'gadget' && resolveGadgetState(block.gadget, { now: '2026-09-13T10:01:00.000Z', supersededIds: superseded }) === 'active'
  );
  assert.equal(live.length, 1);
});

test('a streaming update replaces its gadget in place rather than appending', () => {
  const blocks: ChatBlock[] = [
    { type: 'markdown', blockId: 'm1', markdown: 'Working…' },
    { type: 'gadget', blockId: 'b1', gadget: gadget({ gadgetId: 'p', kind: 'progress' }) }
  ];
  const updated = applyGadgetUpdate(blocks, { type: 'gadget', blockId: 'b1', gadget: gadget({ gadgetId: 'p', kind: 'progress' }) });
  assert.equal(updated.length, 2);
  assert.equal(updated[1].type === 'gadget' && updated[1].gadget.gadgetId, 'p');

  const appended = applyGadgetUpdate(blocks, { type: 'gadget', blockId: 'b2', gadget: gadget({ gadgetId: 'q' }) });
  assert.equal(appended.length, 3);
});

test('every inert state explains itself', () => {
  for (const state of ['submitted', 'completed', 'expired', 'superseded', 'revoked', 'disconnected'] as const) {
    assert.ok((describeInertState(state) ?? '').length > 0, `${state} has no explanation`);
  }
  assert.equal(describeInertState('active'), undefined);
});

// ── Scope and policy ─────────────────────────────────────────────────────

test('refuses an action aimed at a different host, session, project or work item', () => {
  const cases = [
    { ...SCOPE_CONTEXT, hostId: 'other-host' },
    { ...SCOPE_CONTEXT, sessionId: 'session-2' },
    { ...SCOPE_CONTEXT, projectId: 'project-2' },
    { ...SCOPE_CONTEXT, workId: 'FX-2' }
  ];
  for (const context of cases) {
    const error = authorizeGadgetAction(gadget(), action(), context, PERMISSIVE_GADGET_POLICY);
    assert.equal(error?.code, 'scope-mismatch', JSON.stringify(context));
  }
  assert.equal(authorizeGadgetAction(gadget(), action(), SCOPE_CONTEXT, PERMISSIVE_GADGET_POLICY), undefined);
});

test('refuses a client that rewrote the scope it submits against', () => {
  const retargeted = action({ scope: { ...SCOPE, projectId: 'project-2' } });
  const error = authorizeGadgetAction(gadget(), retargeted, SCOPE_CONTEXT, PERMISSIVE_GADGET_POLICY);
  assert.equal(error?.code, 'scope-mismatch');
  assert.match(error?.message ?? '', /different scope/);
});

test('refuses a gadget issued against an older scope revision', () => {
  const error = authorizeGadgetAction(gadget(), action(), { ...SCOPE_CONTEXT, revision: 3 }, PERMISSIVE_GADGET_POLICY);
  assert.equal(error?.code, 'scope-mismatch');
  assert.match(error?.message ?? '', /moved on/);
});

test('a mutating action needs its declared gate to be open', () => {
  const mutating = gadget({
    actions: [{ actionId: 'apply', label: 'Apply', effect: 'mutating', gate: 'changes.apply' }]
  });
  const applyAction = action({ actionId: 'apply', value: { kind: 'confirmation', confirmed: true } });

  const closed = authorizeGadgetAction(mutating, applyAction, SCOPE_CONTEXT, gatePolicyFromOpenGates([]));
  assert.equal(closed?.code, 'gate-required');

  const open = authorizeGadgetAction(mutating, applyAction, SCOPE_CONTEXT, gatePolicyFromOpenGates(['changes.apply']));
  assert.equal(open, undefined);
});

test('a mutating action that reached authorization with no gate is refused outright', () => {
  // Validation refuses this shape, so arriving here means the envelope bypassed
  // it — treat a missing gate as a failure, never as "no gate needed".
  const ungated = gadget({ actions: [{ actionId: 'apply', label: 'Apply', effect: 'mutating' }] });
  const error = authorizeGadgetAction(ungated, action({ actionId: 'apply' }), SCOPE_CONTEXT, PERMISSIVE_GADGET_POLICY);
  assert.equal(error?.code, 'gate-required');
});

// ── Ledger ───────────────────────────────────────────────────────────────

test('the same key with the same answer replays; with a different answer it conflicts', () => {
  const ledger = new GadgetActionLedger();
  const first = admitGadgetAction(ledger, gadget(), action(), '2026-09-13T10:01:00.000Z');
  assert.equal(first.ok && first.replay, false);

  const retry = admitGadgetAction(ledger, gadget(), action(), '2026-09-13T10:01:05.000Z');
  assert.equal(retry.ok && retry.replay, true);

  const conflict = admitGadgetAction(
    ledger,
    gadget(),
    action({ value: { kind: 'choice', selected: 'handoff' } }),
    '2026-09-13T10:01:06.000Z'
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'duplicate-action');
});

test('a value digest is stable across key order', () => {
  const a = digestActionValue({ kind: 'form', fields: { b: 2, a: 1 } });
  const b = digestActionValue({ kind: 'form', fields: { a: 1, b: 2 } });
  assert.equal(a, b);
  assert.notEqual(a, digestActionValue({ kind: 'form', fields: { a: 1, b: 3 } }));
});

test('the record carries what the user was asked, not just what they answered', () => {
  const ledger = new GadgetActionLedger();
  const admission = admitGadgetAction(
    ledger,
    gadget({ actions: [{ actionId: 'submit', label: 'Continue', effect: 'approval', gate: 'release.approve' }] }),
    action(),
    '2026-09-13T10:01:00.000Z'
  );
  assert.equal(admission.ok, true);
  if (!admission.ok) throw new Error('unreachable');
  assert.equal(admission.record.evidence.prompt, 'What next? local / handoff');
  assert.equal(admission.record.evidence.actionLabel, 'Continue');
  assert.equal(admission.record.evidence.effect, 'approval');
  assert.equal(admission.record.evidence.gate, 'release.approve');
  assert.deepEqual(admission.record.evidence.value, { kind: 'choice', selected: 'local' });
});

test('a failed attempt leaves the gadget answerable', () => {
  const ledger = new GadgetActionLedger();
  admitGadgetAction(ledger, gadget(), action(), '2026-09-13T10:01:00.000Z');
  failGadgetAction(ledger, 'key-1', { code: 'value-invalid', message: 'nope' }, '2026-09-13T10:01:01.000Z');
  assert.equal(ledger.effectiveStatus('g-1'), undefined);

  admitGadgetAction(ledger, gadget(), action({ idempotencyKey: 'key-2' }), '2026-09-13T10:02:00.000Z');
  completeGadgetAction(ledger, 'key-2', { applied: true }, '2026-09-13T10:02:01.000Z');
  assert.equal(ledger.effectiveStatus('g-1'), 'completed');
});

test('events replay after a cursor for a client that reconnected', () => {
  const ledger = new GadgetActionLedger();
  admitGadgetAction(ledger, gadget(), action(), '2026-09-13T10:01:00.000Z');
  completeGadgetAction(ledger, 'key-1', undefined, '2026-09-13T10:01:01.000Z');
  admitGadgetAction(ledger, gadget(), action({ idempotencyKey: 'key-2', correlationId: 'corr-2' }), '2026-09-13T10:02:00.000Z');

  assert.equal(ledger.lastSequence, 3);
  assert.deepEqual(ledger.replay(1).map(event => event.status), ['completed', 'accepted']);
  assert.equal(ledger.replay(3).length, 0);
});

test('the ledger survives a restart', () => {
  const store = fakeStore();
  const ledger = new GadgetActionLedger(store);
  admitGadgetAction(ledger, gadget(), action(), '2026-09-13T10:01:00.000Z');
  completeGadgetAction(ledger, 'key-1', { applied: true }, '2026-09-13T10:01:01.000Z');

  const reloaded = new GadgetActionLedger(store);
  assert.equal(reloaded.get('key-1')?.status, 'completed');
  assert.equal(reloaded.effectiveStatus('g-1'), 'completed');
  assert.equal(reloaded.lastSequence, 2);
});

// ── Service pipeline ─────────────────────────────────────────────────────

function service(options: { now?: () => string; policy?: Parameters<typeof authorizeGadgetAction>[3] } = {}) {
  return new GadgetService({
    hostId: HOST,
    store: fakeStore(),
    now: options.now ?? (() => '2026-09-13T10:01:00.000Z'),
    policy: options.policy
  });
}

test('publishing coerces a bad gadget into a visible fallback', () => {
  const blocks = service().publish('session-1', [
    { type: 'markdown', markdown: 'Here is the plan.' },
    { type: 'gadget', gadget: { version: 1, kind: 'teleporter' } }
  ]);
  assert.equal(blocks[0].type, 'markdown');
  assert.equal(blocks[1].type, 'fallback');
  assert.equal(blocks[1].type === 'fallback' && blocks[1].reason?.code, 'unsupported-kind');
});

test('republishing the same gadget ID updates in place', () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget({ gadgetId: 'p' }) }]);
  const after = gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget({ gadgetId: 'p', fallbackText: 'updated' }) }]);
  assert.equal(after.length, 1);
  assert.equal(after[0].type === 'gadget' && after[0].gadget.fallbackText, 'updated');
});

test('a submission runs the executor once and completes', async () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  let calls = 0;
  const result = await gadgets.submit(action(), SCOPE_CONTEXT, async () => {
    calls += 1;
    return { outcome: { applied: true }, message: 'Kept local.' };
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.message, 'Kept local.');
  assert.deepEqual(result.outcome, { applied: true });
  assert.equal(calls, 1);
});

test('a retry of the same submission replays without running the executor again', async () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { outcome: { applied: true } };
  };
  await gadgets.submit(action(), SCOPE_CONTEXT, executor);
  const replayed = await gadgets.submit(action(), SCOPE_CONTEXT, executor);
  assert.equal(calls, 1);
  assert.equal(replayed.replay, true);
  assert.equal(replayed.status, 'completed');
});

test('answering twice with a new key is refused as already answered', async () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  await gadgets.submit(action(), SCOPE_CONTEXT, async () => ({}));
  const second = await gadgets.submit(
    action({ idempotencyKey: 'key-2', correlationId: 'corr-2', value: { kind: 'choice', selected: 'handoff' } }),
    SCOPE_CONTEXT,
    async () => ({})
  );
  assert.equal(second.status, 'rejected');
  assert.equal(second.error?.code, 'already-submitted');
});

test('an expired gadget refuses the submission', async () => {
  const gadgets = new GadgetService({
    hostId: HOST,
    store: fakeStore(),
    now: () => '2026-09-13T12:00:00.000Z'
  });
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget({ expiresAt: '2026-09-13T10:05:00.000Z' }) }]);
  const result = await gadgets.submit(action(), SCOPE_CONTEXT, async () => ({}));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error?.code, 'gadget-expired');
});

test('a closed gate refuses without consuming the idempotency key', async () => {
  // The key must stay free: a user denied while a gate was shut has to be able
  // to retry the same decision once it opens.
  const store = fakeStore();
  let openGates: string[] = [];
  const gadgets = new GadgetService({
    hostId: HOST,
    store,
    now: () => '2026-09-13T10:01:00.000Z',
    policy: { isGateOpen: gate => openGates.includes(gate) }
  });
  const mutating = gadget({
    kind: 'confirmation',
    payload: { question: 'Apply the change?' },
    actions: [{ actionId: 'apply', label: 'Apply', effect: 'mutating', gate: 'changes.apply' }]
  });
  gadgets.publish('session-1', [{ type: 'gadget', gadget: mutating }]);
  const applyAction = action({ actionId: 'apply', value: { kind: 'confirmation', confirmed: true } });

  const denied = await gadgets.submit(applyAction, SCOPE_CONTEXT, async () => ({}));
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error?.code, 'gate-required');
  assert.equal(gadgets.actionLedger.get('key-1'), undefined);

  openGates = ['changes.apply'];
  const allowed = await gadgets.submit(applyAction, SCOPE_CONTEXT, async () => ({ message: 'Applied.' }));
  assert.equal(allowed.status, 'completed');
});

test('an executor failure is recorded as failed, not as a rejection', async () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  const result = await gadgets.submit(action(), SCOPE_CONTEXT, async () => {
    throw new Error('the host could not apply it');
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /could not apply/);
  // The attempt is in the audit trail even though it did not succeed.
  assert.equal(gadgets.actionLedger.get('key-1')?.status, 'failed');
});

test('a submission against an unknown gadget is refused', async () => {
  const gadgets = service();
  const result = await gadgets.submit(action(), SCOPE_CONTEXT, async () => ({}));
  assert.equal(result.error?.code, 'gadget-not-found');
});

test('a revoked gadget stops accepting answers', async () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  gadgets.revoke('session-1', 'g-1');
  const result = await gadgets.submit(action(), SCOPE_CONTEXT, async () => ({}));
  assert.equal(result.error?.code, 'gadget-not-found');
  const [block] = gadgets.getBlocks('session-1');
  assert.equal(block.type === 'gadget' && block.gadget.state, 'revoked');
});

test('reading blocks while disconnected marks live gadgets non-actionable', () => {
  const gadgets = service();
  gadgets.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  const [block] = gadgets.getBlocks('session-1', { connected: false });
  assert.equal(block.type === 'gadget' && block.gadget.state, 'disconnected');
});

test('published blocks and ledger survive a restart together', async () => {
  const store = fakeStore();
  const first = new GadgetService({ hostId: HOST, store, now: () => '2026-09-13T10:01:00.000Z' });
  first.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  await first.submit(action(), SCOPE_CONTEXT, async () => ({ message: 'done' }));

  const reopened = new GadgetService({ hostId: HOST, store, now: () => '2026-09-13T10:05:00.000Z' });
  const [block] = reopened.getBlocks('session-1');
  assert.equal(block.type === 'gadget' && block.gadget.state, 'completed');
  const replayed = await reopened.submit(action(), SCOPE_CONTEXT, async () => ({}));
  assert.equal(replayed.replay, true);
});

test('a submission in one session does not disable a reused gadget ID in another session', async () => {
  const store = fakeStore();
  const first = new GadgetService({ hostId: HOST, store, now: () => '2026-09-13T10:01:00.000Z' });
  first.publish('session-1', [{ type: 'gadget', gadget: gadget() }]);
  await first.submit(action(), SCOPE_CONTEXT, async () => ({ message: 'done' }));

  const secondScope = { ...SCOPE, sessionId: 'session-2' };
  const second = new GadgetService({ hostId: HOST, store, now: () => '2026-09-13T10:02:00.000Z' });
  second.publish('session-2', [{ type: 'gadget', gadget: gadget({ scope: secondScope }) }]);

  const [block] = second.getBlocks('session-2');
  assert.equal(block.type === 'gadget' && block.gadget.state, 'active');
});

test('re-publishing the same message replaces its blocks, including a refused gadget\'s fallback', () => {
  const service = new GadgetService({ hostId: 'host-1', now: () => '2026-09-24T10:00:00.000Z' });
  const scope = { hostId: 'host-1', sessionId: 's-1' };
  const inputs = [
    { type: 'gadget' as const, blockId: 'msg-2-1', gadget: { version: GADGET_CONTRACT_VERSION, gadgetId: 'msg-2-1', kind: 'hologram', scope, issuedAt: '2026-09-24T10:00:00.000Z' } },
    { type: 'gadget' as const, blockId: 'msg-2-2', gadget: { version: GADGET_CONTRACT_VERSION, gadgetId: 'msg-2-2', kind: 'choice', scope, issuedAt: '2026-09-24T10:00:00.000Z', fallbackText: 'Pick', payload: { question: 'Which?', options: [{ value: 'a', label: 'A' }] }, actions: [] } },
  ];
  service.publish('s-1', inputs);
  service.publish('s-1', inputs);
  const blocks = service.getBlocks('s-1');
  assert.deepEqual(blocks.map(block => [block.blockId, block.type]), [['msg-2-1', 'fallback'], ['msg-2-2', 'gadget']]);
});
