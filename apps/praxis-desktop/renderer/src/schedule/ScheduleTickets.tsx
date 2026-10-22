import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';

export interface Candidate {
  connectionId: string;
  key: string;
  title: string;
  status: string;
  issueType: string;
  parentKey?: string;
  finished: boolean;
  container: boolean;
}

/** Load the full hierarchy for group expansion; the picker hides completed work. */
export function useScheduleTickets(project: ProjectRecord) {
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: Candidate[] = [];
      const sources = [{ connectionId: `project:${project.id}`, boardId: undefined as string | undefined }, ...project.linkedBoards];
      for (const source of sources) {
        let startAt = 0;
        for (;;) {
          const page = await window.praxis.issue.list(
            { projectKeys: [], boardId: source.boardId, statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, startAt, 100, source.connectionId
          );
          for (const issue of page.issues) {
            if (found.some(item => item.connectionId === source.connectionId && item.key === issue.key)) continue;
            const stage = project.workflowStages.find(item => item.name.toLowerCase() === issue.status.toLowerCase());
            found.push({ connectionId: source.connectionId, key: issue.key, title: issue.summary, status: issue.status, issueType: issue.issueType, parentKey: issue.parentKey,
              finished: stage ? stage.category === 'done' : (issue.statusCategory ?? '').toLowerCase() === 'done' || /^(done|closed|resolved|complete|completed)$/i.test(issue.status),
              container: /^(feature|epic)$/i.test(issue.issueType) });
          }
          startAt += page.issues.length;
          if (!page.issues.length || (page.total !== undefined ? startAt >= page.total : page.issues.length < 100)) break;
        }
      }
      if (!cancelled) { setCandidates(found); setLoadError(''); }
    })().catch(reason => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [project.id, JSON.stringify(project.linkedBoards), JSON.stringify(project.workflowStages)]);
  return { candidates, loadError };
}

export function expandScheduleTickets(candidates: Candidate[], roots: Candidate[]): Candidate[] {
  const wanted = new Set(roots.map(item => `${item.connectionId}\0${item.key}`));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of candidates) {
      const key = `${item.connectionId}\0${item.key}`;
      if (item.parentKey && wanted.has(`${item.connectionId}\0${item.parentKey}`) && !wanted.has(key)) { wanted.add(key); expanded = true; }
    }
  }
  return candidates.filter(item => !item.finished && !item.container && wanted.has(`${item.connectionId}\0${item.key}`));
}

