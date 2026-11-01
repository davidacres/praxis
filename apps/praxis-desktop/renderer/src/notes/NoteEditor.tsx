import { useEffect } from 'react';
import type { ProjectRecord } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { flush, notesSession, useNotesSession } from './notesSession';
import { useProjectNotes } from './useProjectNotes';

const RECENT_LIMIT = 5;

/**
 * Title, body and save state for one note. All state lives in `notesSession`, so
 * the shelf and (TASK-499) the sidebar edit the same draft. Writing never invokes AI.
 */
export function NoteEditor({ projectId, projects }: { projectId?: string; projects: ProjectRecord[] }) {
  const { draft, dirty, save } = useNotesSession();
  const effectiveProject = draft.projectId ?? projectId;
  const notes = useProjectNotes(effectiveProject);
  useEffect(() => { void notesSession.followProject(projectId); }, [projectId]);
  const recent = [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT);
  const status = save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : dirty && !effectiveProject ? 'Choose a project to save' : '';
  return <div className="note-editor" data-testid="note-editor">
    {!effectiveProject && <ChipSelect block ariaLabel="Save note to project" placeholder="Save to project…"
      value="" options={projects.map(project => ({ value: project.id, label: project.name }))}
      onChange={notesSession.chooseProject} />}
    <input className="note-editor__title" value={draft.title} placeholder="Title" autoComplete="off"
      aria-label="Note title" data-testid="note-title"
      onChange={event => notesSession.edit({ title: event.target.value }, projectId)} />
    <textarea className="note-editor__body" value={draft.body} placeholder="Write a note…" rows={6}
      aria-label="Note body" data-testid="note-body"
      onChange={event => notesSession.edit({ body: event.target.value }, projectId)} />
    <div className="note-editor__status">
      {save === 'error'
        ? <p role="alert" data-testid="note-save-error">Couldn't save — your text is kept.
          <button type="button" onClick={() => { void flush(); }}>Retry</button></p>
        : <p role="status" data-testid="note-save-state">{status}</p>}
      <button type="button" onClick={() => { void notesSession.startNew(projectId); }}>New note</button>
    </div>
    {recent.length > 0 && <ul className="note-editor__recent" aria-label="Recent notes">
      {recent.map(note => <li key={note.id}>
        <button type="button" aria-current={draft.noteId === note.id ? 'true' : undefined}
          onClick={() => { void notesSession.open(note); }}>{note.title}</button>
      </li>)}
    </ul>}
  </div>;
}
