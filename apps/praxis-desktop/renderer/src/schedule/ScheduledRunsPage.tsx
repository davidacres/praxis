import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectRecord, ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { ScheduleComposer } from './ScheduleComposer';
import { STATUS_LABEL, condenseIssues, describeCountdown, formatStart, groupScheduledRuns, type ScheduledRunGroups } from './scheduleFormat';
import './schedule.css';

/**
 * The Scheduled runs lineup (FX-BF-047 / FX-BE-147 / TASK-462).
 *
 * Each schedule is a card with its tickets drawn as a mini belt, in the order they
 * will run, grouped by what needs a person: running, up next, needs attention,
 * drafts, finished. This is a surface for *definitions* today — the runner that
 * starts them is FX-BE-148 — so the page says so plainly rather than letting a
 * saved schedule look like something that will fire.
 */
interface ScheduledRunsPageProps {
  project: ProjectRecord;
}

const GROUPS: Array<{ key: keyof ScheduledRunGroups; title: string }> = [
  { key: 'running', title: 'Running now' },
  { key: 'upNext', title: 'Up next' },
  { key: 'attention', title: 'Needs attention' },
  { key: 'drafts', title: 'Drafts' },
  { key: 'finished', title: 'Finished' }
];

export function ScheduledRunsPage({ project }: ScheduledRunsPageProps) {
  const { confirm } = useDialogs();
  const [views, setViews] = useState<ScheduledRunView[]>();
  const [error, setError] = useState('');
  const [composing, setComposing] = useState<{ view?: ScheduledRunView }>();
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const all = await window.praxis.scheduledRuns.list();
      setViews(all.filter(view => view.run.projectId === project.id));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    return window.praxis.scheduledRuns.onChanged(() => void load());
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
    if (ok) await act(() => window.praxis.scheduledRuns.remove(view.run.id));
  };

  if (composing) {
    return (
      <ScheduleComposer
        project={project}
        initial={composing.view}
        onClose={() => setComposing(undefined)}
        onSaved={() => {
          setComposing(undefined);
          void load();
        }}
      />
    );
  }

  const total = views?.length ?? 0;

  return (
    <div className="view-scroll schedule-page" data-testid="scheduled-runs-page">
      <header className="schedule-head">
        <div>
          <h2 className="schedule-title">Scheduled runs</h2>
          <p className="schedule-sub">Queue board tickets in a fixed order and set when to run them. One ticket at a time.</p>
        </div>
        <button type="button" className="btn btn-primary" data-testid="schedule-new" onClick={() => setComposing({})}>
          <Icon name="plus" size={13} /> New scheduled run
        </button>
      </header>

      <div className="schedule-notice" role="note" data-testid="schedule-preview-note">
        <Icon name="info" size={14} />
        <span>
          <strong>Preview.</strong> Schedules are saved and kept in order, but Praxis cannot start them yet. Start tickets from the board
          until the runner ships.
        </span>
      </div>

      {error && <div className="schedule-error" role="alert" data-testid="schedule-error">{error}</div>}

      {views !== undefined && total > 0 && (
        <div className="schedule-overview" data-testid="schedule-overview">
          <Tile label="Running" value={groups.running.length} tone="progress" />
          <Tile label="Scheduled" value={groups.upNext.length} tone="info" />
          <Tile label="Needs you" value={groups.attention.length} tone="bad" />
          <Tile label="Drafts" value={groups.drafts.length} />
          <WeekStrip views={views} now={now} />
        </div>
      )}

      {views === undefined && !error && <div className="schedule-empty">Loading schedules…</div>}

      {views !== undefined && total === 0 && (
        <div className="schedule-empty" data-testid="schedule-empty">
          <Icon name="clock" size={28} />
          <strong>No scheduled runs yet</strong>
          <p>Pick several tickets, put them in order, and choose a start time.</p>
          <button type="button" className="btn" onClick={() => setComposing({})}>Create a scheduled run</button>
        </div>
      )}

      {GROUPS.map(({ key, title }) =>
        groups[key].length === 0 ? null : (
          <section key={key} className="schedule-group" aria-label={title} data-testid={`schedule-group-${key}`}>
            <h3 className="schedule-group-title">{title}<span className="schedule-group-count">{groups[key].length}</span></h3>
            {groups[key].map(view => (
              <RunCard
                key={view.run.id}
                view={view}
                now={now}
                onEdit={() => setComposing({ view })}
                onDelete={() => void remove(view)}
                onArm={armed => void act(() => window.praxis.scheduledRuns.setArmed(view.run.id, armed))}
                onResolve={resolution => void act(() => window.praxis.scheduledRuns.resolveMissed(view.run.id, resolution))}
              />
            ))}
          </section>
        )
      )}
    </div>
  );
}

