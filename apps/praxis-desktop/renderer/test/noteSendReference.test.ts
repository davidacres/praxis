import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleNoteSessions, defaultNoteInstruction, snapshotToReference } from '../src/notes/noteSendReference.ts';
import { displaySessionContext, withSessionContext } from '../src/ai/sessionContext.ts';

const entry = (id: string, title: string, body: string) => ({ id, title, body, createdAt: 't', updatedAt: 't' });
const snapshot = (kind: 'note' | 'group', notes: ReturnType<typeof entry>[]) => ({
  projectId: 'p', capturedAt: '2026-11-01T00:00:00.000Z', source: { kind, id: 'src', title: 'Src' }, notes
}) as never;

test('a group reference keeps group order and copies content', () => {
  const notes = [entry('b', 'Second', 'two'), entry('a', 'First', 'one')];
  const reference = snapshotToReference(snapshot('group', notes));
  assert.equal(reference.kind, 'note-group');
  assert.equal(reference.label, 'Group: Src (2 notes)');
  assert.ok(reference.content.indexOf('1. Second') < reference.content.indexOf('2. First'));
  notes[0].body = 'edited';
  notes[0].title = 'edited';
  assert.ok(reference.content.includes('two') && !reference.content.includes('edited'));
});

test('a single note reference and default instructions', () => {
  const one = snapshot('note', [entry('a', 'A', 'x')]);
  assert.equal(snapshotToReference(one).label, 'Note: Src');
  assert.equal(defaultNoteInstruction(one), 'Use the attached note as context.');
  assert.equal(defaultNoteInstruction(snapshot('group', [entry('a', 'A', ''), entry('b', 'B', '')])), 'Use the attached notes as context.');
});

test('chat receipt shows the label for note references', () => {
  const reference = snapshotToReference(snapshot('group', [entry('a', 'A', 'secret body'), entry('b', 'B', '')]));
  const message = withSessionContext('Do it', [reference]);
  assert.ok(message.includes('secret body'));
  assert.equal(displaySessionContext(message), 'Do it\n\nContext: Group: Src (2 notes)');
});

test('only the project\'s live top-level sessions are compatible, newest first', () => {
  const s = (issueKey: string, extra: object = {}) => ({ issueKey, projectId: 'p', startedAt: issueKey, ...extra }) as never;
  const list = compatibleNoteSessions([
    s('SESSION-aaaaaa1'), s('SESSION-aaaaaa3'), s('SESSION-aaaaaa2', { lastActivityAt: 'SESSION-aaaaaa9' }),
    s('other', { projectId: 'q' }), s('arch', { archived: true }), s('child', { parentSessionKey: 'x' }),
    s('stage', { workflowRunId: 'r', workflowNodeId: 'n' }), s('ctl', { workflowRole: 'controller' }),
    s('review~T-1'), { issueKey: 'conv', startedAt: '1' } as never
  ], 'p');
  assert.deepEqual(list.map(x => x.issueKey), ['SESSION-aaaaaa2', 'SESSION-aaaaaa3', 'SESSION-aaaaaa1']);
});
