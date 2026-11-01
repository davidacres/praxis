import type { NoteGroup, NotesResult, ProjectNote } from '@praxis/core';

export type NotesOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Collapses a `NotesResult` (or a bridge failure) into a value the UI can branch on. */
async function settle<T>(call: () => Promise<NotesResult<T>>): Promise<NotesOutcome<T>> {
  try {
    const result = await call();
    return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message };
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
  onChanged: (listener: (projectId: string) => void): (() => void) => window.praxis.notes.onChanged(listener)
};