function RunCard({
  view,
  now,
  onEdit,
  onDelete,
  onArm,
  onResolve
}: {
  view: ScheduledRunView;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
  onArm: (armed: boolean) => void;
  onResolve: (resolution: 'start-now' | 'skip') => void;
}) {
  const { run, readiness } = view;
  const editable = run.status === 'draft' || run.status === 'scheduled';
  const blockers = readiness.issues.filter(issue => issue.severity === 'blocker');
  const canArm = readiness.ready && run.entries.length > 0;

  return (
    <article className="schedule-card" data-testid="schedule-card" data-status={run.status} data-run-id={run.id}>
      <div className="schedule-card-top">
        <RunRing view={view} now={now} />
        <div className="schedule-card-main">
          <h4 className="schedule-card-name" data-testid="schedule-card-name">{run.name}</h4>
          <div className="schedule-card-meta">
            <span className={`schedule-status schedule-status--${run.status}`} data-testid="schedule-status">{STATUS_LABEL[run.status]}</span>
            <span>Once · {run.timezone}</span>
          </div>
        </div>
        <div className="schedule-card-when">
          <strong data-testid="schedule-start">{formatStart(run.scheduledStartAt, run.timezone)}</strong>
          {run.status === 'scheduled' && <span className="schedule-countdown">{describeCountdown(run.scheduledStartAt, now)}</span>}
          {run.status === 'missed' && <span className="schedule-countdown schedule-countdown--bad">was due while Praxis was closed</span>}
        </div>
      </div>

      <ol className="schedule-mini-belt" aria-label="Run order" data-testid="schedule-mini-belt">
        {run.entries.map(entry => (
          <li key={entry.id} className={`schedule-chip schedule-chip--${entry.outcome?.status ?? 'queued'}`} data-issue={entry.ticket.issueKey}>
            <span className="schedule-chip-seq">{entry.sequence}</span>
            <span className="schedule-chip-text">
              <span className="schedule-chip-key">{entry.ticket.issueKey}</span>
              <span className="schedule-chip-title" title={entry.ticket.title}>{entry.ticket.title}</span>
            </span>
          </li>
        ))}
        {run.entries.length === 0 && <li className="schedule-chip schedule-chip--empty">No tickets yet</li>}
      </ol>

      {readiness.issues.length > 0 && editable && (
        <ul className="schedule-issues" data-testid="schedule-issues">
          {condenseIssues(readiness.issues).map((issue, index) => (
            <li key={`${issue.code}-${index}`} className={`schedule-issue schedule-issue--${issue.severity}`} data-code={issue.code}>
              <Icon name="warning" size={12} /> {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="schedule-actions">
        {run.status === 'missed' && (
          <>
            <button type="button" className="btn" data-testid="schedule-start-now" onClick={() => onResolve('start-now')}>Start now</button>
            <button type="button" className="btn" data-testid="schedule-skip" onClick={() => onResolve('skip')}>Skip</button>
          </>
        )}
        {run.status === 'draft' && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="schedule-arm"
            disabled={!canArm}
            title={canArm ? 'Schedule this run' : blockers[0]?.message ?? 'Add a ticket first'}
            onClick={() => onArm(true)}
          >
            Schedule run
          </button>
        )}
        {run.status === 'scheduled' && (
          <button type="button" className="btn" data-testid="schedule-hold" onClick={() => onArm(false)}>Put on hold</button>
        )}
        {editable && <button type="button" className="btn" data-testid="schedule-edit" onClick={onEdit}>Edit</button>}
        <button type="button" className="btn btn-icon" data-testid="schedule-delete" aria-label={`Delete ${run.name}`} onClick={onDelete}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </article>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'progress' | 'info' | 'bad' }) {
  return (
    <div className={`schedule-tile${tone ? ` schedule-tile--${tone}` : ''}`}>
      <span className="schedule-tile-label">{label}</span>
      <strong className="schedule-tile-value">{value}</strong>
    </div>
  );
}

/** The next seven days, a dot on each day that has a schedule starting. Dates are the viewer's own. */
function WeekStrip({ views, now }: { views: ScheduledRunView[]; now: number }) {
  const key = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const counts = new Map<string, number>();
  for (const view of views) {
    if (view.run.status !== 'scheduled' && view.run.status !== 'draft') continue;
    const day = key(new Date(view.run.scheduledStartAt));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setDate(date.getDate() + index);
    return { date, count: counts.get(key(date)) ?? 0 };
  });
  return (
    <div className="schedule-week" aria-label="Next 7 days">
      <span className="schedule-tile-label">Next 7 days</span>
      <div className="schedule-week-days">
        {days.map(({ date, count }, index) => (
          <span key={index} className={`schedule-week-day${index === 0 ? ' is-today' : ''}`} data-count={count}>
            {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)}
            <i className="schedule-week-dot" aria-label={count ? `${count} scheduled` : undefined} />
          </span>
        ))}
      </div>
    </div>
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
