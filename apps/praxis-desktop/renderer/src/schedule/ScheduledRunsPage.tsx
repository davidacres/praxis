import { createPortal } from 'react-dom';
import { useResizable } from '../app/useResizable';
import { RECENCY_BUCKETS, RECENCY_BUCKET_LABEL, recencyBucket } from '../app/sessionRecency';
import { ScheduleTickets, useScheduleTickets } from './ScheduleTickets';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord, ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { ScheduleComposer } from './ScheduleComposer';
import { ScheduleRunMonitor } from './ScheduleRunMonitor';
import { ScheduleRunReport } from './ScheduleRunReport';
import { STATUS_LABEL, condenseIssues, formatStart, groupScheduledRuns, type ScheduledRunGroups } from './scheduleFormat';
import { LineupDetails, LineupNeeds, LineupWeek, isFinished, lineupWhen, LineupBeads, type Need } from './ScheduleLineup';
import { confirmProjectWorkflowTrust } from '../workflows/workflowProjectTrust';

type LineupTab = 'all' | 'active' | 'drafts' | 'finished';
import './schedule.css';

/**
 * The Scheduled runs lineup (FX-BF-047 / FX-BE-147 / TASK-462), as an agenda: a week
 * of bars from each run's start to its likely finish, what needs a person with the
 * fix beside it, and one row per schedule — its beads in run order, its start and
 * the one action that matters now — that opens to its tickets, facts and actions.
 * Rows are grouped by what needs a person: running, up next, needs attention,
 * drafts, finished. The runner in the main process starts a schedule at its time
 * (only while Praxis is open); a running or paused card opens the live view, a
 * finished one opens its report.
 */
interface ScheduledRunsPageProps {
  project: ProjectRecord;
  sidebarHost: HTMLElement | null;
  onBack: () => void;
  initialTicketKeys?: string[];
  onOpenWorkflowRun?: (workflowRunId: string) => void;
  /** Opens one stage's agent session (from the run report). */
  onOpenSession?: (sessionKey: string) => void;
}

const GROUPS: Array<{ key: keyof ScheduledRunGroups; title: string }> = [
  { key: 'running', title: 'Running now' },
  { key: 'upNext', title: 'Up next' },
  { key: 'attention', title: 'Needs attention' },
  { key: 'drafts', title: 'Drafts' },
  { key: 'finished', title: 'Finished' }
];

