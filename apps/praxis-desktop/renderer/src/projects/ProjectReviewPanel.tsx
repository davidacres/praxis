import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, IssueSummary, ProjectActivityEntry, ProjectActivitySnapshot, ProjectRecord, WorkflowTransition } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { sessionTitle } from '../ai/sessionNav';
import { sessionStatusLabel } from '../ai/aiSessionState';
import { ChipSelect } from '../ui/ChipSelect';
import { sessionLastActivityAt } from '../app/sessionRecency';

type ReviewIssue = IssueSummary & { connectionId: string };
type ReviewItem = { issue: ReviewIssue; blocked: boolean; inactive: boolean; ageDays?: number };

const SESSION_PREVIEW_LIMIT = 5;
const DAY = 86_400_000;
/** Unfinished work with no recorded activity for this long is surfaced. Measured from the latest of updated, created and observed change. No backend records a due date, so this aging threshold is the "overdue" rule. */
const AGING_CHOICES = [3, 7, 14, 30] as const;
const DEFAULT_AGING_DAYS = 7;
const WINDOWS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY } as const;
const reviewedKey = (projectId: string) => `praxis-daily-review:${projectId}`;
const agingKey = (projectId: string) => `praxis-daily-review-aging:${projectId}`;
/** A note saved with this prefix is a blocker reason; the latest one is shown on the blocked item. */
const BLOCKER_PREFIX = 'Blocked: ';
const SOURCE_LABELS: Record<ProjectActivityEntry['kind'], string> = { issue: 'Item', session: 'Agent session', plan: 'Plan file', commit: 'Commit' };

function readAging(projectId: string): number {
  const saved = Number(localStorage.getItem(agingKey(projectId)));
  return (AGING_CHOICES as readonly number[]).includes(saved) ? saved : DEFAULT_AGING_DAYS;
}

function actorLabel(entry: ProjectActivityEntry): string {
  const actor = entry.actor ?? 'you';
  if (actor === 'you') return 'You';
  if (actor === 'agent') return 'Agent';
  return entry.actorName || (entry.kind === 'plan' ? 'Outside Praxis' : 'Someone else');
}
const itemKey = (issue: ReviewIssue) => `${issue.connectionId}:${issue.key}`;

/** "Done reviewing" holds for the rest of the local day, unless an item appears that was not in that review. */
function readReviewed(projectId: string): { day: string; keys: string[] } | undefined {
  try { return JSON.parse(localStorage.getItem(reviewedKey(projectId)) ?? 'null') ?? undefined; } catch { return undefined; }
}

