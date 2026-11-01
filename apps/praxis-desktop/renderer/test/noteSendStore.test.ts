import test from 'node:test';
import assert from 'node:assert/strict';
import { draftInstruction, peekSessionHandoff, saveDraftInstruction, stageSessionHandoff, takeSessionHandoff } from '../src/notes/noteSendStore.ts';

const handoff = { reference: { id: 'r', kind: 'note', label: 'Note: A', content: 'c', capturedAt: 't' }, instruction: 'go' } as never;

test('a staged handoff is consumed exactly once', () => {
  stageSessionHandoff('k', handoff);
  assert.equal(peekSessionHandoff('k'), handoff);
  assert.equal(takeSessionHandoff('k'), handoff);
  assert.equal(takeSessionHandoff('k'), undefined);
  assert.equal(peekSessionHandoff('k'), undefined);
});

test('unsent instructions are kept per source and cleared when emptied', () => {
  const source = { kind: 'note', id: 'n1' } as const;
  saveDraftInstruction('p', source, 'hello');
  assert.equal(draftInstruction('p', source), 'hello');
  assert.equal(draftInstruction('p', { kind: 'group', id: 'n1' }), '');
  saveDraftInstruction('p', source, '');
  assert.equal(draftInstruction('p', source), '');
});
