import {
  NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH, NOTES_SCHEMA_VERSION,
  type NotesDocument, type NotesErrorCode, type NotesResult, type NotesValidationIssue,
  type ProjectNote, type NoteGroup, type CreateNoteInput, type UpdateNoteInput,
  type CreateNoteGroupInput, type UpdateNoteGroupInput
} from './noteTypes';

export function notesFailure(code: NotesErrorCode, path: string, message: string): NotesResult<never> {
  return { ok: false, error: { code, message, issues: [{ path, message }] } };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isNoteId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function isNoteTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function title(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= NOTE_TITLE_MAX_LENGTH;
}
function body(value: unknown): value is string {
  return typeof value === 'string' && value.length <= NOTE_BODY_MAX_LENGTH;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNoteId) && new Set(value).size === value.length;
}
function identity(value: Record<string, unknown>): boolean {
  return isNoteId(value.id) && isNoteId(value.projectId) && title(value.title) &&
    isNoteTimestamp(value.createdAt) && isNoteTimestamp(value.updatedAt) && value.createdAt <= value.updatedAt;
}

/** Undefined alone means absent storage. Never writes, mutates, or silently repairs corrupt data. */
export function parseNotesDocument(value: unknown): NotesResult<NotesDocument> {
  if (value === undefined) return { ok: true, value: { schemaVersion: NOTES_SCHEMA_VERSION, notes: [], groups: [] } };
  const invalid = (path: string) => notesFailure('INVALID_PERSISTED_DATA', path, 'Invalid notes storage.');
  if (!object(value)) return invalid('$');
  if (!Number.isInteger(value.schemaVersion)) return invalid('schemaVersion');
  if (value.schemaVersion !== NOTES_SCHEMA_VERSION) return notesFailure('UNSUPPORTED_SCHEMA', 'schemaVersion', 'Unsupported notes schema.');
  if (!Array.isArray(value.notes)) return invalid('notes');
  if (!Array.isArray(value.groups)) return invalid('groups');
  const notes: ProjectNote[] = [];
  const groups: NoteGroup[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.notes.entries()) {
    if (!object(item) || !identity(item) || !isNoteId(item.id) || !isNoteId(item.projectId) ||
        !title(item.title) || !body(item.body) || !isNoteTimestamp(item.createdAt) || !isNoteTimestamp(item.updatedAt) || seen.has(item.id)) return invalid(`notes.${index}`);
    seen.add(item.id);
    notes.push({ id: item.id, projectId: item.projectId, title: item.title.trim(), body: item.body, createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  for (const [index, item] of value.groups.entries()) {
    if (!object(item) || !identity(item) || !isNoteId(item.id) || !isNoteId(item.projectId) ||
        !title(item.title) || !ids(item.noteIds) || !isNoteTimestamp(item.createdAt) || !isNoteTimestamp(item.updatedAt) || seen.has(item.id)) return invalid(`groups.${index}`);
    seen.add(item.id);
    for (const [memberIndex, id] of item.noteIds.entries()) {
      if (!notes.some(note => note.id === id && note.projectId === item.projectId)) return invalid(`groups.${index}.noteIds.${memberIndex}`);
    }
    groups.push({ id: item.id, projectId: item.projectId, title: item.title.trim(), noteIds: [...item.noteIds], createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  return { ok: true, value: { schemaVersion: NOTES_SCHEMA_VERSION, notes, groups } };
}

/** All operations must establish that the explicit project exists before reading entities. */
export function validateNotesProject(projectId: unknown, knownProjectIds: readonly string[]): NotesResult<string> {
  if (!isNoteId(projectId)) return notesFailure('VALIDATION_ERROR', 'projectId', 'Project ID is required.');
  if (!knownProjectIds.includes(projectId)) return notesFailure('PROJECT_NOT_FOUND', 'projectId', 'Project was not found.');
  return { ok: true, value: projectId };
}
export function resolveNoteEntity<T extends ProjectNote | NoteGroup>(
  records: readonly T[], projectId: string, id: unknown, kind: 'note' | 'group'
): NotesResult<T> {
  if (!isNoteId(projectId) || !isNoteId(id)) return notesFailure('VALIDATION_ERROR', 'id', 'Project and entity IDs are required.');
  const record = records.find(item => item.id === id);
  if (!record) return notesFailure(kind === 'note' ? 'NOTE_NOT_FOUND' : 'GROUP_NOT_FOUND', 'id', 'Entity was not found.');
  if (record.projectId !== projectId) return notesFailure('PROJECT_MISMATCH', 'projectId', 'Entity belongs to another project.');
  return { ok: true, value: record };
}
export function validateNoteMemberships(document: NotesDocument, projectId: string, value: unknown): NotesResult<string[]> {
  if (!isNoteId(projectId) || !ids(value)) return notesFailure('VALIDATION_ERROR', 'noteIds', 'Expected unique note IDs and a project ID.');
  for (const id of value) {
    const resolved = resolveNoteEntity(document.notes, projectId, id, 'note');
    if (!resolved.ok) return resolved;
  }
  return { ok: true, value: [...value] };
}
function editable(value: unknown, fields: readonly string[], required: readonly string[]): NotesResult<Record<string, unknown>> {
  if (!object(value)) return notesFailure('VALIDATION_ERROR', '$', 'Expected an input object.');
  const issues: NotesValidationIssue[] = [];
  if (Object.keys(value).length === 0) issues.push({ path: '$', message: 'At least one editable field is required.' });
  // Never echo unknown keys: even a field name can contain note content or a local path.
  if (Object.keys(value).some(key => !fields.includes(key))) issues.push({ path: '$', message: 'Unexpected or immutable field.' });
  for (const field of fields) {
    if (!Object.hasOwn(value, field) && !required.includes(field)) continue;
    const valid = field === 'title' ? title(value[field]) : field === 'body' ? body(value[field]) : ids(value[field]);
    if (!valid) issues.push({ path: field, message: 'Invalid field value.' });
  }
  if (issues.length) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid notes input.', issues } };
  return { ok: true, value };
}
export function validateCreateNoteInput(value: unknown): NotesResult<CreateNoteInput> {
  const result = editable(value, ['title', 'body'], ['title', 'body']);
  if (!result.ok) return result;
  const v = result.value;
  if (!title(v.title) || !body(v.body)) return notesFailure('VALIDATION_ERROR', '$', 'Invalid notes input.');
  return { ok: true, value: { title: v.title.trim(), body: v.body } };
}
/** A patch must supply at least one editable field; an empty body explicitly clears it. */
export function validateUpdateNoteInput(value: unknown): NotesResult<UpdateNoteInput> {
  const result = editable(value, ['title', 'body'], []);
  if (!result.ok) return result;
  return { ok: true, value: { ...(title(result.value.title) ? { title: result.value.title.trim() } : {}), ...(body(result.value.body) ? { body: result.value.body } : {}) } };
}
/** Validates shape; main must also validateNoteMemberships against the current document. */
export function validateCreateNoteGroupInput(value: unknown): NotesResult<CreateNoteGroupInput> {
  const result = editable(value, ['title', 'noteIds'], ['title', 'noteIds']);
  if (!result.ok) return result;
  const v = result.value;
  if (!title(v.title) || !ids(v.noteIds)) return notesFailure('VALIDATION_ERROR', '$', 'Invalid group input.');
  return { ok: true, value: { title: v.title.trim(), noteIds: [...v.noteIds] } };
}
export function validateUpdateNoteGroupInput(value: unknown): NotesResult<UpdateNoteGroupInput> {
  const result = editable(value, ['title'], []);
  if (!result.ok) return result;
  return { ok: true, value: title(result.value.title) ? { title: result.value.title.trim() } : {} };
}