/** Within a day group, how long ago; the group heading already carries the date. */
function relativeTime(time: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(time: number): string {
  const today = new Date(Date.now()).toDateString();
  const yesterday = new Date(Date.now() - DAY).toDateString();
  const day = new Date(time).toDateString();
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : new Date(time).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

interface ProjectReviewPanelProps {
  project: ProjectRecord;
  sessions: AgentSessionRecord[];
  onOpenIssue: (issue: IssueSummary, connectionId: string) => void;
  onOpenSession: (issueKey: string) => void;
  onOpenSessions: () => void;
  onOpenBoard?: () => void;
  /** Opens a plan file by its project-relative path. */
  onOpenPlanFile?: (relativePath: string) => void;
  onOpenCommit?: (hash: string) => void;
  /** A request from outside the panel (the title bar) to show one view; `at` makes a repeat request re-apply. */
  request?: { view: 'review' | 'changes'; at: number };
}

export function ProjectReviewPanel({ project, sessions, onOpenIssue, onOpenSession, onOpenSessions, onOpenBoard, onOpenPlanFile, onOpenCommit, request }: ProjectReviewPanelProps) {
  const [view, setView] = useState<'review' | 'changes'>(request?.view ?? 'review');
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!request) return;
    setView(request.view);
    sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [request?.view, request?.at]);
  const [agingDays, setAgingDays] = useState(() => readAging(project.id));
  const [history, setHistory] = useState<ProjectActivitySnapshot>();
  const [issues, setIssues] = useState<ReviewIssue[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [reviewed, setReviewed] = useState(() => readReviewed(project.id));
  const [showReviewed, setShowReviewed] = useState(false);
  const [windowId, setWindowId] = useState<keyof typeof WINDOWS>('7d');
  const [source, setSource] = useState<'all' | ProjectActivityEntry['kind']>('all');
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      const all: ReviewIssue[] = [];
      const sources = [{ connectionId: `project:${project.id}`, boardId: undefined as string | undefined }, ...project.linkedBoards];
      for (const source of sources) {
        let startAt = 0;
        while (true) {
          const page = await window.praxis.issue.list({ projectKeys: [], boardId: source.boardId, statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, startAt, 100, source.connectionId);
          for (const issue of page.issues) {
            if (!all.some(candidate => candidate.connectionId === source.connectionId && candidate.key === issue.key)) all.push({ ...issue, connectionId: source.connectionId });
          }
          startAt += page.issues.length;
          if (!page.issues.length || (page.total !== undefined ? startAt >= page.total : page.issues.length < 100)) break;
        }
      }
      const snapshot = await window.praxis.activity.list(project.id);
      if (!cancelled) { setIssues(all); setHistory(snapshot); }
    })().catch(reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project.id, project.key, JSON.stringify(project.linkedBoards), revision]);

  const unfinished = issues.filter(issue => {
    const stage = project.workflowStages.find(candidate => candidate.name.toLowerCase() === issue.status.toLowerCase());
    if (stage) return stage.category !== 'done';
    if (issue.statusCategory) return !['done', 'completed'].includes(issue.statusCategory.toLowerCase());
    return project.workflowStages.length > 0 || !/^(done|closed|resolved|complete|completed)$/i.test(issue.status);
  });
  // Blocked needs no date; inactive does — an undated item is never guessed stale.
  const items: ReviewItem[] = unfinished.map(issue => {
    const observed = history?.entries.find(entry => entry.kind === 'issue' && entry.targetKey === issue.key && entry.connectionId === issue.connectionId)?.timestamp;
    const lastActivity = Math.max(...[issue.updated, issue.created, observed].map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite));
    const ageDays = Number.isFinite(lastActivity) ? Math.floor((Date.now() - lastActivity) / DAY) : undefined;
    return { issue, blocked: /\bblocked\b/i.test(issue.status), inactive: ageDays !== undefined && ageDays >= agingDays, ageDays };
  }).filter(item => item.blocked || item.inactive)
    .sort((a, b) => Number(b.blocked) - Number(a.blocked) || (b.ageDays ?? -1) - (a.ageDays ?? -1));
  const today = new Date(Date.now()).toDateString();
  const reviewedToday = reviewed?.day === today && items.every(item => reviewed.keys.includes(itemKey(item.issue)));
  const finishReview = () => {
    const marker = { day: today, keys: items.map(item => itemKey(item.issue)) };
    try { localStorage.setItem(reviewedKey(project.id), JSON.stringify(marker)); } catch { /* private mode */ }
    setReviewed(marker);
    setShowReviewed(false);
  };
  const pendingSessions = sessions.filter(session => session.projectId === project.id && !['completed', 'aborted'].includes(session.state))
    .sort((a, b) => sessionLastActivityAt(b).localeCompare(sessionLastActivityAt(a)));
  const recentSessions = pendingSessions.slice(0, SESSION_PREVIEW_LIMIT);
  // Hundreds of entries are routine (a busy week of commits); group once per input change, not per render.
  const days = useMemo(() => (history?.entries ?? [])
    .filter(entry => (source === 'all' || entry.kind === source) && Date.parse(entry.timestamp) >= Date.now() - WINDOWS[windowId])
    .reduce<{ label: string; entries: ProjectActivityEntry[] }[]>((groups, entry) => {
      const label = dayLabel(Date.parse(entry.timestamp));
      const last = groups[groups.length - 1];
      if (last?.label === label) last.entries.push(entry); else groups.push({ label, entries: [entry] });
      return groups;
    }, []), [history, source, windowId]);
  const issueIndex = useMemo(() => new Map(issues.map(issue => [`${issue.connectionId}:${issue.key}`, issue])), [issues]);
  const openButton = (entry: ProjectActivityEntry) => {
    if (entry.kind === 'session') return <button className="btn" disabled={!sessions.some(session => session.projectId === project.id && session.issueKey === entry.targetKey)} onClick={() => onOpenSession(entry.targetKey)}>Open session</button>;
    if (entry.kind === 'plan') return <button className="btn" disabled={!onOpenPlanFile || entry.action === 'Plan file removed' || /^([a-z]:)?[\\/]/i.test(entry.targetKey)} onClick={() => onOpenPlanFile?.(entry.targetKey)}>Open file</button>;
    if (entry.kind === 'commit') return <button className="btn" disabled={!onOpenCommit} onClick={() => onOpenCommit?.(entry.targetKey)}>Open commit</button>;
    const issue = issueIndex.get(`${entry.connectionId}:${entry.targetKey}`);
    return <button className="btn" disabled={!issue} onClick={() => { if (issue) onOpenIssue(issue, issue.connectionId); }}>Open item</button>;
  };
  return <section className={`project-review-panel${view === 'changes' ? ' outcome-ledger' : ''}`} aria-label="Project review" data-testid="project-review-panel" ref={sectionRef}>
    <header className="project-review-heading"><h2>{view === 'changes' ? 'What changed' : 'Project review'}</h2><button className="btn btn-quiet" onClick={() => setRevision(value => value + 1)}>Refresh review</button></header>
    <div className="project-review-tabs" aria-label="Review views">
      <button className="btn" aria-pressed={view === 'review'} onClick={() => setView('review')}>Daily Review</button>
      <button className="btn" aria-pressed={view === 'changes'} onClick={() => setView('changes')}>What Changed</button>
    </div>
    {loading && !history ? <p role="status">Loading project review…</p> : error ? <p role="alert" className="error-text">Could not load review: {error}</p> : view === 'review' ? <>
      <div className="project-review-filters">
        <p>{items.filter(item => item.blocked).length} blocked · {items.filter(item => item.inactive).length} inactive for at least {agingDays} days · {pendingSessions.length} unfinished sessions</p>
        <ChipSelect ariaLabel="Flag items inactive for" data-testid="project-review-aging" value={String(agingDays)} onChange={value => { const days = Number(value); setAgingDays(days); try { localStorage.setItem(agingKey(project.id), String(days)); } catch { /* private mode */ } }} options={AGING_CHOICES.map(days => ({ value: String(days), label: `Flag after ${days} days` }))} />
      </div>
      <h3>Work to revisit</h3>
      {items.length === 0
        ? <p className="project-review-empty">Nothing overdue or blocked. Items without dates are not flagged as inactive.{onOpenBoard && <> <button className="btn btn-quiet" onClick={onOpenBoard}>Open board</button></>}</p>
        : reviewedToday && !showReviewed
          ? <p className="project-review-empty" data-testid="project-review-reviewed">Reviewed today — nothing new since. <button className="btn btn-quiet" onClick={() => setShowReviewed(true)}>Show {items.length} {items.length === 1 ? 'item' : 'items'}</button></p>
          : <>
            <ul className="project-review-list">{items.map(item => <ReviewItemRow key={itemKey(item.issue)} item={item} revision={revision} onOpen={() => onOpenIssue(item.issue, item.issue.connectionId)} onChanged={() => setRevision(value => value + 1)} />)}</ul>
            <div className="project-review-footer"><button className="btn" onClick={finishReview}>Done reviewing</button></div>
          </>}
      <h3>Unfinished sessions</h3>
      {pendingSessions.length === 0 ? <p>No unfinished sessions in this project.</p> : <ul className="project-review-list" data-testid="project-review-sessions">{recentSessions.map(session => <li key={session.sessionId}><span><strong>{session.title || session.issueKey}</strong><small>{session.state.replaceAll('_', ' ')}</small></span><button className="btn" onClick={() => onOpenSession(session.issueKey)}>Open session</button></li>)}</ul>}
      {pendingSessions.length > SESSION_PREVIEW_LIMIT && <p className="project-review-footer">
        Showing the {SESSION_PREVIEW_LIMIT} most recently active of {pendingSessions.length} unfinished sessions.{' '}
        <button className="btn btn-quiet" onClick={onOpenSessions}>View all sessions</button>
      </p>}
    </> : <div className="outcome-ledger__layout"><div className="outcome-ledger__feed">
      <p className="outcome-ledger__intro">Item and session changes recorded by Praxis from {history ? new Date(history.startedAt).toLocaleString() : 'now'}, plan files edited outside Praxis, and the last 30 days of commits in this project's repository.</p>
      <div className="project-review-filters">
        <ChipSelect ariaLabel="Change source" data-testid="project-review-source" value={source} onChange={value => setSource(value as typeof source)} options={[{ value: 'all', label: 'All sources' }, { value: 'issue', label: 'Items' }, { value: 'plan', label: 'Plan files' }, { value: 'session', label: 'Agent sessions' }, { value: 'commit', label: 'Git commits' }]} />
        <ChipSelect ariaLabel="Time window" data-testid="project-review-window" value={windowId} onChange={value => setWindowId(value as typeof windowId)} options={[{ value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }]} />
      </div>
      {!days.length ? <p className="project-review-empty">No recorded changes in this window. Changes to items, plan files, sessions and commits will appear here.{(history?.entries.length ?? 0) > 0 && windowId !== '30d' && <> <button className="btn btn-quiet" onClick={() => setWindowId('30d')}>Show last 30 days</button></>}</p>
        : days.map(group => <div key={group.label} className="project-review-day"><h3>{group.label}</h3><ul className="project-review-list">{group.entries.map(entry => <li key={entry.id} data-testid="project-review-change" data-kind={entry.kind} data-actor={entry.actor ?? 'you'}><time className="outcome-ledger__time" dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time><Icon name={entry.kind === 'commit' ? 'git-branch' : entry.kind === 'session' ? 'chats' : entry.kind === 'plan' ? 'file' : 'check-square'} size={17} /><span className="outcome-ledger__entry"><strong>{entry.action} · {entry.summary}</strong><small><span className={`project-review-actor project-review-actor--${entry.actor ?? 'you'}`}>{actorLabel(entry)}</span> <span className="project-review-source">{SOURCE_LABELS[entry.kind]}</span> {entry.kind === 'commit' ? entry.targetKey.slice(0, 7) : entry.targetKey} · <time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>{relativeTime(Date.parse(entry.timestamp))}</time></small></span>{openButton(entry)}</li>)}</ul></div>)}
    </div><aside className="outcome-ledger__context" aria-label="Activity context">
      <section><h3>Still unresolved <span>{items.length + pendingSessions.length}</span></h3>
        {items.length === 0 && pendingSessions.length === 0 && <p>No blocked, inactive or unfinished work recorded.</p>}
        {items.slice(0, 3).map(item => <article key={itemKey(item.issue)}><small>{item.issue.key} · {item.blocked ? 'Blocked' : 'Inactive'}</small><strong>{item.issue.summary}</strong><button className="btn" onClick={() => onOpenIssue(item.issue, item.issue.connectionId)}>Review item</button></article>)}
        {recentSessions.slice(0, 3).map(session => <article key={session.issueKey}><small>{sessionStatusLabel(session)}</small><strong>{sessionTitle(session)}</strong><button className="btn" onClick={() => onOpenSession(session.issueKey)}>Open session</button></article>)}
        {(items.length > 3 || pendingSessions.length > 3) && <button className="btn btn-quiet" onClick={() => setView('review')}>View all unresolved work</button>}
      </section>
      <section><h3>Resume context</h3><dl><dt>Project</dt><dd>{project.name}</dd>{project.purpose && <><dt>Purpose</dt><dd>{project.purpose}</dd></>}</dl>
        {(() => { const latest = [...sessions].filter(session => session.projectId === project.id && !session.parentSessionKey).sort((a, b) => sessionLastActivityAt(b).localeCompare(sessionLastActivityAt(a)))[0];
          return latest ? <article><small>Last active session · {sessionStatusLabel(latest)}</small><strong>{sessionTitle(latest)}</strong><p>{latest.taskDefinition?.goal}</p><button className="btn btn-primary" onClick={() => onOpenSession(latest.issueKey)}>Resume session</button></article> : <p>No sessions recorded for this project yet.</p>; })()}
      </section>
    </aside></div>}
  </section>;
}