export function ScheduleTickets({ candidates, loadError, used = () => false, onAdd, onTicketDrag, onTicketDrop }: {
  candidates?: Candidate[]; loadError: string; used?: (candidate: Candidate) => boolean;
  onAdd: (candidate: Candidate) => void;
  onTicketDrag?: (point: { x: number; y: number } | null) => void;
  onTicketDrop?: (candidate: Candidate, point: { x: number; y: number }) => void;
}) {
  const [query, setQuery] = useState('');
  const pointerDrag = useRef<{ pointerId: number; x: number; y: number; moved: boolean }>();
  const [dragPreview, setDragPreview] = useState<{ title: string; x: number; y: number }>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsedSearch, setCollapsedSearch] = useState<Set<string>>(() => new Set());
  const identity = (item: Candidate) => `${item.connectionId}\0${item.key}`;
  const all = (candidates ?? []).filter(candidate => !candidate.finished);
  const byId = new Map(all.map(item => [identity(item), item]));
  const parentOf = new Map<string, string>();
  for (const item of all) {
    if (!item.parentKey) continue;
    const parentId = `${item.connectionId}\0${item.parentKey}`;
    let ancestor = byId.get(parentId);
    const seen = new Set([identity(item)]);
    // Malformed cycles must neither hide tickets nor recurse forever.
    while (ancestor && !seen.has(identity(ancestor))) {
      seen.add(identity(ancestor));
      ancestor = ancestor.parentKey ? byId.get(`${ancestor.connectionId}\0${ancestor.parentKey}`) : undefined;
    }
    if (!ancestor && byId.has(parentId)) parentOf.set(identity(item), parentId);
  }
  const childrenOf = new Map<string, Candidate[]>();
  for (const item of all) {
    const parentId = parentOf.get(identity(item));
    if (parentId) childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), item]);
  }
  const needle = query.trim().toLowerCase();
  const visible = new Set(all.filter(item => `${item.key} ${item.title}`.toLowerCase().includes(needle)).map(identity));
  // Keep the parent context when a search matches a sub-ticket.
  for (const id of [...visible]) {
    let parentId = parentOf.get(id);
    while (parentId) { visible.add(parentId); parentId = parentOf.get(parentId); }
  }
  const renderTicket = (candidate: Candidate, isChild = false, isLast = false): ReactNode => {
    const id = identity(candidate);
    const children = (childrenOf.get(id) ?? []).filter(child => visible.has(identity(child)));
    const open = needle ? !collapsedSearch.has(id) : expanded.has(id);
    const parent = byId.get(parentOf.get(id) ?? '');
    const queued = used(candidate);
    const unavailable = candidate.finished || (!candidate.container && queued);
    return <li key={id} className="schedule-ticket-family">
      <button type="button" className={`issue-card schedule-ticket-card${children.length ? ' issue-card-parent issue-card-has-stack' : ''}${isChild ? ' issue-card-child' : ''}${isChild && isLast && !children.length ? ' issue-card-child-last' : ''}${unavailable ? ' is-used' : ''}`}
        data-testid="schedule-hopper-card" data-issue={candidate.key} data-child-of={isChild ? candidate.parentKey : undefined}
        disabled={unavailable} data-draggable={!!onTicketDrop && !unavailable} draggable={false} aria-label={candidate.finished ? `${candidate.key} is completed` : queued ? `${candidate.key} is on the belt` : `Drag ${candidate.key} to the run, or press Enter to add`}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (!event.repeat && !unavailable) onAdd(candidate);
        }}
        onPointerDown={event => {
          if (!onTicketDrop || unavailable || event.button !== 0 || !event.isPrimary) return;
          pointerDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = pointerDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
          drag.moved = true;
          setDragPreview({ title: candidate.title, x: event.clientX, y: event.clientY });
          onTicketDrag?.({ x: event.clientX, y: event.clientY });
        }}
        onPointerUp={event => {
          const drag = pointerDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          pointerDrag.current = undefined;
          setDragPreview(undefined);
          onTicketDrag?.(null);
          if (drag.moved) onTicketDrop?.(candidate, { x: event.clientX, y: event.clientY });
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { pointerDrag.current = undefined; setDragPreview(undefined); onTicketDrag?.(null); }}>
        <span className="schedule-ticket-heading">
          <span className="issue-card-title" title={candidate.title}>{candidate.title}</span>
          <span className="issue-card-context" title={parent ? `${candidate.issueType} in ${parent.title}` : candidate.issueType}>{candidate.issueType}</span>
        </span>
        <span className="issue-card-foot"><Icon className="issue-card-key-icon" name="check-square" size={13} /><span className="issue-card-key">{candidate.key}</span><span className="spacer" /><span className="schedule-ticket-status">{queued ? 'on belt' : candidate.status}</span></span>
      </button>
      {children.length > 0 && <>
        <button type="button" className={`board-child-stack schedule-ticket-stack${open ? ' board-child-stack-expanded' : ''}`} data-testid="schedule-ticket-stack" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${children.length} linked tickets under ${candidate.key}`} onClick={() => { const toggle = needle ? setCollapsedSearch : setExpanded; toggle(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }}>
          <span className="board-child-stack-layer board-child-stack-layer-2" aria-hidden="true" /><span className="board-child-stack-layer board-child-stack-layer-1" aria-hidden="true" />
          <span className="board-child-stack-notch board-child-stack-notch-left" aria-hidden="true" /><span className="board-child-stack-notch board-child-stack-notch-right" aria-hidden="true" />
          <span className="board-child-stack-face"><span className="board-child-stack-badge" aria-hidden="true"><Icon name="git-branch" size={11} /></span><span className="board-child-stack-label">{children.length} linked {children.length === 1 ? 'ticket' : 'tickets'}</span><Icon className="board-child-stack-chevron" name="chevron-right" size={12} /></span>
        </button>
        {open && <ul className="schedule-ticket-children">{children.map((child, index) => renderTicket(child, true, index === children.length - 1))}</ul>}
      </>}
    </li>;
  };
  return <section className="schedule-hopper" aria-label="Project tickets" data-testid="schedule-hopper">
    {dragPreview && createPortal(<div className="schedule-ticket-drag-preview" style={{ left: dragPreview.x + 12, top: dragPreview.y + 12 }} aria-hidden="true">{dragPreview.title}</div>, document.body)}
    <label className="easymode-search-bar"><Icon name="search" size={13} /><input className="easymode-search-bar__input" aria-label="Filter tickets" placeholder="Filter tickets" value={query} onChange={event => { setQuery(event.target.value); setCollapsedSearch(new Set()); }} /></label>
    {candidates === undefined && !loadError && <p className="schedule-hint">Loading tickets…</p>}
    {loadError && <p className="schedule-hint schedule-hint--bad" role="alert">{loadError}</p>}
    {candidates && !visible.size && <p className="schedule-hint">No tickets match.</p>}
    <ul className="schedule-hopper-list">{all.filter(item => visible.has(identity(item)) && !parentOf.has(identity(item))).map(item => renderTicket(item))}</ul>
  </section>;
}
