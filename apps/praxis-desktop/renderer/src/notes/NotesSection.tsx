import { useState } from 'react';
import type { ProjectNote, ProjectRecord } from '@praxis/core';
import { SectionHeader } from '../components/sidebar/SectionHeader';
import { ChipSelect, type ChipSelectOption } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { NoteEditor } from './NoteEditor';
import { notesClient, type NotesOutcome } from './notesClient';
import { addMember, buildNotesTree, moveMember, removeMember } from './notesTree';
import { notesSession, useNotesSession } from './notesSession';
import { useNotesCollection } from './useProjectNotes';

const expandedKey = (projectId: string) => `praxis-notes-expanded:${projectId}`;

function readExpanded(projectId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(expandedKey(projectId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/**
 * The sidebar's Notes section: a compact tree of named groups and notes over the same
 * collection and editor state the shelf uses. Grouping is done from row menus, not drag.
 */
export function NotesSection({ projectId, projects }: { projectId?: string; projects: ProjectRecord[] }) {
  const { prompt, confirmChoice } = useDialogs();
  const { notes, groups, error: loadError } = useNotesCollection(projectId);
  const { draft, dirty } = useNotesSession();
  const [expandedFor, setExpandedFor] = useState<{ projectId?: string; ids: string[] }>({ ids: [] });
  const [composing, setComposing] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const expanded = projectId && expandedFor.projectId === projectId ? expandedFor.ids : projectId ? readExpanded(projectId) : [];
  const toggle = (groupId: string) => {
    if (!projectId) return;
    const ids = expanded.includes(groupId) ? expanded.filter(id => id !== groupId) : [...expanded, groupId];
    setExpandedFor({ projectId, ids });
    try { localStorage.setItem(expandedKey(projectId), JSON.stringify(ids)); } catch { /* not persisted */ }
  };
  const expand = (groupId: string) => {
    if (projectId && !expanded.includes(groupId)) toggle(groupId);
  };

  const tree = buildNotesTree(notes, groups);
  const editorOpen = composing || Boolean(draft.noteId) || dirty || !projectId;

  /** Runs a mutation; failures stay visible rather than looking saved. */
  async function run<T>(call: () => Promise<NotesOutcome<T>>): Promise<T | undefined> {
    setActionError(undefined);
    const outcome = await call();
    if (!outcome.ok) { setActionError(outcome.message); return undefined; }
    return outcome.value;
  }

  async function createGroup(noteIds: string[] = []) {
    if (!projectId) return;
    const title = await prompt({ title: 'New group', label: 'Group name', confirmLabel: 'Create', validate: v => v.trim() ? undefined : 'Enter a name.' });
    if (title === null) return;
    const group = await run(() => notesClient.createGroup(projectId, title.trim(), noteIds));
    if (group) expand(group.id);
  }

  async function renameNote(note: ProjectNote) {
    const title = await prompt({ title: 'Rename note', label: 'Title', initialValue: note.title, confirmLabel: 'Rename', validate: v => v.trim() ? undefined : 'Enter a title.' });
    if (title === null) return;
    if (draft.noteId === note.id) {
      await notesSession.renameOpen(note.id, title.trim());
      return;
    }
    await run(() => notesClient.update(note.projectId, note.id, title.trim(), note.body));
  }

  async function deleteNote(note: ProjectNote) {
    const choice = await confirmChoice({ title: 'Delete this note?', message: 'It is also removed from every group. This can’t be undone.', confirmLabel: 'Delete', danger: true });
    if (choice !== 'confirm') return;
    if (await run(() => notesClient.deleteNote(note.projectId, note.id)) !== undefined) notesSession.forget(note.id);
  }

  async function renameGroup(groupId: string, current: string) {
    if (!projectId) return;
    const title = await prompt({ title: 'Rename group', label: 'Group name', initialValue: current, confirmLabel: 'Rename', validate: v => v.trim() ? undefined : 'Enter a name.' });
    if (title !== null) await run(() => notesClient.renameGroup(projectId, groupId, title.trim()));
  }

  async function deleteGroup(groupId: string) {
    if (!projectId) return;
    const choice = await confirmChoice({ title: 'Delete this group?', message: 'The notes in it are kept.', confirmLabel: 'Delete group', danger: true });
    if (choice === 'confirm') await run(() => notesClient.deleteGroup(projectId, groupId));
  }

  const setMembers = (groupId: string, noteIds: string[]) =>
    projectId ? run(() => notesClient.setMembers(projectId, groupId, noteIds)) : Promise.resolve(undefined);

  function noteMenu(note: ProjectNote, inGroup?: { id: string; noteIds: string[] }): { options: ChipSelectOption[]; onChange: (value: string) => void } {
    const addTargets = groups.filter(group => group.id !== inGroup?.id && !group.noteIds.includes(note.id));
    const index = inGroup ? inGroup.noteIds.indexOf(note.id) : -1;
    const options: ChipSelectOption[] = [
      { value: 'rename', label: 'Rename', icon: 'pencil' },
      ...addTargets.map(group => ({ value: `add:${group.id}`, label: `Add to ${group.title}`, icon: 'folder' as const })),
      { value: 'new-group', label: 'Add to new group…', icon: 'folder' },
      ...(inGroup ? [
        { value: 'up', label: 'Move up', icon: 'chevron-up' as const, disabled: index <= 0 },
        { value: 'down', label: 'Move down', icon: 'chevron-down' as const, disabled: index >= inGroup.noteIds.length - 1 },
        { value: 'remove', label: 'Remove from this group', icon: 'close' as const }
      ] : []),
      { value: 'delete', label: 'Delete note', icon: 'trash' }
    ];
    const onChange = (value: string) => {
      if (value === 'rename') void renameNote(note);
      else if (value === 'delete') void deleteNote(note);
      else if (value === 'new-group') void createGroup([note.id]);
      else if (value === 'remove' && inGroup) void setMembers(inGroup.id, removeMember(inGroup.noteIds, note.id));
      else if (value === 'up' && inGroup) void setMembers(inGroup.id, moveMember(inGroup.noteIds, note.id, index - 1));
      else if (value === 'down' && inGroup) void setMembers(inGroup.id, moveMember(inGroup.noteIds, note.id, index + 1));
      else if (value.startsWith('add:')) {
        const target = groups.find(group => group.id === value.slice(4));
        if (target) void setMembers(target.id, addMember(target.noteIds, note.id)).then(() => expand(target.id));
      }
    };
    return { options, onChange };
  }

  function renderNote(note: ProjectNote, level: 1 | 2, inGroup?: { id: string; noteIds: string[] }) {
    const menu = noteMenu(note, inGroup);
    return <li key={note.id} className={`notes-row notes-row--l${level}`} data-testid={`notes-row-${note.id}`}>
      <button type="button" className="notes-row__main" aria-current={draft.noteId === note.id ? 'true' : undefined}
        onClick={() => { setComposing(true); void notesSession.open(note); }}>
        <Icon name="note" size={12} /><span className="notes-row__title">{note.title}</span>
      </button>
      <ChipSelect value="" placeholder="" icon="ellipsis" variant="plain" menuAlign="end" className="notes-row__menu"
        ariaLabel={`Actions for note ${note.title}`} title="Note actions" options={menu.options} onChange={menu.onChange} />
    </li>;
  }

  return <section className="easymode-section easymode-section--notes notes-section" aria-label="Notes" data-testid="notes-section">
    <SectionHeader title="Notes" count={notes.length} addAriaLabel="Create new note" testId="section-header-add-notes"
      containerTestId="section-header-notes"
      onAdd={() => { setComposing(true); void notesSession.startNew(projectId); }} />
    <div className="easymode-section__body notes-section__body">
      {projectId && <button type="button" className="notes-section__new-group" data-testid="notes-new-group" onClick={() => { void createGroup(); }}>
        <Icon name="folder" size={12} /><span>New group</span>
      </button>}
      {(actionError ?? loadError) && <p className="notes-section__error" role="alert" data-testid="notes-error">{actionError ?? loadError}</p>}
      {projectId && notes.length === 0 && groups.length === 0 && <p className="notes-section__empty">No notes yet</p>}
      <ul className="notes-tree" aria-label="Notes" data-testid="notes-tree">
        {tree.groups.map(({ group, members }) => {
          const open = expanded.includes(group.id);
          return <li key={group.id} className="notes-group" data-testid={`notes-group-${group.id}`}>
            <div className="notes-row notes-row--l1 notes-row--group">
              <button type="button" className="notes-row__main" aria-expanded={open} onClick={() => toggle(group.id)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
                <span className="notes-row__title">{group.title}</span>
                <span className="notes-row__count">{group.noteIds.length}</span>
              </button>
              <ChipSelect value="" placeholder="" icon="ellipsis" variant="plain" menuAlign="end" className="notes-row__menu"
                ariaLabel={`Actions for group ${group.title}`} title="Group actions"
                options={[{ value: 'rename', label: 'Rename', icon: 'pencil' }, { value: 'delete', label: 'Delete group', icon: 'trash' }]}
                onChange={value => { if (value === 'rename') void renameGroup(group.id, group.title); else void deleteGroup(group.id); }} />
            </div>
            {open && <ul className="notes-tree__members" aria-label={`Notes in ${group.title}`}>
              {members.length === 0 && <li className="notes-section__empty notes-row--l2">No notes in this group</li>}
              {members.map(({ noteId, note }) => note
                ? renderNote(note, 2, { id: group.id, noteIds: group.noteIds })
                : <li key={noteId} className="notes-row notes-row--l2 notes-row--missing" data-testid={`notes-missing-${noteId}`}>
                  <span className="notes-row__title">Note unavailable</span>
                  <button type="button" className="notes-row__remove" onClick={() => { void setMembers(group.id, removeMember(group.noteIds, noteId)); }}>Remove</button>
                </li>)}
            </ul>}
          </li>;
        })}
        {tree.ungrouped.map(note => renderNote(note, 1))}
      </ul>
      {editorOpen && <div className="notes-section__editor">
        <NoteEditor projectId={projectId} projects={projects} showRecent={false} />
        {projectId && !dirty && <button type="button" className="notes-section__close" onClick={() => { setComposing(false); void notesSession.startNew(projectId); }}>Close editor</button>}
      </div>}
    </div>
  </section>;
}
