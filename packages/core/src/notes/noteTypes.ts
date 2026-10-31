/** App-local data only: never part of board records or workspace exports. */
export const NOTES_SCHEMA_VERSION = 1;
/** Limits count JavaScript UTF-16 code units, after trimming titles only. */
export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_BODY_MAX_LENGTH = 1_000_000;

/** Main generates opaque stable IDs and ISO timestamps; identity/ownership never change. */
export interface NoteIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  updatedAt: string;
  title: string;
}
export interface ProjectNote extends NoteIdentity { body: string }
/** Ordered links, once per group; notes can belong to multiple groups. No nesting.
 * Deleting a group preserves notes. Deleting a note must remove all links in the same save.
 * Empty groups are valid storage, but cannot be captured for a request.
 */
export interface NoteGroup extends NoteIdentity { noteIds: string[] }
export interface NotesDocument { schemaVersion: 1; notes: ProjectNote[]; groups: NoteGroup[] }
export interface CreateNoteInput { title: string; body: string }
export interface UpdateNoteInput { title?: string; body?: string }
export interface CreateNoteGroupInput { title: string; noteIds: string[] }
export interface UpdateNoteGroupInput { title?: string }
export type NoteSource = { kind: 'note'; id: string } | { kind: 'group'; id: string };
export interface NoteSnapshotEntry {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Detached request data. Capturing never submits, invokes AI, or creates a live link. */
export interface NoteRequestSnapshot {
  readonly projectId: string;
  readonly capturedAt: string;
  readonly source: Readonly<NoteSource & { title: string }>;
  readonly notes: readonly NoteSnapshotEntry[];
}
export type NotesErrorCode = 'VALIDATION_ERROR' | 'PROJECT_NOT_FOUND' | 'NOTE_NOT_FOUND' |
  'GROUP_NOT_FOUND' | 'PROJECT_MISMATCH' | 'EMPTY_GROUP' | 'INVALID_PERSISTED_DATA' |
  'UNSUPPORTED_SCHEMA' | 'PERSISTENCE_FAILURE';
export interface NotesValidationIssue { path: string; message: string }
/** Messages and paths must never include user content, filesystem paths, or exception text. */
export interface NotesError { code: NotesErrorCode; message: string; issues: NotesValidationIssue[] }
export type NotesResult<T> = { ok: true; value: T } | { ok: false; error: NotesError };
