import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import './sessionOrganizer.css';

type Entry = { id: string; members?: string[]; name?: string; collapsed?: boolean };
const MIME = 'application/x-praxis-session-order';
// A loaded transparent image. A detached canvas can't be drawn as a drag image, so
// macOS fell back to a default icon that slid in from the window's top-left.
const blankDragImage = typeof Image === 'undefined' ? undefined : Object.assign(new Image(1, 1), {
  src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
});

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
export function SessionOrganizer({ scope, items, preserveMissing = false, dragPreview = false }: { scope: string; items: Array<{ id: string; at?: string; node: ReactNode }>; preserveMissing?: boolean; dragPreview?: boolean }) {
  const storageKey = `praxis-session-layout:${scope}`;
  const [saved, setSaved] = useState(() => readLayout(storageKey));
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const removePreview = useRef<() => void>(() => {});
  const finishPreview = useRef<(destination?: string) => void>(() => {});
  const previewHint = useRef<(label: string, count?: number) => void>(() => {});
  const grabPoint = useRef<{ x: number; y: number }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState<string>();
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(undefined), 900);
    return () => clearTimeout(timer);
  }, [landed]);
  useEffect(() => () => removePreview.current(), []);
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
  // Saved layouts retain groups; modification time determines their display order.
  const activity = new Map(items.map(item => [item.id, Date.parse(item.at ?? '') || 0]));
  const lastActivity = (entry: Entry) => Math.max(...(entry.members ?? [entry.id]).map(id => activity.get(id) ?? 0));
  for (const entry of entries) entry.members?.sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
  entries.sort((a, b) => lastActivity(b) - lastActivity(a));
  const draggedSize = entries.find(entry => entry.id === draggedId)?.members?.length ?? 1;

  const save = (next: Entry[], ungroupedId?: string) => {
    // A filtered or capped feed must not erase sessions that are temporarily hidden.
    const result: Entry[] = next.map(entry => ({ ...entry, members: entry.members && [...entry.members] }));
    if (preserveMissing) {
      for (const previous of saved) {
        if (previous.members) {
          const missing = previous.members.filter(id => !nodes.has(id));
          if (missing.length) {
            if (previous.id === ungroupedId) {
              result.push(...missing.map(id => ({ id })));
              continue;
            }
            const group = result.find(entry => entry.id === previous.id && entry.members);
            if (group?.members) group.members.push(...missing);
            else result.push({ ...previous, members: missing });
          }
        } else if (!nodes.has(previous.id)) result.push(previous);
      }
    }
    setSaved(result);
    localStorage.setItem(storageKey, JSON.stringify(result));
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
    removePreview.current();
    setDragging(true);
    event.dataTransfer.setData(MIME, JSON.stringify({ scope, id }));
    event.dataTransfer.effectAllowed = 'move';
    if (dragPreview) {
      const source = event.currentTarget;
      const bounds = source.getBoundingClientRect();
      const grab = grabPoint.current ?? { x: event.clientX, y: event.clientY };
      const offset = { x: grab.x - bounds.left, y: grab.y - bounds.top };
      // The landing slot opened between rows matches the dragged row's height.
      rootRef.current?.style.setProperty('--drop-gap', `${Math.round(bounds.height)}px`);
      const preview = source.cloneNode(true) as HTMLElement;
      preview.classList.add('session-organizer-drag-preview');
      preview.dataset.testid = 'session-drag-preview';
      preview.style.width = `${bounds.width}px`;
      preview.style.transformOrigin = `${offset.x}px ${offset.y}px`;
      preview.setAttribute('aria-hidden', 'true');
      preview.inert = true;
      preview.removeAttribute('draggable');
      preview.removeAttribute('id');
      preview.removeAttribute('data-session-order-id');
      preview.removeAttribute('data-drop-position');
      preview.removeAttribute('data-dragging');
      preview.querySelectorAll('[id], [data-testid], [tabindex]').forEach(element => {
        element.removeAttribute('id');
        element.removeAttribute('data-testid');
        element.removeAttribute('tabindex');
      });
      const move = (x: number, y: number) => {
        preview.style.left = `${x - offset.x}px`;
        preview.style.top = `${y - offset.y}px`;
      };
      move(event.clientX, event.clientY);
      document.body.append(preview);
      // Hide the browser's own drag image; our preview follows the pointer instead.
      if (blankDragImage) event.dataTransfer.setDragImage(blankDragImage, 0, 0);
      // One pickup wobble that settles, then the card leans the way it is carried.
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const startedAt = performance.now();
      let last = { x: event.clientX, y: event.clientY };
      let push = 0;
      let lean = 0;
      let motion = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - startedAt) / 320);
        const wobble = Math.sin(t * Math.PI * 2) * 3.5 * (1 - t);
        push *= 0.82;
        lean += (Math.max(-7, Math.min(7, push)) - lean) * 0.25;
        preview.style.transform = `rotate(${(2 + wobble + lean).toFixed(2)}deg) scale(${(1 + 0.03 * Math.min(1, t * 3)).toFixed(3)})`;
        motion = requestAnimationFrame(tick);
      };
      if (!reducedMotion) motion = requestAnimationFrame(tick);
      const follow = (drag: globalThis.DragEvent) => {
        // Chromium reports (0, 0) on some drag events; ignore them rather than jump.
        if (drag.clientX === 0 && drag.clientY === 0) return;
        push += (drag.clientX - last.x) * 0.6 + (drag.clientY - last.y) * 0.12;
        last = { x: drag.clientX, y: drag.clientY };
        move(drag.clientX, drag.clientY);
      };
      let frame = 0;
      let animation: Animation | undefined;
      let finished = false;
      const detach = () => {
        document.removeEventListener('dragover', follow, true);
        document.removeEventListener('dragend', end, true);
      };
      const cleanup = () => {
        detach();
        cancelAnimationFrame(frame);
        cancelAnimationFrame(motion);
        animation?.cancel();
        preview.remove();
        setDraggedId(undefined);
        setDragging(false);
        setHover(undefined);
        removePreview.current = () => {};
        finishPreview.current = () => {};
        previewHint.current = () => {};
      };
      const finish = (destination?: string) => {
        if (finished) return;
        finished = true;
        detach();
        cancelAnimationFrame(motion);
        preview.removeAttribute('data-drop-label');
        preview.removeAttribute('data-drop-intent');
        setHover(undefined);
        setDragging(false);
        if (reducedMotion) { cleanup(); return; }
        // Wait for React to place the dropped row before measuring its final position.
        frame = requestAnimationFrame(() => {
          const target = destination && document.querySelector<HTMLElement>(`[data-session-order-id="${CSS.escape(destination)}"]`);
          const endBounds = target ? target.getBoundingClientRect() : source.isConnected ? source.getBoundingClientRect() : bounds;
          const transform = getComputedStyle(preview).transform;
          preview.dataset.phase = destination ? 'settling' : 'returning';
          // Spring into the landing slot (a slight overshoot), or glide back on cancel.
          animation = preview.animate([
            { left: preview.style.left, top: preview.style.top, transform },
            { left: `${endBounds.left}px`, top: `${endBounds.top}px`, transform: 'rotate(0deg) scale(1)' }
          ], destination
            ? { duration: 300, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
            : { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
          animation.onfinish = cleanup;
        });
      };
      const end = () => finish();
      removePreview.current = cleanup;
      finishPreview.current = finish;
      previewHint.current = (label, count) => {
        preview.dataset.dropLabel = label;
        // Grouping drops get a badge on the card itself, since the target row is under the card:
        // "+" for a new group, or the group's new size when joining one.
        preview.dataset.dropIntent = label === 'Create group' || label === 'Add to group' ? 'group' : '';
        preview.dataset.dropBadge = count ? String(count) : '+';
      };
      document.addEventListener('dragover', follow, true);
      document.addEventListener('dragend', end, true);
      setDraggedId(id);
    }
  };
  const position = (event: DragEvent, group: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect();
    let top = rect.top;
    let height = rect.height;
    if (dragPreview) {
      // Measure against the row itself, not the landing slot opened inside it, so the
      // slot never moves out from under the pointer and flickers.
      const style = getComputedStyle(event.currentTarget);
      top += parseFloat(style.paddingTop);
      height -= parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    }
    const fraction = (event.clientY - top) / height;
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
    let landedId = id;
    if (where === 'join' && targetEntry?.members) {
      targetEntry.members = [...targetEntry.members, ...members];
      targetEntry.collapsed = false;
      landedId = target;
    } else if (where === 'group') {
      if (parent?.members) {
        parent.members.splice(parent.members.indexOf(target) + 1, 0, ...members);
      } else {
        const index = next.findIndex(entry => entry.id === target);
        if (index < 0) return;
        const groupId = `group:${crypto.randomUUID()}`;
        next.splice(index, 1, { id: groupId, name: 'New group', members: [target, ...members] });
        landedId = groupId;
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
    if (dragPreview) setLanded(landedId);
    finishPreview.current(moving.members && !next.some(entry => entry.id === id) ? members[0] : id);
  };
  const handlers = (id: string, group = false) => ({
    draggable: editing !== id,
    onPointerDown: (event: React.PointerEvent) => { grabPoint.current = { x: event.clientX, y: event.clientY }; },
    onDragStart: (event: DragEvent) => start(event, id),
    onDragEnd: () => { finishPreview.current(); setHover(undefined); setDragging(false); },
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragPreview && (!draggedId || draggedId === id || entries.find(entry => entry.id === draggedId)?.members?.includes(id))) {
        previewHint.current('');
        setHover(undefined);
        return;
      }
      event.dataTransfer.dropEffect = 'move';
      const where = position(event, group);
      const joining = where === 'join' ? entries.find(entry => entry.id === id)
        : where === 'group' ? entries.find(entry => entry.members?.includes(id)) : undefined;
      previewHint.current(joining ? 'Add to group' : where === 'group' ? 'Create group'
        : where === 'before' ? 'Move before' : 'Move after',
      joining?.members && joining.members.length + draggedSize);
      setHover({ id, position: where });
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      if (dragPreview) {
        // Opening a landing slot moves the row's content out from under a still pointer, which
        // fires a leave from the content; only a pointer outside the row really leaves it.
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) return;
      }
      setHover(undefined);
      previewHint.current('');
    },
    onDrop: (event: DragEvent) => drop(event, id, position(event, group))
  });
  const row = (id: string) => <div key={id} className="session-organizer-item" data-session-order-id={id}
    data-dragging={draggedId === id || undefined} data-landed={landed === id || undefined}
    data-drop-position={hover?.id === id ? hover.position : undefined} {...handlers(id)}>
    {nodes.get(id)}
  </div>;
  const rename = (id: string) => {
    save(entries.map(entry => entry.id === id ? { ...entry, name: draft.trim() || entry.name || 'New group' } : entry));
    setEditing(undefined);
  };
  return <div ref={rootRef} className={`session-organizer${dragging ? ' session-organizer--dragging' : ''}${dragPreview ? ' session-organizer--live' : ''}`} data-testid="session-organizer" data-scope={scope}>
    {entries.map(entry => entry.members ? <Fragment key={entry.id}>
      <div className="tree-row session-organizer-group" data-testid="session-custom-group" data-session-order-id={entry.id}
        data-dragging={draggedId === entry.id || undefined} data-landed={landed === entry.id || undefined}
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
        {dragPreview && hover?.id === entry.id && hover.position === 'join'
          ? <span className="tree-meta session-organizer-count-preview" data-testid="session-group-count-preview">{entry.members.length + draggedSize}</span>
          : <span className="tree-meta">{entry.members.length}</span>}
        <button className="icon-btn icon-btn-sm" aria-label={`Rename group ${entry.name}`} onClick={() => { setEditing(entry.id); setDraft(entry.name ?? 'New group'); }}><Icon name="pencil" size={12} /></button>
        <button className="icon-btn icon-btn-sm" aria-label={`Ungroup ${entry.name}`} title="Ungroup sessions" onClick={() => save(entries.flatMap(item => item.id === entry.id ? (item.members ?? []).map(id => ({ id })) : [item]), entry.id)}><Icon name="close" size={12} /></button>
      </div>
      {!entry.collapsed && <div className="session-organizer-members">{entry.members.map(row)}</div>}
    </Fragment> : row(entry.id))}
    {entries.length > 0 && <div className="session-organizer-end" data-testid="session-ungroup-drop"
      onDragOver={event => { if (event.dataTransfer.types.includes(MIME)) { event.preventDefault(); event.stopPropagation(); previewHint.current('Move outside group'); } }}
      onDrop={event => drop(event, '__end__', 'after')}>Drop here to move outside a group</div>}
  </div>;
}
