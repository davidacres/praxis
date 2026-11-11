import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPraxisBridge } from '../src/host/praxisBridge.generated.ts';
import { createTauriTransport, DesktopInvocationError, nullUndefined } from '../src/host/tauriTransport';
import type { HostEvent, TauriInvoke } from '../src/host/tauriTransport';

test('bridge preserves method channels, argument order, optional positions and host errors', async () => {
  const calls: unknown[] = [];
  const invoke: TauriInvoke = async (command, args) => {
    calls.push({ command, ...args });
    if (args.channel === 'git:push') throw { code: 'GIT_ERROR', message: 'Push rejected' };
    return null as never;
  };
  const transport = await createTauriTransport(invoke, async () => () => {});
  const bridge = createPraxisBridge(transport);
  await bridge.issue.list({}, 20, 10, undefined);
  await bridge.settings.get();
  assert.deepEqual(calls, [
    { command: 'praxis_rpc', channel: 'issue:list', args: [{}, 20, 10, null] },
    { command: 'praxis_rpc', channel: 'settings:get', args: [] }
  ]);
  await assert.rejects(transport.invoke('git:push', '/tmp/repo'), error => {
    assert.ok(error instanceof DesktopInvocationError);
    assert.equal(error.code, 'GIT_ERROR');
    assert.equal(error.channel, 'git:push');
    assert.equal(error.message, 'Push rejected');
    return true;
  });
  transport.dispose();
});

test('subscription precedes requests, preserves event shapes, isolates listeners, and cleans up', async () => {
  let receive!: (event: { payload: HostEvent }) => void;
  let unlistened = 0;
  let subscribed = false;
  const failures: unknown[] = [];
  const transport = await createTauriTransport(async () => {
    assert.ok(subscribed);
    return null as never;
  }, async (event, callback) => {
    assert.equal(event, 'praxis:event');
    receive = callback;
    subscribed = true;
    return () => { unlistened++; };
  }, error => failures.push(error));
  const bridge = createPraxisBridge(transport);
  const settings: unknown[] = [];
  const arrays: unknown[] = [];
  const tuples: unknown[] = [];
  const off = bridge.settings.onChanged(value => settings.push(value));
  transport.on('settings:changed', () => { throw new Error('listener error'); });
  transport.on('settings:changed', (_, value) => settings.push(value));
  transport.on('ai:sessionsChanged', (_, value) => arrays.push(value));
  bridge.runs.onLog((project, line) => tuples.push([project, line]));
  await bridge.settings.get();
  receive({ payload: { channel: 'settings:changed', payload: { appearance: {} } } });
  off();
  receive({ payload: { channel: 'settings:changed', payload: 2 } });
  receive({ payload: { channel: 'ai:sessionsChanged', payload: ['a', 'b'] } });
  receive({ payload: { channel: 'runs:log', payload: ['project', { text: 'ready' }] } });
  assert.deepEqual(settings, [{ appearance: {} }, { appearance: {} }, 2]);
  assert.equal(failures.length, 2);
  assert.deepEqual(arrays, [['a', 'b']]);
  assert.deepEqual(tuples, [['project', { text: 'ready' }]]);
  transport.dispose();
  transport.dispose();
  receive({ payload: { channel: 'settings:changed', payload: 3 } });
  assert.equal(settings.length, 3);
  assert.equal(unlistened, 1);
  await assert.rejects(bridge.settings.get(), { code: 'DESKTOP_CLOSED' });
});

test('undefined survives the JSON transport as null at any depth, so a clear is not lost', async () => {
  // This is the exact patch the prompt-analysis provider control sends to clear both settings.
  const patch = { ai: { promptAnalysisProvider: undefined, promptAnalysisModel: undefined, keep: 'x' } };
  assert.equal(JSON.stringify(patch), '{"ai":{"keep":"x"}}', 'plain JSON drops the clear');
  const sent = nullUndefined(patch);
  assert.equal(JSON.stringify(sent), '{"ai":{"promptAnalysisProvider":null,"promptAnalysisModel":null,"keep":"x"}}');
  assert.deepEqual(nullUndefined([1, undefined, { a: [undefined] }]), [1, null, { a: [null] }]);
  assert.equal(nullUndefined(undefined), null);
  const when = new Date(0);
  assert.equal(nullUndefined(when), when, 'non-plain objects are left alone');

  const seen: unknown[] = [];
  const transport = await createTauriTransport(async (_command, args) => { seen.push(args.args); return null as never; }, async () => () => {});
  await createPraxisBridge(transport).settings.set(patch as never);
  assert.deepEqual(seen, [[{ ai: { promptAnalysisProvider: null, promptAnalysisModel: null, keep: 'x' } }]]);
  transport.dispose();
});
