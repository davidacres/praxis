import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, ProjectRecord, ScheduledRunView, WorkflowRunSummary } from '@praxis/core';
import type { CommandEntry } from './CommandPalette';
import { useAssistant } from '../assistant/AssistantProvider';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { attentionItems, matchingExcerpt, pendingDecisionQuestions, type AttentionItem } from './workHubModel';
import './workHub.css';

type SearchDocument = { id: string; title: string; body: string; kind: string; projectId?: string; open?: () => void };
export interface WorkHubProps {
  mode: 'attention' | 'search';
  projects: ProjectRecord[];
  sessions: AgentSessionRecord[];
  searchIssues: (query: string, projectId?: string, onPartial?: (message: string) => void) => Promise<CommandEntry[]>;
  onOpenSession: (key: string) => void;
  onOpenRun: (projectId: string, runId: string) => void;
  onOpenSchedule: (projectId?: string, scheduleId?: string) => void;
  onClose: () => void;
}

export function WorkHub({ mode: initialMode, projects, sessions, searchIssues, onOpenSession, onOpenRun, onOpenSchedule, onClose }: WorkHubProps) {
  const [mode, setMode] = useState(initialMode);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<SearchDocument[]>([]);
  const [issues, setIssues] = useState<CommandEntry[]>([]);
  const [schedules, setSchedules] = useState<ScheduledRunView[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [boardWarnings, setBoardWarnings] = useState<string[]>([]);
  const [attentionWarnings, setAttentionWarnings] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, string[]>>({});
  const [decisionWarnings, setDecisionWarnings] = useState<string[]>([]);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [searchingIssues, setSearchingIssues] = useState(false);
  const [selected, setSelected] = useState<SearchDocument>();
  const [reload, setReload] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const assistant = useAssistant();
  const projectIds = projects.map(project => project.id).join('\0');
  const ids = useMemo(() => new Set(projects.map(project => project.id)), [projectIds]);
  const scopedSessions = sessions.filter(session => !session.archived && (!session.projectId || ids.has(session.projectId)));
  const sessionIds = scopedSessions.map(session => session.sessionId).join('\0');
  const searchIssuesRef = useRef(searchIssues);
  searchIssuesRef.current = searchIssues;
  const attentionBase = attentionItems(scopedSessions, runs, schedules);
  const attention = [...attentionBase, ...scopedSessions.flatMap(session => {
    const questions = decisions[session.sessionId];
    if (!questions?.length || attentionBase.some(item => item.kind === 'session' && item.target === session.issueKey)) return [];
    return [{ id: `decision:${session.issueKey}`, kind: 'session' as const, target: session.issueKey, projectId: session.projectId,
      title: session.title || session.taskDefinition.goal || session.issueKey, reason: questions.join('\n'), action: 'Answer question' }];
  })].filter(item => !projectId || item.projectId === projectId);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { requestAnimationFrame(() => {
      const opener = document.querySelector<HTMLElement>(`[data-testid="titlebar-${initialMode === 'search' ? 'search-work' : 'attention'}"]`);
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else opener?.focus();
    }); };
  }, []);

  useEffect(() => {
    let stopped = false;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      setAttentionLoading(true);
      const results = await Promise.allSettled([
        window.praxis.scheduledRuns.list(),
        ...projects.map(project => window.praxis.workflows.listRuns(project.id))
      ]);
      if (stopped || current !== generation) return;
      const scheduleResult = results[0] as PromiseSettledResult<ScheduledRunView[]>;
      if (scheduleResult.status === 'fulfilled') setSchedules(scheduleResult.value.filter(value => !value.run.projectId || ids.has(value.run.projectId)));
      const workflowResults = results.slice(1) as PromiseSettledResult<WorkflowRunSummary[]>[];
      setRuns(workflowResults.flatMap(result => result.status === 'fulfilled' ? result.value : []));
      setAttentionWarnings(results.some(result => result.status === 'rejected') ? ['Some runs could not be loaded. This view is incomplete; refresh to retry.'] : []);
      setAttentionLoading(false);
    };
    const offSchedules = window.praxis.scheduledRuns.onChanged(() => void load());
    const offRuns = window.praxis.workflows.onRunChanged(() => void load());
    void load();
    return () => { stopped = true; offSchedules(); offRuns(); };
  }, [projectIds, reload]);

  useEffect(() => {
    if (selected) root.current?.querySelector<HTMLButtonElement>('.work-hub-preview button')?.focus();
  }, [selected]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  useEffect(() => {
    let stopped = false;
    const generations = new Map<string, number>();
    const load = async (sessionId: string) => {
      const generation = (generations.get(sessionId) ?? 0) + 1;
      generations.set(sessionId, generation);
      try {
        const blocks = await window.praxis.gadgets.getBlocks(sessionId);
        if (!stopped && generations.get(sessionId) === generation) setDecisions(previous => ({ ...previous, [sessionId]: pendingDecisionQuestions(blocks) }));
      } catch { if (!stopped) setDecisionWarnings(['Some agent decisions could not be loaded. Refresh to retry.']); }
    };
    setDecisionWarnings([]);
    const queue = scopedSessions.map(session => session.sessionId);
    const off = window.praxis.gadgets.onChanged(sessionId => { if (queue.includes(sessionId) || scopedSessions.some(session => session.sessionId === sessionId)) void load(sessionId); });
    const worker = async () => { while (!stopped && queue.length) await load(queue.shift()!); };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => { stopped = true; off(); };
  }, [sessionIds, reload]);

  // Content is fetched only when searching. Four workers avoid flooding the host with transcript reads.
  useEffect(() => {
    if (mode !== 'search') return;
    let stopped = false;
    setLoading(true);
    setSelected(undefined);
    setWarnings([]);
    setDocuments([]);
    const found: SearchDocument[] = [];
    const failures: string[] = [];
    const jobs: Array<() => Promise<void>> = [];
    for (const summary of scopedSessions) jobs.push(async () => {
      const session = summary.eventsLoaded === false ? await window.praxis.ai.getSession(summary.issueKey) : summary;
      if (!session) return;
      const body = [session.taskDefinition.goal, session.responseText, ...session.events.filter(event => ['message', 'user_input_completed'].includes(event.type)).map(event => event.detail || event.summary), ...Object.values(session.handoverBrief ?? {}).filter(value => typeof value === 'string')].filter(Boolean).join('\n\n');
      found.push({ id: `session:${session.issueKey}`, title: session.title || session.issueKey, body, kind: 'Conversations and sessions', projectId: session.projectId, open: () => onOpenSession(session.issueKey) });
    });
    for (const project of projects) jobs.push(async () => {
      const result = await window.praxis.notes.list(project.id);
      if (!result.ok) throw new Error(`${project.name}: notes unavailable`);
      result.value.notes.forEach(note => found.push({ id: `note:${note.id}`, title: note.title, body: note.body, kind: 'Notes', projectId: project.id }));
    });
    for (const id of ['', ...projects.map(project => project.id)]) jobs.push(async () => {
      const chats = await window.praxis.assistant.listChats(id);
      for (const chat of chats.filter(chat => !chat.archived)) {
        const record = await window.praxis.assistant.getChat(chat.id);
        if (record) found.push({ id: `chat:${chat.id}`, title: chat.title, body: record.messages.map(message => message.text).join('\n\n'), kind: 'Team conversations', projectId: id || undefined,
          open: () => { assistant.setProjectId(id); void assistant.loadChat(chat.id); } });
      }
    });
    const worker = async () => {
      while (!stopped && jobs.length) {
        try { await jobs.shift()!(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      }
    };
    void Promise.all(Array.from({ length: 4 }, worker)).then(() => {
      if (!stopped) { setDocuments(found); setWarnings(failures.length ? [`${failures.length} content sources could not be read. Results are incomplete.`] : []); setLoading(false); }
    });
    return () => { stopped = true; };
  }, [mode, projectIds, reload]);

  useEffect(() => {
    if (mode !== 'search' || query.trim().length < 2) { setBoardWarnings([]); setIssues([]); setSearchingIssues(false); return; }
    let stopped = false;
    setIssues([]);
    setBoardWarnings([]);
    setSearchingIssues(true);
    const timer = setTimeout(() => void searchIssuesRef.current(query.trim(), projectId || undefined, message => { if (!stopped) setBoardWarnings(previous => [...previous, message]); }).then(values => { if (!stopped) setIssues(values); })
      .catch(() => { if (!stopped) setBoardWarnings(['Board search could not complete.']); })
      .finally(() => { if (!stopped) setSearchingIssues(false); }), 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [mode, query, projectId]);

  const runDocuments: SearchDocument[] = runs.filter(run => !run.archived).map(run => ({ id: `run:${run.runId}`, title: run.workflowName, projectId: run.projectId, kind: 'Run results',
    body: [run.explanation, ...run.stages.map(stage => `${stage.name}: ${stage.lane}\n${stage.lastError || ''}\n${stage.artifacts.map(artifact => artifact.path || artifact.contractId).join('\n')}`), ...run.events.map(event => event.message)].join('\n'), open: () => onOpenRun(run.projectId, run.runId) }));
  const matches = query.trim().length < 2 ? [] : [...documents, ...runDocuments]
    .filter(item => (!projectId || item.projectId === projectId) && matchingExcerpt(`${item.title}\n${item.body}`, query) !== undefined);
  const openAttention = (item: AttentionItem) => {
    onClose();
    if (item.kind === 'session') onOpenSession(item.target);
    else if (item.kind === 'workflow' && item.projectId) onOpenRun(item.projectId, item.target);
    else onOpenSchedule(item.projectId, item.target);
  };
  const focusMatch = () => requestAnimationFrame(() => root.current?.querySelector('mark')?.scrollIntoView({ block: 'center' }));
  const highlight = (body: string) => {
    const index = body.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
    if (index < 0) return body;
    return <>{body.slice(0, index)}<mark>{body.slice(index, index + query.trim().length)}</mark>{body.slice(index + query.trim().length)}</>;
  };
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={root} className="modal-card work-hub" role="dialog" aria-modal="true" aria-label="Your work" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"], summary') ?? [])].filter(element => element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2>Your work</h2><button className="icon-btn" aria-label="Close your work" onClick={onClose}><Icon name="close" /></button></header>
      <div className="work-hub-toolbar">
        <button className={`btn${mode === 'attention' ? ' btn-primary' : ''}`} aria-pressed={mode === 'attention'} onClick={() => { setMode('attention'); setSelected(undefined); }}>Needs your attention</button>
        <button className={`btn${mode === 'search' ? ' btn-primary' : ''}`} aria-pressed={mode === 'search'} onClick={() => setMode('search')}>Search your work</button>
        <ChipSelect ariaLabel="Filter by project" value={projectId} onChange={value => { setProjectId(value); setSelected(undefined); }} options={[{ value: '', label: 'All projects' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} />
        <button className="btn" onClick={() => setReload(value => value + 1)}>Refresh</button>
      </div>
      {[...warnings, ...boardWarnings, ...attentionWarnings, ...decisionWarnings].map(warning => <p className="hint is-danger" role="status" key={warning}>{warning}</p>)}
      {mode === 'attention' ? <div className="work-hub-results">
        <p>Review requests and recovery choices in their original context.</p>
        {attentionLoading && <p role="status">Loading runs…</p>}
        {!attentionLoading && attention.length === 0 && <p>No loaded items need your attention in this scope.</p>}
        {attention.map(item => <article key={item.id} className="work-hub-result"><div><small>{item.kind} · {projects.find(project => project.id === item.projectId)?.name || 'Unassigned'}</small><h3>{item.title}</h3><p>{item.reason}</p></div><button className="btn" onClick={() => openAttention(item)}>{item.action}</button></article>)}
      </div> : <>
        <input className="work-hub-query" aria-label="Search work content" placeholder="Search conversations, plans, tickets, notes and run results…" value={query} onChange={event => { setQuery(event.target.value); setSelected(undefined); }} />
        <p className="hint" role="status">{loading ? 'Loading conversation and note content… ' : ''}{searchingIssues ? 'Searching boards… ' : ''}Plans and tickets use board search; session and note content is searched locally. Content is a snapshot: refresh after new activity. Archived items are excluded.</p>
        {selected ? <section className="work-hub-preview"><button className="btn" onClick={() => setSelected(undefined)}>Back to results</button> <button className="btn" onClick={focusMatch}>Jump to match</button>{selected.open && <button className="btn btn-primary" onClick={() => { onClose(); selected.open?.(); }}>Open source</button>}<h3>{selected.title}</h3><pre>{highlight(selected.body)}</pre></section>
          : <div className="work-hub-results">
            {query.trim().length < 2 ? <p>Enter at least two characters to search.</p> : <>
              <p>{matches.length + issues.length} results{loading || searchingIssues ? ' so far' : ''}</p>
              {matches.map(item => <button className="work-hub-result" key={item.id} onClick={() => { setSelected(item); focusMatch(); }}><small>{item.kind} · {projects.find(project => project.id === item.projectId)?.name || 'Unassigned'}</small><strong>{item.title}</strong><span>{matchingExcerpt(item.body, query) || matchingExcerpt(item.title, query)}</span></button>)}
              {issues.map(issue => <button className="work-hub-result" key={issue.id} onClick={() => { onClose(); issue.run(); }}><small>Plans and tickets</small><strong>{issue.label}</strong><span>{issue.hint}</span></button>)}
            </>}
          </div>}
      </>}
    </div>
  </div>;
}
