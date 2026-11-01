import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  NOTES_SCHEMA_VERSION, notesFailure, parseNotesDocument, prepareNoteSnapshot, resolveNoteEntity,
  validateCreateNoteGroupInput, validateCreateNoteInput, validateNoteMemberships, validateNotesProject,
  validateUpdateNoteGroupInput, validateUpdateNoteInput
} from '@praxis/core';
import type {
  NoteGroup, NoteRequestSnapshot, NotesDocument, NotesResult, ProjectNote
} from '@praxis/core';

type NotesFs = Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'rename' | 'rm' | 'mkdir'>;

export interface NotesStoreDeps {
  filePath: string;
  knownProjectIds(): readonly string[];
  /** ISO timestamp. */
  now(): string;
  newId(): string;
  /** Called once per successful save, with the project ID only (never content). */
  onChanged(projectId: string): void;
  /** Injectable for failure tests. */
  fs?: NotesFs;
}

interface Mutation<T> { document: NotesDocument; value: T }

const SAVE_FAILED = (): NotesResult<never> => notesFailure('PERSISTENCE_FAILURE', '$', 'Notes could not be saved.');
const LOAD_FAILED = (): NotesResult<never> => notesFailure('PERSISTENCE_FAILURE', '$', 'Notes could not be loaded.');

/**
 * App-local notes persistence. One JSON document, loaded lazily on first use and replaced
 * atomically (temp file + rename) through a single queue. The in-memory document only changes
 * after a successful write. A document that fails to load leaves the store unavailable: it
 * never overwrites a file it could not understand.
 *
 * No Electron imports, so it is unit-testable under plain Node.
 */
