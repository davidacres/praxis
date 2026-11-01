import { useSyncExternalStore } from 'react';
import type { ProjectNote } from '@praxis/core';
import { notesClient } from './notesClient';

export type NoteSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface NoteDraft {
  /** The project the draft was started in; it never moves to another project. */
  projectId?: string;
  noteId?: string;
  title: string;
  body: string;
}

export interface NotesSessionState {
  draft: NoteDraft;
  /** Text differs from what was last saved (or has never been saved). */
  dirty: boolean;
  save: NoteSaveState;
  error?: string;
}

const AUTOSAVE_MS = 600;
const TITLE_MAX = 200;
const blank = (projectId?: string): NoteDraft => ({ projectId, title: '', body: '' });

let state: NotesSessionState = { draft: blank(), dirty: false, save: 'idle' };
let version = 0;
let timer: number | undefined;
let chain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const set = (next: Partial<NotesSessionState>) => {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
};

/** A saved title can't be empty, so blank titles fall back to the body's first line. */
function titleFor(draft: NoteDraft): string {
  const typed = draft.title.trim();
  if (typed) return typed.slice(0, TITLE_MAX);
  const firstLine = draft.body.split('\n').find(line => line.trim())?.trim();
  return (firstLine ?? 'Untitled note').slice(0, TITLE_MAX);
}

const hasContent = (draft: NoteDraft) => Boolean(draft.title.trim() || draft.body.trim());

async function saveNow(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!state.dirty) return;
  const draft = state.draft;
  // Nothing is written without a project, or for an untouched blank note.
  if (!draft.projectId || (!draft.noteId && !hasContent(draft))) return;
  const sent = version;
  set({ save: 'saving', error: undefined });
  const outcome = draft.noteId
    ? await notesClient.update(draft.projectId, draft.noteId, titleFor(draft), draft.body)
    : await notesClient.create(draft.projectId, titleFor(draft), draft.body);
  if (!outcome.ok) { set({ save: 'error', error: outcome.message }); return; }
  const noteId = outcome.value.id;
  // Edits made while the write was in flight stay dirty and save next.
  const stale = version !== sent;
  set({
    draft: state.draft.noteId ? state.draft : { ...state.draft, noteId },
    dirty: stale,
    save: stale ? 'saving' : 'saved'
  });
  if (stale) schedule(0);
}

function schedule(delay: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { void flush(); }, delay);
}

/** Saves the current draft now, after any save already in flight. Never rejects. */
export function flush(): Promise<void> {
  chain = chain.then(saveNow, saveNow);
  return chain;
}

export const notesSession = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  edit(patch: Partial<Pick<NoteDraft, 'title' | 'body'>>, fallbackProjectId?: string) {
    version += 1;
    const draft = { ...state.draft, ...patch };
    if (!draft.projectId) draft.projectId = fallbackProjectId;
    set({ draft, dirty: true, save: state.save === 'error' ? 'error' : 'idle' });
    if (draft.projectId) schedule(AUTOSAVE_MS);
  },
  /** Assigns the project for a draft that was written with none selected. */
  chooseProject(projectId: string) {
    version += 1;
    set({ draft: { ...state.draft, projectId }, dirty: hasContent(state.draft) || state.dirty });
    schedule(0);
  },
  async open(note: ProjectNote) {
    await flush();
    if (state.dirty) return; // a failed save keeps the text; never replace it
    set({ draft: { projectId: note.projectId, noteId: note.id, title: note.title, body: note.body }, dirty: false, save: 'idle', error: undefined });
  },
  async startNew(projectId?: string) {
    await flush();
    if (state.dirty) return;
    set({ draft: blank(projectId), dirty: false, save: 'idle', error: undefined });
  },
  /** Called when the shelf's project changes: a saved draft is dropped, an unsaved one stays put. */
  async followProject(projectId?: string) {
    await flush();
    if (state.dirty || state.draft.projectId === projectId) return;
    set({ draft: blank(projectId), save: 'idle', error: undefined });
  }
};

export function useNotesSession(): NotesSessionState {
  return useSyncExternalStore(notesSession.subscribe, notesSession.getSnapshot);
}
