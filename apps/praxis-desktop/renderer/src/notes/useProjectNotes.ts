import { useEffect, useState } from 'react';
import type { NoteGroup, ProjectNote } from '@praxis/core';
import { notesClient } from './notesClient';

export interface NotesCollection { notes: ProjectNote[]; groups: NoteGroup[]; error?: string }
const EMPTY: NotesCollection = { notes: [], groups: [] };

/** A project's notes and groups, re-read whenever main reports a change to that project. */
export function useNotesCollection(projectId: string | undefined): NotesCollection {
  const [collection, setCollection] = useState<NotesCollection>(EMPTY);
  useEffect(() => {
    if (!projectId) { setCollection(EMPTY); return; }
    let cancelled = false;
    const load = () => {
      void notesClient.list(projectId).then(outcome => {
        if (cancelled) return;
        setCollection(outcome.ok
          ? { notes: outcome.value.notes, groups: outcome.value.groups }
          : current => ({ ...current, error: outcome.message }));
      });
    };
    load();
    const off = notesClient.onChanged(changed => { if (changed === projectId) load(); });
    return () => { cancelled = true; off(); };
  }, [projectId]);
  return collection;
}

/** A project's notes, re-read whenever main reports a change to that project. */
export function useProjectNotes(projectId: string | undefined): ProjectNote[] {
  return useNotesCollection(projectId).notes;
}
