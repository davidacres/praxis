import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotesDocument } from './noteTypes';
import type { NotesIpc } from '../host/ipcContracts';
import { prepareNoteSnapshot } from './noteSnapshot';
const at = '2026-10-31T00:00:00.000Z';
function fixture(): NotesDocument {
  return { schemaVersion: 1, notes: ['a', 'b'].map(id => ({ id, projectId: 'p', title: id, body: `body-${id}`, createdAt: at, updatedAt: at })),
    groups: [{ id: 'g', projectId: 'p', title: 'Group', noteIds: ['b', 'a'], createdAt: at, updatedAt: at }] };
}
test('single note and ordered group captures preserve provenance through later edits and deletion', () => {
  const data = fixture();
  const note = prepareNoteSnapshot(data, ['p'], 'p', { kind: 'note', id: 'a' }, at);
  const group = prepareNoteSnapshot(data, ['p'], 'p', { kind: 'group', id: 'g' }, at);
  assert.ok(note.ok && group.ok);
  assert.deepEqual(group.value.notes.map(n => n.id), ['b', 'a']);
  assert.deepEqual(group.value.source, { kind: 'group', id: 'g', title: 'Group' });
  assert.equal(group.value.projectId, 'p'); assert.equal(group.value.capturedAt, at);
  assert.deepEqual(note.value.notes[0], { id: 'a', title: 'a', body: 'body-a', createdAt: at, updatedAt: at });
  const before = JSON.stringify(group.value);
  data.notes[0].title = 'edited'; data.notes[1].body = 'changed';
  data.groups[0].noteIds.reverse(); data.groups[0].title = 'renamed';
  data.notes.length = 0; data.groups.length = 0;
  assert.equal(JSON.stringify(group.value), before);
  assert.equal(note.value.notes[0].title, 'a');
  assert.deepEqual(JSON.parse(before), group.value);
});
test('empty/incomplete/foreign groups and malformed sources fail without captures', () => {
  const d = fixture();
  const check = (expected: string, source: unknown = { kind: 'group', id: 'g' }, project = 'p', time = at) => {
    const result = prepareNoteSnapshot(d, ['p', 'other'], project, source, time);
    assert.ok(!result.ok); assert.equal(result.error.code, expected);
    assert.ok(!JSON.stringify(result).includes('body-'));
  };
  check('PROJECT_NOT_FOUND', { kind: 'note', id: 'a' }, 'missing');
  check('VALIDATION_ERROR', null); check('VALIDATION_ERROR', { kind: 'nested', id: 'g' });
  check('VALIDATION_ERROR', { kind: 'note', id: '' }); assert.equal(prepareNoteSnapshot(d, ['p'], 'p', undefined, at).ok, false);
  check('VALIDATION_ERROR', { kind: 'group', id: 'g' }, 'p', 'invalid');
  check('PROJECT_MISMATCH', { kind: 'group', id: 'g' }, 'other');
  d.groups[0].noteIds = []; check('EMPTY_GROUP');
  d.groups[0].noteIds = ['missing']; check('NOTE_NOT_FOUND');
  d.groups[0].noteIds = ['a']; d.notes[0] = { ...d.notes[0], projectId: 'other' }; check('PROJECT_MISMATCH');
});
test('future IPC snapshot result narrows and uses JSON-compatible failures', async () => {
  const prepare: NotesIpc['prepareSnapshot'] = async (project, source) => prepareNoteSnapshot(fixture(), ['p'], project, source, at);
  const result = await prepare('p', { kind: 'note', id: 'missing' });
  if (result.ok) assert.fail('Expected missing note');
  else assert.equal(result.error.code, 'NOTE_NOT_FOUND');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