export class NotesStore {
  private readonly fs: NotesFs;
  private loaded: Promise<NotesResult<NotesDocument>> | undefined;
  private document: NotesDocument | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly deps: NotesStoreDeps) {
    this.fs = deps.fs ?? fs.promises;
  }

  public list(projectId: string): Promise<NotesResult<{ notes: ProjectNote[]; groups: NoteGroup[] }>> {
    return this.read(projectId, document => ({
      ok: true,
      value: clone({
        notes: document.notes.filter(note => note.projectId === projectId),
        groups: document.groups.filter(group => group.projectId === projectId)
      })
    }));
  }

  public createNote(projectId: string, input: unknown): Promise<NotesResult<ProjectNote>> {
    return this.mutate(projectId, document => {
      const valid = validateCreateNoteInput(input);
      if (!valid.ok) return valid;
      const at = this.deps.now();
      const note: ProjectNote = { id: this.deps.newId(), projectId, title: valid.value.title, body: valid.value.body, createdAt: at, updatedAt: at };
      return ok({ ...document, notes: [...document.notes, note] }, note);
    });
  }

  public updateNote(projectId: string, noteId: string, input: unknown): Promise<NotesResult<ProjectNote>> {
    return this.mutate(projectId, document => {
      const valid = validateUpdateNoteInput(input);
      if (!valid.ok) return valid;
      const found = resolveNoteEntity(document.notes, projectId, noteId, 'note');
      if (!found.ok) return found;
      const note: ProjectNote = { ...found.value, ...valid.value, updatedAt: this.stamp(found.value.updatedAt) };
      return ok({ ...document, notes: document.notes.map(item => (item.id === note.id ? note : item)) }, note);
    });
  }

  /** Removes the note and every membership of it in the same save. */
  public deleteNote(projectId: string, noteId: string): Promise<NotesResult<null>> {
    return this.mutate(projectId, document => {
      const found = resolveNoteEntity(document.notes, projectId, noteId, 'note');
      if (!found.ok) return found;
      const groups = document.groups.map(group =>
        group.noteIds.includes(noteId)
          ? { ...group, noteIds: group.noteIds.filter(id => id !== noteId), updatedAt: this.stamp(group.updatedAt) }
          : group
      );
      return ok({ ...document, notes: document.notes.filter(item => item.id !== noteId), groups }, null);
    });
  }

  public createGroup(projectId: string, input: unknown): Promise<NotesResult<NoteGroup>> {
    return this.mutate(projectId, document => {
      const valid = validateCreateNoteGroupInput(input);
      if (!valid.ok) return valid;
      const members = validateNoteMemberships(document, projectId, valid.value.noteIds);
      if (!members.ok) return members;
      const at = this.deps.now();
      const group: NoteGroup = { id: this.deps.newId(), projectId, title: valid.value.title, noteIds: members.value, createdAt: at, updatedAt: at };
      return ok({ ...document, groups: [...document.groups, group] }, group);
    });
  }

  public updateGroup(projectId: string, groupId: string, input: unknown): Promise<NotesResult<NoteGroup>> {
    return this.mutate(projectId, document => {
      const valid = validateUpdateNoteGroupInput(input);
      if (!valid.ok) return valid;
      const found = resolveNoteEntity(document.groups, projectId, groupId, 'group');
      if (!found.ok) return found;
      const group: NoteGroup = { ...found.value, ...valid.value, updatedAt: this.stamp(found.value.updatedAt) };
      return ok({ ...document, groups: document.groups.map(item => (item.id === group.id ? group : item)) }, group);
    });
  }

  /** Removes the group only; its notes are kept. */
  public deleteGroup(projectId: string, groupId: string): Promise<NotesResult<null>> {
    return this.mutate(projectId, document => {
      const found = resolveNoteEntity(document.groups, projectId, groupId, 'group');
      if (!found.ok) return found;
      return ok({ ...document, groups: document.groups.filter(item => item.id !== groupId) }, null);
    });
  }

  /** Replaces a group's ordered membership (add, remove and reorder are all expressed this way). */
  public replaceMemberships(projectId: string, groupId: string, noteIds: unknown): Promise<NotesResult<NoteGroup>> {
    return this.mutate(projectId, document => {
      const found = resolveNoteEntity(document.groups, projectId, groupId, 'group');
      if (!found.ok) return found;
      const members = validateNoteMemberships(document, projectId, noteIds);
      if (!members.ok) return members;
      const group: NoteGroup = { ...found.value, noteIds: members.value, updatedAt: this.stamp(found.value.updatedAt) };
      return ok({ ...document, groups: document.groups.map(item => (item.id === group.id ? group : item)) }, group);
    });
  }

  /** Read-only capture: never writes and never emits a change. */
  public prepareSnapshot(projectId: string, source: unknown): Promise<NotesResult<NoteRequestSnapshot>> {
    return this.read(projectId, document =>
      prepareNoteSnapshot(document, this.deps.knownProjectIds(), projectId, source, this.deps.now())
    );
  }

  /** A clock that steps backwards must not produce `updatedAt < createdAt`, which fails to load. */
  private stamp(previous: string): string {
    const now = this.deps.now();
    return now > previous ? now : previous;
  }

  private read<T>(projectId: string, fn: (document: NotesDocument) => NotesResult<T>): Promise<NotesResult<T>> {
    return this.enqueue(async () => {
      const project = validateNotesProject(projectId, this.deps.knownProjectIds());
      if (!project.ok) return project;
      const loaded = await this.load();
      return loaded.ok ? fn(loaded.value) : loaded;
    });
  }

  private mutate<T>(projectId: string, build: (document: NotesDocument) => NotesResult<Mutation<T>>): Promise<NotesResult<T>> {
    return this.enqueue(async () => {
      const project = validateNotesProject(projectId, this.deps.knownProjectIds());
      if (!project.ok) return project;
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const built = build(loaded.value);
      if (!built.ok) return built;
      try {
        await this.persist(built.value.document);
      } catch {
        return SAVE_FAILED();
      }
      this.document = built.value.document;
      try {
        this.deps.onChanged(projectId);
      } catch {
        // A listener failure must not turn a durable save into a reported failure.
      }
      return { ok: true, value: clone(built.value.value) } as NotesResult<T>;
    });
  }

  /** One operation at a time, each against the latest committed document. Never throws. */
  private enqueue<T>(task: () => Promise<NotesResult<T>>): Promise<NotesResult<T>> {
    const run = this.queue.then(task).catch((): NotesResult<T> => SAVE_FAILED());
    this.queue = run;
    return run;
  }

  private load(): Promise<NotesResult<NotesDocument>> {
    if (this.document) return Promise.resolve({ ok: true, value: this.document });
    this.loaded ??= this.readFromDisk();
    return this.loaded.then(result => {
      if (result.ok) this.document ??= result.value;
      return result.ok ? { ok: true, value: this.document as NotesDocument } : result;
    });
  }

  private async readFromDisk(): Promise<NotesResult<NotesDocument>> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.deps.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return parseNotesDocument(undefined);
      return LOAD_FAILED();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return notesFailure('INVALID_PERSISTED_DATA', '$', 'Invalid notes storage.');
    }
    return parseNotesDocument(parsed);
  }

  private async persist(document: NotesDocument): Promise<void> {
    await this.fs.mkdir(path.dirname(this.deps.filePath), { recursive: true });
    const tempPath = `${this.deps.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(tempPath, JSON.stringify({ ...document, schemaVersion: NOTES_SCHEMA_VERSION }, null, 2), 'utf8');
      await this.fs.rename(tempPath, this.deps.filePath);
    } catch (error) {
      await this.fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function ok<T>(document: NotesDocument, value: T): NotesResult<Mutation<T>> {
  return { ok: true, value: { document, value } };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
