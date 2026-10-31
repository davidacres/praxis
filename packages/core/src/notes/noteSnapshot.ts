import type { NoteRequestSnapshot, NotesDocument, NotesResult, ProjectNote } from './noteTypes';
import { isNoteId, isNoteTimestamp, notesFailure, resolveNoteEntity, validateNotesProject } from './noteValidation';

/** Pure capture against validated storage; project registry and clock are supplied by main. */
export function prepareNoteSnapshot(
  document: NotesDocument, knownProjectIds: readonly string[], projectId: string,
  source: unknown, capturedAt: string
): NotesResult<NoteRequestSnapshot> {
  const project = validateNotesProject(projectId, knownProjectIds);
  if (!project.ok) return project;
  if (!isNoteTimestamp(capturedAt)) return notesFailure('VALIDATION_ERROR', 'capturedAt', 'Invalid capture timestamp.');
  if (typeof source !== 'object' || source === null || !('kind' in source) || !('id' in source) ||
      (source.kind !== 'note' && source.kind !== 'group') || !isNoteId(source.id)) {
    return notesFailure('VALIDATION_ERROR', 'source', 'Invalid note source.');
  }
  let notes: ProjectNote[];
  let title: string;
  if (source.kind === 'note') {
    const result = resolveNoteEntity(document.notes, projectId, source.id, 'note');
    if (!result.ok) return result;
    notes = [result.value];
    title = result.value.title;
  } else {
    const result = resolveNoteEntity(document.groups, projectId, source.id, 'group');
    if (!result.ok) return result;
    title = result.value.title;
    if (!result.value.noteIds.length) return notesFailure('EMPTY_GROUP', 'source', 'Group has no notes.');
    notes = [];
    for (const id of result.value.noteIds) {
      const member = resolveNoteEntity(document.notes, projectId, id, 'note');
      if (!member.ok) return member;
      notes.push(member.value);
    }
  }
  return { ok: true, value: {
    projectId, capturedAt, source: { kind: source.kind, id: source.id, title },
    notes: notes.map(note => ({ id: note.id, title: note.title, body: note.body, createdAt: note.createdAt, updatedAt: note.updatedAt }))
  } };
}
