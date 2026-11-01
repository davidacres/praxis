import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_AUTO_SEND_MS, draftInstruction, isFreshHandoff, peekSessionHandoff, saveDraftInstruction, stageSessionHandoff, takeSessionHandoff } from '../src/notes/noteSendStore.ts';

const handoff = { reference: { id: 'r', kind: 'note', label: 'Note: A', content: 'c', capturedAt: 't' }, instruction: 'go' } as never;

test('a staged handoff is consumed exactly once', () => {
  stageSessionHandoff('k', handoff);
  assert.equal(peekSessionHandoff('k')?.instruction, 'go');
  assert.equal(takeSessionHandoff('k')?.instruction, 'go');
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

test('a handoff only submits itself shortly after the explicit Send', () => {
  stageSessionHandoff('f', handoff);
  const staged = takeSessionHandoff('f')!;
  assert.equal(isFreshHandoff(staged), true);
  assert.equal(isFreshHandoff(staged, staged.stagedAt! + HANDOFF_AUTO_SEND_MS + 1), false);
});
