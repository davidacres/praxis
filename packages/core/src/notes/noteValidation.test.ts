import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH, type NotesDocument, type NotesResult } from './noteTypes';
import { parseNotesDocument, validateCreateNoteInput, validateUpdateNoteInput, validateCreateNoteGroupInput,
  validateUpdateNoteGroupInput, validateNoteMemberships, validateNotesProject, resolveNoteEntity } from './noteValidation';

const at = '2026-10-31T00:00:00.000Z';
function fixture(): NotesDocument {
  return { schemaVersion: 1, notes: ['a', 'b'].map(id => ({ id, projectId: 'p', title: id, body: ' \n🙂漢字\n ', createdAt: at, updatedAt: at })),
    groups: ['g', 'h'].map(id => ({ id, projectId: 'p', title: id, noteIds: ['b', 'a'], createdAt: at, updatedAt: at })) };
}
function code(result: NotesResult<unknown>, expected: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expected);
}
test('absent storage initializes independently; null, nested corruption and unsupported versions fail closed', () => {
  const first = parseNotesDocument(undefined);
  assert.deepEqual(first, { ok: true, value: { schemaVersion: 1, notes: [], groups: [] } });
  for (const value of [null, [], {}, { schemaVersion: '1' }, { schemaVersion: 1, notes: [null], groups: [] },
    { schemaVersion: 1, notes: [], groups: [false] }]) code(parseNotesDocument(value), 'INVALID_PERSISTED_DATA');
  code(parseNotesDocument({ schemaVersion: 2 }), 'UNSUPPORTED_SCHEMA');
});
test('round trip preserves stable identities, shared ordered links and exact Unicode bodies without aliasing', () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const result = parseNotesDocument(JSON.parse(before));
  assert.ok(result.ok);
  assert.deepEqual(result.value, data);
  result.value.groups[0].noteIds.reverse();
  result.value.notes[0].body = 'changed';
  assert.equal(JSON.stringify(data), before);
  assert.equal(parseNotesDocument(data).ok, true);
});
test('stored identity, timestamps and membership integrity reject invalid data', () => {
  const mutations: Array<(d: NotesDocument) => void> = [
    d => { d.notes[0] = { ...d.notes[0], id: '' }; },
    d => { d.notes[0].title = ' '; }, d => { d.notes[0] = { ...d.notes[0], createdAt: 'yesterday' }; },
    d => { d.notes[0].updatedAt = '2025-01-01T00:00:00.000Z'; },
    d => { d.notes.push({ ...d.notes[0] }); }, d => { d.groups[0].noteIds = ['a', 'a']; },
    d => { d.groups[0].noteIds = ['missing']; }, d => { d.groups[0].noteIds = ['h']; },
    d => { d.notes[0] = { ...d.notes[0], projectId: 'other' }; },
    d => { d.groups[0] = { ...d.groups[0], id: 'a' }; }
  ];
  for (const mutate of mutations) { const d = fixture(); mutate(d); code(parseNotesDocument(d), 'INVALID_PERSISTED_DATA'); }
  const d = fixture(); d.groups[0].noteIds = [];
  assert.equal(parseNotesDocument(d).ok, true);
});
test('title and body boundaries use UTF-16 units; whitespace bodies are retained', () => {
  assert.deepEqual(validateCreateNoteInput({ title: '  title  ', body: '' }), { ok: true, value: { title: 'title', body: '' } });
  for (const title of ['', '  ', 42, 'x'.repeat(NOTE_TITLE_MAX_LENGTH + 1)]) code(validateCreateNoteInput({ title, body: '' }), 'VALIDATION_ERROR');
  assert.equal(validateCreateNoteInput({ title: 'x'.repeat(NOTE_TITLE_MAX_LENGTH), body: 'x'.repeat(NOTE_BODY_MAX_LENGTH) }).ok, true);
  code(validateCreateNoteInput({ title: 'ok', body: 'x'.repeat(NOTE_BODY_MAX_LENGTH + 1) }), 'VALIDATION_ERROR');
  code(validateCreateNoteInput({ title: '🙂'.repeat(101), body: null }), 'VALIDATION_ERROR');
  assert.deepEqual(validateUpdateNoteInput({ body: '' }), { ok: true, value: { body: '' } });
  assert.deepEqual(validateUpdateNoteInput({ body: ' \n🙂 ' }), { ok: true, value: { body: ' \n🙂 ' } });
});
test('patches reject immutable or unknown fields and explicit undefined; group edits remain narrow', () => {
  for (const validate of [validateUpdateNoteInput, validateUpdateNoteGroupInput]) {
    const result = validate({});
    code(result, 'VALIDATION_ERROR');
    if (!result.ok) assert.deepEqual(result.error.issues, [{ path: '$', message: 'At least one editable field is required.' }]);
  }
  assert.deepEqual(validateUpdateNoteInput({ title: ' renamed ' }), { ok: true, value: { title: 'renamed' } });
  for (const field of ['id', 'projectId', 'createdAt', 'updatedAt', '/private/content']) {
    const result = validateUpdateNoteInput({ [field]: 'secret-body' });
    code(result, 'VALIDATION_ERROR');
    if (!result.ok) assert.deepEqual(result.error.issues, [{ path: '$', message: 'Unexpected or immutable field.' }]);
    assert.ok(!JSON.stringify(result).includes('secret-body'));
  }
  code(validateUpdateNoteInput({ title: undefined }), 'VALIDATION_ERROR');
  code(validateUpdateNoteInput({ body: 3 }), 'VALIDATION_ERROR');
  code(validateUpdateNoteGroupInput({ noteIds: [] }), 'VALIDATION_ERROR');
  assert.deepEqual(validateUpdateNoteGroupInput({ title: ' new ' }), { ok: true, value: { title: 'new' } });
  assert.equal(validateCreateNoteGroupInput({ title: 'group', noteIds: [] }).ok, true);
  for (const noteIds of [['a', 'a'], [{}], ['']]) code(validateCreateNoteGroupInput({ title: 'g', noteIds }), 'VALIDATION_ERROR');
});
test('explicit project and entity scope produce typed transport-safe errors', () => {
  const d = fixture();
  code(validateNotesProject('', ['p']), 'VALIDATION_ERROR');
  code(validateNotesProject('unknown', ['p']), 'PROJECT_NOT_FOUND');
  code(resolveNoteEntity(d.notes, 'p', '', 'note'), 'VALIDATION_ERROR');
  code(resolveNoteEntity(d.notes, 'p', 'missing', 'note'), 'NOTE_NOT_FOUND');
  code(resolveNoteEntity(d.groups, 'p', 'missing', 'group'), 'GROUP_NOT_FOUND');
  code(resolveNoteEntity(d.notes, 'foreign', 'a', 'note'), 'PROJECT_MISMATCH');
  code(validateNoteMemberships(d, 'foreign', ['a']), 'PROJECT_MISMATCH');
  code(validateNoteMemberships(d, 'p', ['missing']), 'NOTE_NOT_FOUND');
  const ids = ['b', 'a']; const result = validateNoteMemberships(d, 'p', ids);
  assert.ok(result.ok); result.value.reverse(); assert.deepEqual(ids, ['b', 'a']);
  const failure = validateNotesProject('unknown', []);
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), failure);
});
