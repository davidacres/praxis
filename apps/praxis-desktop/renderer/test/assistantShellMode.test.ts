import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCKED_KEY,
  OPEN_KEY,
  applyShellModeAction,
  nextShellMode,
  persistShellMode,
  readShellMode
} from '../src/assistant/assistantShellMode.ts';

/* TASK-484 AC-A: dock↔float does not change execution ownership. */

const memoryStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    dump: () => Object.fromEntries(values)
  };
};

test('the shell mode is two persisted booleans, defaulting to floating and closed', () => {
  const store = memoryStore();
  assert.deepEqual(readShellMode(store), { docked: false, open: false });
  persistShellMode(store, { docked: true, open: true });
  assert.deepEqual(store.dump(), { [DOCKED_KEY]: '1', [OPEN_KEY]: '1' });
  assert.deepEqual(readShellMode(store), { docked: true, open: true });
  persistShellMode(store, { docked: false, open: false });
  assert.deepEqual(store.dump(), { [DOCKED_KEY]: '0', [OPEN_KEY]: '0' });
});

test('a half-written store reads each key independently', () => {
  assert.deepEqual(readShellMode(memoryStore({ [DOCKED_KEY]: '1' })), { docked: true, open: false });
  assert.deepEqual(readShellMode(memoryStore({ [OPEN_KEY]: '1' })), { docked: false, open: true });
});

test('each shell action moves only the flag it owns', () => {
  const cases = [
    ['dock', { docked: false, open: true }, { docked: true, open: true }],
    ['float', { docked: true, open: true }, { docked: false, open: true }],
    ['toggleDock', { docked: true, open: true }, { docked: false, open: true }],
    ['toggleDock', { docked: false, open: false }, { docked: true, open: false }],
    ['open', { docked: false, open: false }, { docked: false, open: true }],
    ['close', { docked: true, open: true }, { docked: true, open: false }],
    ['toggleOpen', { docked: false, open: true }, { docked: false, open: false }]
  ] as const;
  for (const [action, current, expected] of cases) {
    assert.deepEqual(nextShellMode(current, action), expected, `${action} from ${JSON.stringify(current)}`);
  }
});

test('dock↔float issues no assistant command and carries the open conversation through', () => {
  for (const action of ['dock', 'float', 'toggleDock'] as const) {
    const { state, commands } = applyShellModeAction({ docked: false, open: true, conversationId: 'conv-1' }, action);
    assert.deepEqual(commands, [], `${action} must not issue an assistant command`);
    assert.equal(state.conversationId, 'conv-1', `${action} must not change which conversation is open`);
  }
  // Opening and closing are equally neutral: the conversation is not created or dropped here.
  for (const action of ['open', 'close', 'toggleOpen'] as const) {
    const { state, commands } = applyShellModeAction({ docked: true, open: true, conversationId: 'conv-1' }, action);
    assert.deepEqual(commands, []);
    assert.equal(state.conversationId, 'conv-1');
  }
  // A shell with no conversation open still has none after any action.
  for (const action of ['dock', 'float', 'toggleDock', 'open', 'close', 'toggleOpen'] as const) {
    const { state } = applyShellModeAction({ docked: false, open: false }, action);
    assert.equal(state.conversationId, undefined);
  }
});

test('docking then floating returns to the original shell state', () => {
  const start = { docked: false, open: true, conversationId: 'conv-1' };
  const docked = applyShellModeAction(start, 'dock').state;
  const back = applyShellModeAction(docked, 'float').state;
  assert.deepEqual(back, start);
});