export function ScheduledRunsPage({ project, sidebarHost, onBack, initialTicketKeys = [], onOpenWorkflowRun, onOpenSession }: ScheduledRunsPageProps) {
  const { confirm } = useDialogs();
  const ticketPanel = useResizable({
    storageKey: 'tm-pane-schedule-tickets',
    initial: 320,
    min: 140,
    max: 640,
    side: 'bottom'
  });
  const [ticketHost, setTicketHost] = useState<HTMLDivElement | null>(null);
  const [ticketsCollapsed, setTicketsCollapsed] = useState(false);
  const [ticketsMaximized, setTicketsMaximized] = useState(false);
  const toggleTickets = () => {
    if (ticketsMaximized) {
      setTicketsMaximized(false);
      setTicketsCollapsed(true);
    } else setTicketsCollapsed(value => !value);
  };
  const [composerVersion, setComposerVersion] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [detailRunId, setDetailRunId] = useState<string>();
  /** A running schedule whose report the user opened ("Report so far"); the monitor is the default. */
  const [reportFor, setReportFor] = useState<string>();
  /** Rows the user opened or shut; unset rows are open unless the run has finished. */
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<LineupTab>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { candidates, loadError } = useScheduleTickets(project);
  const [views, setViews] = useState<ScheduledRunView[]>();
  const [error, setError] = useState('');
  const [startingRunId, setStartingRunId] = useState<string>();
  const [composing, setComposing] = useState<{ view?: ScheduledRunView; ticketKeys?: string[]; autoAdd?: boolean }>();
  const [ticketHandoffDismissed, setTicketHandoffDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const loadRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const all = await window.praxis.scheduledRuns.list();
      if (request !== loadRequest.current) return;
      setViews(all.filter(view => view.run.projectId === project.id));
      setError('');
    } catch (reason) {
      if (request !== loadRequest.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    const unsubscribe = window.praxis.scheduledRuns.onChanged(() => void load());
    return () => { ++loadRequest.current; unsubscribe(); };
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => groupScheduledRuns(views ?? []), [views]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const remove = async (view: ScheduledRunView) => {
    const ok = await confirm({
      title: 'Delete this scheduled run?',
      message: `"${view.run.name}" will be removed. The tickets themselves are not touched.`,
      confirmLabel: 'Delete schedule',
      danger: true
    });
    if (ok) await act(async () => { await window.praxis.scheduledRuns.remove(view.run.id); setSelectedRunId(undefined); });
  };

  const runNow = async (id: string) => {
    setStartingRunId(id);
    await act(async () => {
      await window.praxis.scheduledRuns.startNow(id);
      await load();
      setDetailRunId(id);
    });
    setStartingRunId(undefined);
  };

  const sidebar = sidebarHost && createPortal(
    <nav className="easymode-sidebar schedule-sidebar" aria-label="Scheduled runs and project tickets" data-testid="schedule-sidebar">
      <header className="horizon-bar schedule-sidebar-header" hidden={ticketsMaximized}>
        <div className="horizon-row-main">
        <button type="button" className="easymode-btn-add" aria-label="Back to project" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
        <span className="workspace-title-wrap"><span>Scheduled runs</span></span>
        <button type="button" className="btn-new-session-compact" data-testid="schedule-new" onClick={() => { setSelectedRunId(undefined); setComposerVersion(version => version + 1); setComposing({}); }}><Icon name="plus" size={13} /> <span>New</span></button>
        </div>
      </header>
      <div className="schedule-sidebar-runs" hidden={ticketsMaximized}>
        <button type="button" className={`easymode-automation-row schedule-nav-row${!selectedRunId && !composing ? ' is-selected' : ''}`} aria-current={!selectedRunId && !composing ? 'page' : undefined} onClick={() => { setSelectedRunId(undefined); setComposing(undefined); }}><Icon name="clock" size={14} className="easymode-automation-row__type-icon" /><span className="easymode-automation-row__title">All scheduled runs</span></button>
        {RECENCY_BUCKETS.map(bucket => {
          const runs = (views ?? []).filter(view => recencyBucket(view.run.updatedAt, new Date(now)) === bucket).sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
          if (!runs.length) return null;
          return <section className="easymode-section" key={bucket} data-testid={`schedule-bucket-${bucket}`}>
            <button type="button" className="easymode-section-header schedule-bucket-title" aria-expanded={!collapsed[bucket]} onClick={() => setCollapsed(current => ({ ...current, [bucket]: !current[bucket] }))}>
              <span className="easymode-section-header__title-group"><Icon name={collapsed[bucket] ? 'chevron-right' : 'chevron-down'} size={12} /><span className="easymode-section-header__title">{RECENCY_BUCKET_LABEL[bucket]}</span><span className="easymode-section-header__count">{runs.length}</span></span>
            </button>
            {!collapsed[bucket] && runs.map(view => <button key={view.run.id} type="button" className={`easymode-automation-row schedule-nav-row${selectedRunId === view.run.id ? ' is-selected' : ''}`} data-testid="schedule-nav-run" aria-current={selectedRunId === view.run.id ? 'page' : undefined} onClick={() => { setSelectedRunId(view.run.id); setComposing(undefined); }}>
              <Icon name="clock" size={14} className="easymode-automation-row__type-icon" /><span className="easymode-automation-row__details"><span className="easymode-automation-row__title" title={view.run.name}>{view.run.name}</span><span className="easymode-automation-row__sub-row"><span className="easymode-automation-row__project">{STATUS_LABEL[view.run.status]} · {view.run.entries.length} ticket{view.run.entries.length === 1 ? '' : 's'}</span></span></span>
            </button>)}
          </section>;
        })}
        {views?.length === 0 && <p className="easymode-empty-hint">No scheduled runs yet</p>}
      </div>
      {!ticketsCollapsed && !ticketsMaximized && <div
        className={`splitter-h${ticketPanel.dragging ? ' dragging' : ''}`}
        aria-label="Resize project tickets section"
        {...ticketPanel.handleProps}
      />}
      <div className={`schedule-sidebar-tickets${ticketsCollapsed ? ' is-collapsed' : ''}${ticketsMaximized ? ' is-maximized' : ''}`} style={ticketsCollapsed || ticketsMaximized ? undefined : { height: ticketPanel.size }}>
        <div className="feature-section-header feature-section-toggle">
          <button type="button" className="feature-section-title" aria-expanded={!ticketsCollapsed} onClick={toggleTickets}>
            <span className="sidebar-section-label">Project tickets</span>
            <span className="easymode-section-header__count">{candidates?.filter(candidate => !candidate.finished).length ?? 0}</span>
          </button>
          <div className="feature-section-actions">
            <button type="button" className="feature-section-action" aria-label={ticketsMaximized ? 'Restore sidebar' : 'Use full sidebar'} title={ticketsMaximized ? 'Restore sidebar' : 'Use full sidebar'} onClick={() => {
              if (ticketsMaximized) setTicketsMaximized(false);
              else { setTicketsCollapsed(false); setTicketsMaximized(true); }
            }}><Icon name={ticketsMaximized ? 'window-restore' : 'window-maximize'} size={13} /></button>
            <button type="button" className="feature-section-action" aria-label={ticketsCollapsed ? 'Expand project tickets section' : 'Collapse project tickets section'} title={ticketsCollapsed ? 'Expand project tickets section' : 'Collapse project tickets section'} onClick={toggleTickets}>
              <span className={`tree-section-icon${ticketsCollapsed ? '' : ' open'}`}><Icon name={ticketsCollapsed ? 'chevron-right' : 'chevron-down'} size={14} /></span>
            </button>
          </div>
        </div>
        <div className="schedule-sidebar-ticket-content" hidden={ticketsCollapsed} ref={setTicketHost}>
        {!composing && <ScheduleTickets candidates={candidates} loadError={loadError} onAdd={candidate => {
          const selected = views?.find(view => view.run.id === selectedRunId);
          setComposing({ view: selected && ['draft', 'scheduled'].includes(selected.run.status) ? selected : undefined, ticketKeys: [candidate.key] });
        }} />}
        </div>
      </div>
    </nav>, sidebarHost);


  if (composing) {
    return (<>{sidebar}
      <ScheduleComposer
        key={`${composing.view?.run.id ?? 'new'}:${composerVersion}`}
        project={project}
        ticketHost={ticketHost}
        candidates={candidates}
        loadError={loadError}
        initial={composing.view}
        initialTicketKeys={composing.ticketKeys}
        autoAddSelectedTickets={composing.autoAdd}
        onClose={() => setComposing(undefined)}
        onSaved={startedRunId => {
          setComposing(undefined);
          if (startedRunId) setDetailRunId(startedRunId);
          setTicketHandoffDismissed(true);
          void load();
        }}
      />
    </>);
  }

  const detail = detailRunId ? views?.find(view => view.run.id === detailRunId) : undefined;
  if (detail) {
    const live = detail.run.status === 'running' || detail.run.status === 'paused';
    return (<>{sidebar}{live && reportFor !== detail.run.id
      ? <ScheduleRunMonitor view={detail} onBack={() => setDetailRunId(undefined)} onOpenWorkflowRun={onOpenWorkflowRun} onShowReport={() => setReportFor(detail.run.id)} />
      : <ScheduleRunReport view={detail} live={live} onBack={() => live ? setReportFor(undefined) : setDetailRunId(undefined)} onOpenWorkflowRun={onOpenWorkflowRun} onOpenSession={onOpenSession} />}</>);
  }

  const total = views?.length ?? 0;
  const inTab = (view: ScheduledRunView) =>
    tab === 'all' ||
    (tab === 'active' && ['running', 'paused', 'scheduled', 'missed'].includes(view.run.status)) ||
    (tab === 'drafts' && view.run.status === 'draft') ||
    (tab === 'finished' && isFinished(view));
  const tabs: Array<{ id: LineupTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'drafts', label: 'Drafts' },
    { id: 'finished', label: 'Finished' }
  ];
  const countFor = (id: LineupTab) => (views ?? []).filter(view => id === 'all' || (id === 'active' ? ['running', 'paused', 'scheduled', 'missed'].includes(view.run.status) : id === 'drafts' ? view.run.status === 'draft' : isFinished(view))).length;
  const reveal = (id: string) => {
    setOpenRows(current => ({ ...current, [id]: true }));
    setTab('all');
    window.requestAnimationFrame(() => document.querySelector(`[data-testid="schedule-card"][data-run-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const trust = (view: ScheduledRunView) => act(async () => {
    if (!view.run.projectId || !view.run.policy.workflowId) return;
    await confirmProjectWorkflowTrust(view.run.projectId, view.run.policy.workflowId, confirm);
    await load();
  });
  const needs: Need[] = (views ?? []).flatMap(view => {
    const { run, readiness } = view;
    if (run.status === 'missed') {
      return [{ id: run.id, tone: 'bad' as const, title: run.name, text: `It was due ${formatStart(run.scheduledStartAt, run.timezone)} while Praxis was closed. Start it now or skip it.`, fixes: [
        { label: 'Skip', testId: 'schedule-need-skip', run: () => void act(() => window.praxis.scheduledRuns.resolveMissed(run.id, 'skip')) },
        { label: 'Start now', primary: true, testId: 'schedule-need-start-now', run: () => void act(() => window.praxis.scheduledRuns.resolveMissed(run.id, 'start-now')) }
      ] }];
    }
    if (run.status === 'paused' || run.status === 'failed') {
      return [{ id: run.id, tone: run.status === 'failed' ? 'bad' as const : 'warn' as const, title: run.name, text: run.pause?.message ?? (run.status === 'failed' ? 'The run failed.' : 'The run is paused.'), fixes: [
        { label: run.status === 'failed' ? 'View report' : 'Open live view', primary: true, testId: 'schedule-need-open', run: () => setDetailRunId(run.id) }
      ] }];
    }
    if (run.status !== 'draft' && run.status !== 'scheduled') return [];
    const shown = readiness.issues.filter(issue => issue.severity === 'blocker' || run.status === 'scheduled');
    if (shown.length === 0) return [];
    const fixes: Need['fixes'] = [];
    if (shown.some(issue => issue.code === 'workflow-untrusted')) fixes.push({ label: 'Review and trust', testId: 'schedule-need-trust', run: () => void trust(view) });
    fixes.push({ label: shown.some(issue => issue.code === 'start-in-past') ? 'Pick a new time' : 'Edit', primary: true, testId: 'schedule-need-edit', run: () => { setSelectedRunId(run.id); setComposing({ view }); } });
    return [{ id: run.id, tone: shown.some(issue => issue.severity === 'blocker') ? 'bad' as const : 'warn' as const, title: run.name, text: condenseIssues(shown).map(issue => issue.message).join(' '), fixes }];
  });

  return (
    <>{sidebar}<div className="view-scroll schedule-page lineup" data-testid="scheduled-runs-page">
      <header className="lineup-head">
        <div className="lineup-head-main">
          <h2 className="schedule-title">Scheduled runs</h2>
          <p className="schedule-sub" data-testid="schedule-runtime-note">
            A schedule starts at its time while Praxis is open, runs its tickets in order, and pauses to ask you at an approval gate, a failure, or when a provider is nearly out of allowance.
          </p>
        </div>
        {total > 0 && (
          <div className="lineup-tabs" role="tablist" aria-label="Show">
            {tabs.map(item => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`lineup-tab${tab === item.id ? ' is-on' : ''}`} data-testid={`schedule-tab-${item.id}`} onClick={() => setTab(item.id)}>
                {item.label} <span>{countFor(item.id)}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn btn-primary" data-testid="schedule-lineup-new" onClick={() => setComposing({})}><Icon name="plus" size={13} /> New scheduled run</button>
      </header>

      {initialTicketKeys.length > 0 && !ticketHandoffDismissed && <section className="schedule-group" aria-label="Add selected tickets">
        <h3 className="schedule-group-title">Add {initialTicketKeys.length} selected ticket{initialTicketKeys.length === 1 ? '' : 's'}</h3>
        <button type="button" className="btn btn-primary" onClick={() => setComposing({ ticketKeys: initialTicketKeys, autoAdd: true })}>Create new schedule</button>
        {(views ?? []).filter(view => view.run.status === 'draft' || view.run.status === 'scheduled').map(view => <button key={view.run.id} type="button" className="btn" onClick={() => setComposing({ view, ticketKeys: initialTicketKeys, autoAdd: true })}>Add to “{view.run.name}”</button>)}
      </section>}

      {error && <div className="schedule-error" role="alert" data-testid="schedule-error">{error}</div>}

      {views === undefined && !error && <div className="schedule-empty">Loading schedules…</div>}

      {views !== undefined && total === 0 && (
        <div className="schedule-empty" data-testid="schedule-empty">
          <Icon name="clock" size={28} />
          <strong>No scheduled runs yet</strong>
          <p>Pick several tickets, put them in order, and choose a start time.</p>
          <button type="button" className="btn" onClick={() => setComposing({})}>Create a scheduled run</button>
        </div>
      )}

      {views !== undefined && total > 0 && <LineupWeek views={views} now={now} onPick={reveal} />}
      {views !== undefined && !selectedRunId && <LineupNeeds needs={needs} />}

      {GROUPS.map(({ key, title }) => {
        const shown = groups[key].filter(view => (!selectedRunId || view.run.id === selectedRunId) && inTab(view));
        return shown.length === 0 ? null : (
          <section key={key} className="schedule-group lineup-group" aria-label={title} data-testid={`schedule-group-${key}`}>
            <h3 className="schedule-group-title">{title}<span className="schedule-group-count">{shown.length}</span></h3>
            {shown.map(view => (
              <RunCard
                key={view.run.id}
                view={view}
                now={now}
                expanded={openRows[view.run.id] ?? !isFinished(view)}
                onToggle={() => setOpenRows(current => ({ ...current, [view.run.id]: !(current[view.run.id] ?? !isFinished(view)) }))}
                onEdit={() => { setSelectedRunId(view.run.id); setComposing({ view }); }}
                onOpen={() => setDetailRunId(view.run.id)}
                onDelete={() => void remove(view)}
                onArm={armed => void act(() => window.praxis.scheduledRuns.setArmed(view.run.id, armed))}
                onRunNow={() => void runNow(view.run.id)}
                starting={startingRunId === view.run.id}
                onResolve={resolution => void act(() => window.praxis.scheduledRuns.resolveMissed(view.run.id, resolution))}
              />
            ))}
          </section>
        );
      })}
    </div></>
  );
}

/**
 * One schedule as a row: its status, name, beads and start, with the one action that
 * matters now. Opened, it lists its tickets by step, its facts and every other action.
 * Every action keeps one test id per card, so a row is driven the same open or shut.
 */
function RunCard({
  view,
  now,
  expanded,
  onToggle,
  onEdit,
  onOpen,
  onDelete,
  onArm,
  onRunNow,
  starting,
  onResolve
}: {
  view: ScheduledRunView;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onArm: (armed: boolean) => void;
  onRunNow: () => void;
  starting: boolean;
  onResolve: (resolution: 'start-now' | 'skip') => void;
}) {
  const { run, readiness } = view;
  const editable = run.status === 'draft' || run.status === 'scheduled';
  const blockers = readiness.issues.filter(issue => issue.severity === 'blocker');
  const canArm = readiness.ready && run.entries.length > 0;
  const startBlocker = blockers.find(issue => issue.code !== 'start-in-past');
  const canRunNow = run.entries.length > 0 && !startBlocker;
  const when = lineupWhen(view, now);
  const live = run.status === 'running' || run.status === 'paused';

  const runNow = <button type="button" className={`btn${run.status === 'scheduled' ? '' : ' btn-primary'}`} data-testid="schedule-run-now" disabled={starting || !canRunNow} title={canRunNow ? 'Start this run immediately' : startBlocker?.message ?? 'Add a ticket first'} onClick={onRunNow}>{starting ? 'Starting…' : 'Run now'}</button>;
  const arm = <button type="button" className="btn btn-primary" data-testid="schedule-arm" disabled={!canArm} title={canArm ? 'Schedule this run' : blockers[0]?.message ?? 'Add a ticket first'} onClick={() => onArm(true)}>Schedule run</button>;
  const open = <button type="button" className="btn btn-primary" data-testid="schedule-open" onClick={onOpen}>{live ? 'Open live view' : 'View report'}</button>;
  const startNow = <button type="button" className="btn btn-primary" data-testid="schedule-start-now" onClick={() => onResolve('start-now')}>Start now</button>;
  // The one action that matters now sits on the row; the rest are inside it.
  const primary = run.status === 'missed' ? startNow : run.status === 'draft' ? (canArm ? arm : runNow) : run.status === 'scheduled' ? runNow : open;

  return (
    <article className={`schedule-card lineup-row${expanded ? ' is-open' : ''}`} data-testid="schedule-card" data-status={run.status} data-run-id={run.id}>
      <div className="lineup-row-head">
        <RunRing view={view} now={now} />
        <button type="button" className="lineup-row-name" aria-expanded={expanded} aria-label={`${run.name}, ${expanded ? 'hide' : 'show'} details`} onClick={onToggle}>
          <h4 className="schedule-card-name" data-testid="schedule-card-name">{run.name}</h4>
          <span className="schedule-card-meta">
            <span className={`spot-pill spot-pill--${run.status}`}><span className={`schedule-status schedule-status--${run.status}`} data-testid="schedule-status">{STATUS_LABEL[run.status]}</span></span>
            <span>{run.policy.mode === 'parallel' ? `up to ${run.policy.maxConcurrency} at once` : 'one at a time'} · once</span>
          </span>
        </button>
        <LineupBeads view={view} />
        <div className="lineup-when">
          <strong data-testid="schedule-start">{when.main}</strong>
          <span className={run.status === 'missed' || (run.status === 'draft' && when.sub === 'start has passed') ? 'is-bad' : run.status === 'scheduled' ? 'schedule-countdown' : undefined}>{when.sub}</span>
        </div>
        <div className="lineup-row-actions">
          {primary}
          <button type="button" className="btn btn-icon lineup-chevron" aria-label={expanded ? `Hide details of ${run.name}` : `Show details of ${run.name}`} aria-expanded={expanded} onClick={onToggle}>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="lineup-row-body">
          <LineupDetails view={view} editable={editable} />
          <div className="schedule-actions lineup-actions">
            {run.status === 'draft' && primary !== runNow && runNow}
            {run.status === 'draft' && primary !== arm && arm}
            {run.status === 'missed' && <button type="button" className="btn" data-testid="schedule-skip" onClick={() => onResolve('skip')}>Skip</button>}
            {run.status === 'scheduled' && <button type="button" className="btn" data-testid="schedule-hold" onClick={() => onArm(false)}>Put on hold</button>}
            {editable && <button type="button" className="btn" data-testid="schedule-edit" onClick={onEdit}>Edit</button>}
            <button type="button" className="btn btn-icon" data-testid="schedule-delete" aria-label={`Delete ${run.name}`} onClick={onDelete}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/** A status ring: a countdown arc for a scheduled run, a glyph for every other state. */
function RunRing({ view, now }: { view: ScheduledRunView; now: number }) {
  const { run } = view;
  const total = run.entries.length;
  const done = run.entries.filter(entry => entry.outcome?.status === 'done').length;
  const C = 2 * Math.PI * 24;
  // A scheduled run's arc fills as its start approaches over the final day.
  const lead = Math.max(0, Math.min(1, 1 - (Date.parse(run.scheduledStartAt) - now) / 86_400_000));
  const fraction = run.status === 'scheduled' ? lead : run.status === 'running' || run.status === 'paused' ? (total ? done / total : 0) : run.status === 'completed' ? 1 : 0;
  return (
    <svg className={`schedule-ring schedule-ring--${run.status}`} viewBox="-30 -30 60 60" role="img" aria-label={STATUS_LABEL[run.status]}>
      <circle r="24" className="schedule-ring-track" />
      <circle r="24" className="schedule-ring-arc" strokeDasharray={`${C * fraction} ${C}`} transform="rotate(-90)" />
      {run.status === 'scheduled' && <path className="schedule-ring-glyph" d="M0 -10V0L7 4" />}
      {run.status === 'draft' && <path className="schedule-ring-glyph" d="M-8 6L-5 -2L4 -11L8 -7L-1 2Z" />}
      {run.status === 'missed' && <path className="schedule-ring-glyph" d="M-8 -8L8 8M8 -8L-8 8" />}
      {run.status === 'failed' && <path className="schedule-ring-glyph" d="M-8 -8L8 8M8 -8L-8 8" />}
      {run.status === 'paused' && <path className="schedule-ring-glyph" d="M-5 -8V8M5 -8V8" />}
      {run.status === 'completed' && <path className="schedule-ring-glyph" d="M-9 0L-3 7L9 -8" />}
      {run.status === 'cancelled' && <path className="schedule-ring-glyph" d="M-7 0H7" />}
      {run.status === 'running' && <text y="4" textAnchor="middle" className="schedule-ring-text">{done}/{total}</text>}
    </svg>
  );
}
