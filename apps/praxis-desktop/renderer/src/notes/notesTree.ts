import type { NoteGroup, ProjectNote } from '@praxis/core';

export interface NotesTreeGroup {
  group: NoteGroup;
  /** Members in group order; `note` is undefined when the link points at a missing note. */
  members: Array<{ noteId: string; note?: ProjectNote }>;
}
export interface NotesTree { groups: NotesTreeGroup[]; ungrouped: ProjectNote[] }

/** Named groups with their ordered members, then notes in no group, newest first. */
export function buildNotesTree(notes: ProjectNote[], groups: NoteGroup[]): NotesTree {
  const byId = new Map(notes.map(note => [note.id, note]));
  const grouped = new Set<string>();
  const tree = groups
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(group => {
      group.noteIds.forEach(id => grouped.add(id));
      return { group, members: group.noteIds.map(noteId => ({ noteId, note: byId.get(noteId) })) };
    });
  const ungrouped = notes
    .filter(note => !grouped.has(note.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { groups: tree, ungrouped };
}

export const addMember = (noteIds: string[], noteId: string): string[] =>
  noteIds.includes(noteId) ? noteIds : [...noteIds, noteId];

export const removeMember = (noteIds: string[], noteId: string): string[] =>
  noteIds.filter(id => id !== noteId);

/** Moves a member to `toIndex` (clamped), keeping everything else in order. */
export function moveMember(noteIds: string[], noteId: string, toIndex: number): string[] {
  const from = noteIds.indexOf(noteId);
  if (from < 0) return noteIds;
  const rest = noteIds.filter(id => id !== noteId);
  rest.splice(Math.max(0, Math.min(rest.length, toIndex)), 0, noteId);
  return rest;
}
