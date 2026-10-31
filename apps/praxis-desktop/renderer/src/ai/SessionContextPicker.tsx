import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionRecord, IssueSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { sessionTitle } from './sessionNav';

import type { SessionContextReference } from './sessionContext';
const excerpt = (text: string) => text.length > 12000 ? `${text.slice(0, 12000)}\n[Excerpt truncated]` : text;

export function SessionContextPicker({ session, sessions, references, onChange, disabled, folderDisabled }: {
  session: AgentSessionRecord; sessions: AgentSessionRecord[]; references: SessionContextReference[];
  onChange: (references: SessionContextReference[]) => void; disabled: boolean; folderDisabled: boolean;
}) {
  const [view, setView] = useState<'menu' | 'session' | 'ticket'>();
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<Array<{ value: string; label: string }>>([]);
  const [source, setSource] = useState(session.connectionId ?? (session.projectId ? `project:${session.projectId}` : ''));
  const [tickets, setTickets] = useState<IssueSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!view) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) {
        const height = menu.current?.offsetHeight ?? 250;
        const preferred = rect.top - height - 6 >= 8 ? rect.top - height - 6 : rect.bottom + 6;
        setPosition({ top: Math.max(8, Math.min(preferred, innerHeight - height - 8)), left: Math.max(8, Math.min(rect.left, innerWidth - 348)) });
      }
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    if (view === 'menu') menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)
        || (event.target as Element).closest?.('.chip-select-menu')) return;
      setView(undefined);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setView(undefined); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [view]);
  useEffect(() => {
    if (view !== 'ticket') return;
    let cancelled = false;
    setLoading(true); setError('');
    void Promise.all([window.praxis.projects.list(), window.praxis.connection.list()]).then(([projects, connections]) => {
      if (cancelled) return;
      const options = [...projects.map(project => ({ value: `project:${project.id}`, label: project.name })),
        ...connections.map(connection => ({ value: connection.id, label: connection.name }))];
      setSources(options);
      setSource(current => options.some(option => option.value === current) ? current : options[0]?.value ?? '');
    }).catch(cause => { if (!cancelled) setError(String(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view]);
  useEffect(() => {
    if (view !== 'ticket' || !source) return;
    let cancelled = false;
    setTickets([]); setLoading(true);
    const timer = window.setTimeout(() => {
      void window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: query, assigneeMode: 'all', grouping: 'none' }, 0, 30, source)
        .then(page => { if (!cancelled) setTickets(page.issues); })
        .catch(cause => { if (!cancelled) setError(String(cause)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [view, source, query]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); setView(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const add = (reference: SessionContextReference) => alive.current && onChange([...references.filter(item => item.id !== reference.id), reference]);
  const changeFolder = () => void run(async () => {
    const folder = await window.praxis.dialog.pickFolder('Choose working folder for this session');
    if (folder) await window.praxis.ai.updateSessionToolAccess(session.issueKey, { workingDirectory: folder,
      toolMode: session.toolMode === 'project-only' ? 'read-only' : session.toolMode });
  });
  return <>
    <button type="button" ref={trigger} className="icon-btn session-context-add" aria-label="Add context" aria-haspopup="dialog" aria-expanded={Boolean(view)}
      data-testid="session-add-context" disabled={disabled} onClick={() => { setError(''); setQuery(''); setView(current => current ? undefined : 'menu'); }}><Icon name="plus" size={16} /></button>
    {view && createPortal(<div ref={menu} className="composer-provider-menu session-context-picker" role="dialog" aria-label="Add context" style={{ position: 'fixed', ...position }}>
      <div className="session-context-picker-heading"><strong>{view === 'menu' ? 'Add context' : view === 'session' ? 'Add a session' : 'Add a ticket'}</strong><button type="button" className="icon-btn" aria-label="Close context menu" onClick={() => setView(undefined)}><Icon name="close" size={13} /></button></div>
      {view === 'menu' ? <>
        <button type="button" className="composer-provider-option" data-testid="context-folder" disabled={folderDisabled || busy} onClick={changeFolder}><Icon name="folder" size={15} /><span>{session.workingDirectory ? 'Change working folder' : 'Add working folder'}<small>Sets where this session works</small></span></button>
        <button type="button" className="composer-provider-option" data-testid="context-session" disabled={busy || references.length >= 5} onClick={() => setView('session')}><Icon name="chats" size={15} /><span>Another session<small>Attach its goal and latest response</small></span></button>
        <button type="button" className="composer-provider-option" data-testid="context-ticket" disabled={busy || references.length >= 5} onClick={() => setView('ticket')}><Icon name="ticket" size={15} /><span>A ticket<small>Attach its description and status</small></span></button>
      </> : <>
        <button type="button" className="btn btn-quiet" onClick={() => { setQuery(''); setView('menu'); }}>Back</button>
        {view === 'ticket' && <ChipSelect block ariaLabel="Ticket source" value={source} options={sources} onChange={value => { setError(''); setSource(value); }} />}
        <input className="input" aria-label={view === 'session' ? 'Find session context' : 'Find ticket context'} placeholder="Search…" value={query} onChange={event => { setError(''); setQuery(event.target.value); }} autoFocus />
        <div className="session-context-picker-results">
          {view === 'session' ? sessions.filter(candidate => candidate.issueKey !== session.issueKey && !candidate.parentSessionKey && sessionTitle(candidate).toLowerCase().includes(query.toLowerCase())).slice(0, 30).map(candidate =>
            <button key={candidate.issueKey} type="button" className="composer-provider-option" disabled={busy} onClick={() => void run(async () => {
              const full = await window.praxis.ai.getSession(candidate.issueKey);
              if (!full) throw new Error('That session is no longer available.');
              const last = [...(full.events ?? [])].reverse().find(event => event.type === 'message');
              add({ id: `session:${full.issueKey}`, kind: 'session', label: sessionTitle(full), capturedAt: new Date().toISOString(),
                content: excerpt(JSON.stringify({ key: full.issueKey, goal: full.taskDefinition.goal, state: full.state, latestResponse: full.responseText || last?.detail || last?.summary || '' })) });
            })}>{sessionTitle(candidate)}</button>) : loading ? <p role="status">Loading tickets…</p> : tickets.map(ticket =>
            <button key={ticket.key} type="button" className="composer-provider-option" disabled={busy} onClick={() => void run(async () => {
              const details = await window.praxis.issue.get(ticket.key, source);
              add({ id: `ticket:${source}:${ticket.key}`, kind: 'ticket', label: `${ticket.key} · ${ticket.summary}`, capturedAt: new Date().toISOString(),
                content: excerpt(JSON.stringify({ key: details.key, summary: details.summary, status: details.status, description: details.description })) });
            })}>{ticket.key} · {ticket.summary}</button>)}
          {view === 'ticket' && !loading && !tickets.length && <p>No tickets found in this source.</p>}
          {view === 'session' && !sessions.some(candidate => candidate.issueKey !== session.issueKey && !candidate.parentSessionKey && sessionTitle(candidate).toLowerCase().includes(query.toLowerCase())) && <p>No matching sessions.</p>}
        </div>
      </>}
      {busy && <p role="status">Adding context…</p>}{error && <p role="alert" className="error-text">{error}</p>}
    </div>, document.body)}
  </>;
}
