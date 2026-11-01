import type { NoteGroup, NoteRequestSnapshot, NotesResult, ProjectNote } from '@praxis/core';

export type NotesOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Codes the send-to-session dialog meets in ordinary use, in words a person can act on. */
const FRIENDLY: Record<string, string> = {
  EMPTY_GROUP: 'This group has no notes.',
  NOTE_NOT_FOUND: 'This note no longer exists.',
  GROUP_NOT_FOUND: 'This group no longer exists.'
};

/** Collapses a `NotesResult` (or a bridge failure) into a value the UI can branch on. */
async function settle<T>(call: () => Promise<NotesResult<T>>): Promise<NotesOutcome<T>> {
  try {
    const result = await call();
    return result.ok ? { ok: true, value: result.value } : { ok: false, message: FRIENDLY[result.error.code] ?? result.error.message };
  } catch {
    return { ok: false, message: 'Notes are unavailable.' };
  }
}

export const notesClient = {
  list: (projectId: string): Promise<NotesOutcome<{ notes: ProjectNote[]; groups: NoteGroup[] }>> =>
    settle(() => window.praxis.notes.list(projectId)),
  create: (projectId: string, title: string, body: string): Promise<NotesOutcome<ProjectNote>> =>
    settle(() => window.praxis.notes.createNote(projectId, { title, body })),
  update: (projectId: string, noteId: string, title: string, body: string): Promise<NotesOutcome<ProjectNote>> =>
    settle(() => window.praxis.notes.updateNote(projectId, noteId, { title, body })),
  deleteNote: (projectId: string, noteId: string): Promise<NotesOutcome<null>> =>
    settle(() => window.praxis.notes.deleteNote(projectId, noteId)),
  createGroup: (projectId: string, title: string, noteIds: string[] = []): Promise<NotesOutcome<NoteGroup>> =>
    settle(() => window.praxis.notes.createGroup(projectId, { title, noteIds })),
  renameGroup: (projectId: string, groupId: string, title: string): Promise<NotesOutcome<NoteGroup>> =>
    settle(() => window.praxis.notes.updateGroup(projectId, groupId, { title })),
  deleteGroup: (projectId: string, groupId: string): Promise<NotesOutcome<null>> =>
    settle(() => window.praxis.notes.deleteGroup(projectId, groupId)),
  setMembers: (projectId: string, groupId: string, noteIds: string[]): Promise<NotesOutcome<NoteGroup>> =>
    settle(() => window.praxis.notes.replaceMemberships(projectId, groupId, noteIds)),
  /** Reads a separate copy of a note or ordered group. Reads storage only; never contacts AI. */
  prepareSnapshot: (projectId: string, source: { kind: 'note' | 'group'; id: string }): Promise<NotesOutcome<NoteRequestSnapshot>> =>
    settle(() => window.praxis.notes.prepareSnapshot(projectId, source)),
  onChanged: (listener: (projectId: string) => void): (() => void) => window.praxis.notes.onChanged(listener)
};
