import { Fragment, useState, type DragEvent, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import './sessionOrganizer.css';

type Entry = { id: string; members?: string[]; name?: string; collapsed?: boolean };
const MIME = 'application/x-praxis-session-order';

function readLayout(key: string): Entry[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) ? saved.filter((entry): entry is Entry =>
      entry && typeof entry.id === 'string' &&
      (entry.members === undefined || (Array.isArray(entry.members) && entry.members.every((id: unknown) => typeof id === 'string'))) &&
      (entry.name === undefined || typeof entry.name === 'string')) : [];
  } catch { return []; }
}

/** Sidebar-only organization; session ownership and workflow ancestry stay with their existing lists. */
export function SessionOrganizer({ scope, items }: { scope: string; items: Array<{ id: string; node: ReactNode }> }) {
  const storageKey = `praxis-session-layout:${scope}`;
  const [saved, setSaved] = useState(() => readLayout(storageKey));
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ id: string; position: string }>();
  const nodes = new Map(items.map(item => [item.id, item.node]));
  const seen = new Set<string>();
  const entries: Entry[] = saved.flatMap(entry => {
    if (entry.members) {
      const members = entry.members.filter(id => nodes.has(id) && !seen.has(id) && Boolean(seen.add(id)));
      return members.length ? [{ ...entry, members }] : [];
    }
    if (!nodes.has(entry.id) || seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [entry];
  });
  for (const item of items) if (!seen.has(item.id)) entries.push({ id: item.id });

  const save = (next: Entry[]) => {
    setSaved(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };
  const source = (event: DragEvent) => {
    try {
      const data = JSON.parse(event.dataTransfer.getData(MIME));
      return data.scope === scope && entries.some(entry => entry.id === data.id || entry.members?.includes(data.id)) ? data.id as string : undefined;
    } catch { return undefined; }
  };
  const start = (event: DragEvent, id: string) => {
    if ((event.target as HTMLElement).closest('input, button')) { event.preventDefault(); return; }
    event.stopPropagation();
    setDragging(true);
    event.dataTransfer.setData(MIME, JSON.stringify({ scope, id }));
    event.dataTransfer.effectAllowed = 'move';
  };
  const position = (event: DragEvent, group: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    return fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : group ? 'join' : 'group';
  };
  const drop = (event: DragEvent, target: string, where: string) => {
    const id = source(event);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    setHover(undefined);
    setDragging(false);
    if (id === target) return;
    const moving = entries.find(entry => entry.id === id) ?? { id };
    // A group cannot be moved into itself via one of its member rows.
    if (moving.members?.includes(target)) return;
    const next = entries.filter(entry => entry.id !== id).map(entry => entry.members
      ? { ...entry, members: entry.members.filter(member => member !== id) } : { ...entry });
    const parent = next.find(entry => entry.members?.includes(target));
    const targetEntry = next.find(entry => entry.id === target);
    const members = moving.members ?? [id];
    if (where === 'join' && targetEntry?.members) {
      targetEntry.members = [...targetEntry.members, ...members];
      targetEntry.collapsed = false;
    } else if (where === 'group') {
      if (parent?.members) {
        parent.members.splice(parent.members.indexOf(target) + 1, 0, ...members);
      } else {
        const index = next.findIndex(entry => entry.id === target);
        if (index < 0) return;
        const groupId = `group:${crypto.randomUUID()}`;
        next.splice(index, 1, { id: groupId, name: 'New group', members: [target, ...members] });
        setEditing(groupId);
        setDraft('New group');
      }
    } else if (parent?.members && !moving.members) {
      parent.members.splice(parent.members.indexOf(target) + (where === 'after' ? 1 : 0), 0, id);
    } else {
      const index = next.findIndex(entry => entry.id === (parent?.id ?? target));
      next.splice(index < 0 ? next.length : index + (where === 'after' ? 1 : 0), 0, moving);
    }
    save(next.filter(entry => !entry.members || entry.members.length));
  };
  const handlers = (id: string, group = false) => ({
    draggable: editing !== id,
    onDragStart: (event: DragEvent) => start(event, id),
    onDragEnd: () => { setHover(undefined); setDragging(false); },
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setHover({ id, position: position(event, group) });
    },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(undefined); },
    onDrop: (event: DragEvent) => drop(event, id, position(event, group))
  });
  const row = (id: string) => <div key={id} className="session-organizer-item" data-session-order-id={id}
    data-drop-position={hover?.id === id ? hover.position : undefined} {...handlers(id)}>{nodes.get(id)}</div>;
  const rename = (id: string) => {
    save(entries.map(entry => entry.id === id ? { ...entry, name: draft.trim() || entry.name || 'New group' } : entry));
    setEditing(undefined);
  };
  return <div className={`session-organizer${dragging ? ' session-organizer--dragging' : ''}`} data-testid="session-organizer" data-scope={scope}>
    {entries.map(entry => entry.members ? <Fragment key={entry.id}>
      <div className="tree-row session-organizer-group" data-testid="session-custom-group" data-session-order-id={entry.id}
        data-drop-position={hover?.id === entry.id ? hover.position : undefined} {...handlers(entry.id, true)}>
        <button className="icon-btn icon-btn-sm" aria-label={`${entry.collapsed ? 'Expand' : 'Collapse'} group ${entry.name}`} aria-expanded={!entry.collapsed}
          onClick={() => save(entries.map(item => item.id === entry.id ? { ...item, collapsed: !item.collapsed } : item))}>
          <Icon name={entry.collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <span className="tree-icon"><Icon name="folder" size={14} /></span>
        {editing === entry.id ? <input className="session-title-input" aria-label="Group name" data-testid="session-group-name-input" value={draft} autoFocus
          onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={() => rename(entry.id)}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditing(undefined); }} />
          : <span className="tree-label" onDoubleClick={() => { setEditing(entry.id); setDraft(entry.name ?? 'New group'); }}>{entry.name ?? 'New group'}</span>}
        <span className="tree-meta">{entry.members.length}</span>
        <button className="icon-btn icon-btn-sm" aria-label={`Rename group ${entry.name}`} onClick={() => { setEditing(entry.id); setDraft(entry.name ?? 'New group'); }}><Icon name="pencil" size={12} /></button>
        <button className="icon-btn icon-btn-sm" aria-label={`Ungroup ${entry.name}`} title="Ungroup sessions" onClick={() => save(entries.flatMap(item => item.id === entry.id ? (item.members ?? []).map(id => ({ id })) : [item]))}><Icon name="close" size={12} /></button>
      </div>
      {!entry.collapsed && <div className="session-organizer-members">{entry.members.map(row)}</div>}
    </Fragment> : row(entry.id))}
    {entries.length > 0 && <div className="session-organizer-end" data-testid="session-ungroup-drop"
      onDragOver={event => { if (event.dataTransfer.types.includes(MIME)) { event.preventDefault(); event.stopPropagation(); } }}
      onDrop={event => drop(event, '__end__', 'after')}>Drop here to move outside a group</div>}
  </div>;
}