/** Moves and notes go through the board's own transition and comment calls, so the board's workflow rules and refusals apply unchanged. */
function ReviewItemRow({ item, revision, onOpen, onChanged }: { item: ReviewItem; revision: number; onOpen: () => void; onChanged: () => void }) {
  const { issue } = item;
  const [transitions, setTransitions] = useState<WorkflowTransition[]>([]);
  const [blocker, setBlocker] = useState<string>();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void window.praxis.issue.get(issue.key, issue.connectionId).then(details => {
      if (cancelled) return;
      setTransitions(details.transitions ?? []);
      const reason = [...(details.comments ?? [])].reverse().find(comment => comment.body.trim().toLowerCase().startsWith(BLOCKER_PREFIX.toLowerCase()));
      setBlocker(reason?.body.trim().slice(BLOCKER_PREFIX.length).trim() || undefined);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [issue.key, issue.connectionId, issue.status, revision]);
  // A blocked item's note is its blocker reason: that is what the next reviewer needs to see.
  const noteIsBlocker = item.blocked;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); onChanged(); return true; } catch (cause) {
      // The board's own refusal is the message; Electron's IPC wrapper is not.
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return false;
    } finally { setBusy(false); }
  };
  const age = item.ageDays !== undefined ? `${item.ageDays} ${item.ageDays === 1 ? 'day' : 'days'} since last activity` : 'No activity date recorded';
  const move = (transitionId: string) => {
    const target = transitions.find(transition => transition.id === transitionId);
    void run(() => window.praxis.issue.transition(issue.key, transitionId, issue.connectionId)).then(ok => {
      // Moving something into a blocked stage is exactly when its reason is known; ask for it there.
      if (ok && /\bblocked\b/i.test(target?.toStatus ?? target?.name ?? '')) setNoteOpen(true);
    });
  };
  return <li className="project-review-item" data-testid="project-review-item">
    <span><strong>{issue.key} · {issue.summary}</strong>
      <small>{item.blocked && <span className="project-review-reason" data-testid="project-review-reason">Blocked</span>}{item.inactive && <span className="project-review-reason" data-testid="project-review-reason">Aging</span>} Stage: {issue.status} · {age}</small>
      {item.blocked && <small data-testid="project-review-blocker">{blocker ? <>Blocker: {blocker}</> : 'No blocker reason recorded'}</small>}
      {noteOpen && <form className="project-review-note" onSubmit={event => { event.preventDefault(); if (note.trim()) void run(() => window.praxis.issue.addComment(issue.key, `${noteIsBlocker ? BLOCKER_PREFIX : ''}${note.trim()}`, issue.connectionId)).then(ok => { if (ok) { setNote(''); setNoteOpen(false); } }); }}>
        <input className="input" aria-label={noteIsBlocker ? `Blocker reason for ${issue.key}` : `Note for ${issue.key}`} value={note} disabled={busy} autoFocus onChange={event => setNote(event.target.value)} placeholder={noteIsBlocker ? 'Why is it blocked?' : 'Add a short note'} />
        <button className="btn" type="submit" disabled={busy || !note.trim()}>Save note</button>
      </form>}
      {error && <small role="alert" className="error-text">{error}</small>}
    </span>
    <span className="project-review-actions">
      <ChipSelect ariaLabel={`Move ${issue.key}`} data-testid="project-review-move" placeholder="Move to…" value="" disabled={busy || !transitions.length} options={transitions.map(transition => ({ value: transition.id, label: transition.toStatus ?? transition.name }))} onChange={move} />
      <button className="btn" disabled={busy} aria-expanded={noteOpen} onClick={() => setNoteOpen(open => !open)}>{item.blocked ? 'Add reason' : 'Add note'}</button>
      <button className="btn" onClick={onOpen}>Open item</button>
    </span>
  </li>;
}
