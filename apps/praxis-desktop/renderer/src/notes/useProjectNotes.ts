import { useEffect, useState } from 'react';
import type { ProjectNote } from '@praxis/core';
import { notesClient } from './notesClient';

/** A project's notes, re-read whenever main reports a change to that project. */
export function useProjectNotes(projectId: string | undefined): ProjectNote[] {
  const [notes, setNotes] = useState<ProjectNote[]>([]);
  useEffect(() => {
    if (!projectId) { setNotes([]); return; }
    let cancelled = false;
    const load = () => {
      void notesClient.list(projectId).then(outcome => {
        if (!cancelled && outcome.ok) setNotes(outcome.value.notes);
      });
    };
    load();
    const off = notesClient.onChanged(changed => { if (changed === projectId) load(); });
    return () => { cancelled = true; off(); };
  }, [projectId]);
  return notes;
}
