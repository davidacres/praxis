import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteGroup, ProjectNote } from '@praxis/core';
import { notesClient } from './notesClient';

export interface NotesCollection { notes: ProjectNote[]; groups: NoteGroup[]; error?: string }
const EMPTY: NotesCollection = { notes: [], groups: [] };
const noReload = async () => undefined;

/** A project's notes and groups, re-read whenever main reports a change to that project. */
export function useNotesCollection(projectId: string | undefined): NotesCollection & { reload: () => Promise<void> } {
  const [collection, setCollection] = useState<NotesCollection>(EMPTY);
  const reloadRef = useRef<() => Promise<void>>(noReload);
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    if (!projectId) { setCollection(EMPTY); return; }
    let cancelled = false;
    let generation = 0;
    let latest = Promise.resolve();
    const load = () => {
      const request = ++generation;
      latest = notesClient.list(projectId).then(outcome => {
        if (cancelled || request !== generation) return;
        setCollection(outcome.ok
          ? { notes: outcome.value.notes, groups: outcome.value.groups }
          : current => ({ ...current, error: outcome.message }));
      });
      return latest;
    };
    // Mutations wait for the latest snapshot too: a later change notification
    // can supersede their explicit read while it is still in flight.
    reloadRef.current = async () => {
      let pending = load();
      while (!cancelled) {
        await pending;
        if (pending === latest) return;
        pending = latest;
      }
    };
    // Subscribe first; stale reads must not roll back membership or detach menus.
    const off = notesClient.onChanged(changed => { if (changed === projectId) void load(); });
    void load();
    return () => { cancelled = true; off(); reloadRef.current = noReload; };
  }, [projectId]);
  return { ...collection, reload };
}

/** A project's notes, re-read whenever main reports a change to that project. */
export function useProjectNotes(projectId: string | undefined): ProjectNote[] {
  return useNotesCollection(projectId).notes;
}
