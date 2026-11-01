import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, buildNotesTree, moveMember, removeMember } from '../src/notes/notesTree.ts';

const note = (id: string, updatedAt: string) => ({ id, projectId: 'p', title: id, body: '', createdAt: updatedAt, updatedAt }) as never;
const group = (id: string, title: string, noteIds: string[]) => ({ id, projectId: 'p', title, noteIds, createdAt: '', updatedAt: '' }) as never;

test('groups list members in order, ungrouped notes newest first, missing links are kept', () => {
  const tree = buildNotesTree(
    [note('a', '2026-01-01'), note('b', '2026-01-03'), note('c', '2026-01-02')],
    [group('g2', 'Zed', ['c', 'gone', 'a']), group('g1', 'Alpha', [])]
  );
  assert.deepEqual(tree.groups.map(g => g.group.title), ['Alpha', 'Zed']);
  assert.deepEqual(tree.groups[1].members.map(m => [m.noteId, Boolean(m.note)]), [['c', true], ['gone', false], ['a', true]]);
  assert.deepEqual(tree.ungrouped.map(n => n.id), ['b']);
});

test('a note in two groups appears under both and is not ungrouped', () => {
  const tree = buildNotesTree([note('a', '1')], [group('g1', 'A', ['a']), group('g2', 'B', ['a'])]);
  assert.equal(tree.groups.every(g => g.members[0].note?.id === 'a'), true);
  assert.equal(tree.ungrouped.length, 0);
});

test('membership helpers return new ordered lists', () => {
  assert.deepEqual(addMember(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(addMember(['a'], 'a'), ['a']);
  assert.deepEqual(removeMember(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(moveMember(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveMember(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']);
  assert.deepEqual(moveMember(['a'], 'zzz', 0), ['a']);
});
