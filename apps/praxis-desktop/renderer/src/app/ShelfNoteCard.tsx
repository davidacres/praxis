import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { flush, notesSession, useNotesSession } from '../notes/notesSession';
import { requestNoteSend } from '../notes/noteSendStore';
import { useProjectNotes } from '../notes/useProjectNotes';

const RECENT_LIMIT = 5;
const NEW_NOTE = '__new';

/**
 * The shelf's note card. It edits the same shared draft as the sidebar's
 * NoteEditor, but reads as one sheet: the title is the first line, set bold, and
 * Enter moves straight on into the body. "Use as goal" hands the text to the
 * new-session card without retyping it.
 */
export function ShelfNoteCard({ open, offset, projectId, projects, onUseAsGoal, onClosed }: {
  open: boolean;
  offset: number;
  projectId?: string;
  projects: ProjectRecord[];
  onUseAsGoal: (text: string) => void;
  onClosed: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(open); }, [open]);
  const { draft, dirty, save } = useNotesSession();
  const effectiveProject = draft.projectId ?? projectId;
  const project = projects.find(item => item.id === effectiveProject);
  const notes = useProjectNotes(effectiveProject);
  useEffect(() => { void notesSession.followProject(projectId); }, [projectId]);
  const recent = [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  const text = [draft.title.trim(), draft.body.trim()].filter(Boolean).join('\n\n');
  const status = save === 'saving' ? 'Saving…' : save === 'saved' && !dirty ? 'Saved' : dirty && !effectiveProject ? 'Not saved' : '';
  const onTitleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(0, 0);
  };
  const onBodyKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const body = event.currentTarget;
    if (event.key === 'Backspace' && body.selectionStart === 0 && body.selectionEnd === 0) {
      event.preventDefault();
      const end = titleRef.current?.value.length ?? 0;
      titleRef.current?.focus();
      titleRef.current?.setSelectionRange(end, end);
    }
  };

  return <article id="session-shelf-notes-card" className={`session-shelf__card session-shelf__card--notes${shown ? ' is-open' : ''}`}
    style={{ marginTop: offset }} aria-label="Notes" data-testid="session-shelf-notes-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(); }}>
    <header className="session-shelf__band session-shelf__band--note">
      <span className="session-shelf__band-label">Note</span>
      {project
        ? <span className="session-shelf__chip"><Icon name="folder" size={12} /><span className="session-shelf__chip-value">{project.name}</span></span>
        : <ChipSelect ariaLabel="Save note to project" placeholder="Choose project" value="" className="session-shelf__project-pick"
          options={projects.map(item => ({ value: item.id, label: item.name }))} onChange={notesSession.chooseProject} />}
      <span className="session-shelf__grow" />
      {save !== 'error' && <span className="session-shelf__save" role="status" data-testid="note-save-state">
        {status === 'Saved' && <Icon name="check" size={10} />}{status}</span>}
    </header>
    {save === 'error' && <div className="session-shelf__alert" role="alert" data-testid="note-save-error">
      <Icon name="warning" size={12} /><span>Couldn't save — your text is kept.</span>
      <button type="button" onClick={() => { void flush(); }}>Retry</button>
    </div>}
    <div className="session-shelf__sheet">
      <input ref={titleRef} className="session-shelf__note-title" value={draft.title} placeholder="Title" autoComplete="off"
        aria-label="Note title" data-testid="note-title" data-autofocus onKeyDown={onTitleKey}
        onChange={event => notesSession.edit({ title: event.target.value }, projectId)} />
      <textarea ref={bodyRef} className="session-shelf__note-body" value={draft.body} placeholder="Write a note…" rows={4}
        aria-label="Note body" data-testid="note-body" onKeyDown={onBodyKey}
        onChange={event => notesSession.edit({ body: event.target.value }, projectId)} />
    </div>
    <div className="session-shelf__row">
      {recent.length > 0
        ? <ChipSelect variant="plain" ariaLabel="Recent notes" placeholder={`${recent.length} recent`} value=""
          className="session-shelf__recent"
          options={[...recent.map(note => ({ value: note.id, label: note.title, meta: draft.noteId === note.id ? 'open' : undefined })),
            { value: NEW_NOTE, label: 'New note', icon: 'plus' as const }]}
          onChange={value => {
            if (value === NEW_NOTE) { void notesSession.startNew(projectId); return; }
            const note = recent.find(item => item.id === value);
            if (note) void notesSession.open(note);
          }} />
        : <button type="button" className="session-shelf__link" onClick={() => { void notesSession.startNew(projectId); }}>New note</button>}
      <span className="session-shelf__grow" />
      <div className="session-shelf__split" ref={menuRef}>
        <button type="button" className="session-shelf__split-main" disabled={!text} data-testid="note-use-as-goal"
          onClick={() => onUseAsGoal(text)}>Use as goal</button>
        <button type="button" className="session-shelf__split-more" aria-label="More ways to use this note" aria-expanded={menuOpen}
          disabled={!text} onClick={() => setMenuOpen(value => !value)}><Icon name="chevron-down" size={12} /></button>
        {menuOpen && <div className="session-shelf__menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onUseAsGoal(text); }}>
            <Icon name="plus" size={12} />Start a new session</button>
          <button type="button" role="menuitem" data-testid="note-send-open" disabled={!draft.noteId || !effectiveProject}
            onClick={() => {
              setMenuOpen(false);
              if (draft.noteId && effectiveProject) requestNoteSend({ projectId: effectiveProject, source: { kind: 'note', id: draft.noteId }, title: draft.title });
            }}><Icon name="chats" size={12} />Send to a session…</button>
        </div>}
      </div>
    </div>
  </article>;
}
