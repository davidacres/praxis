import type { ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ENTRY_STATUS_LABEL, condenseIssues, describeCountdown, formatStart } from './scheduleFormat';
import { formatHourMinute, formatMoney, stepNumbers } from './spotlightFormat';

/**
 * The Scheduled runs lineup as an agenda (FX-BF-047, lineup redesign "1 · Agenda"):
 * a week of bars from each run's start to its likely finish, what needs a person
 * with the fix beside it, and one row per schedule that opens to its tickets,
 * facts and actions. Presentation only; every action is the page's.
 */

const DAY_MS = 86_400_000;
const FINISHED = new Set(['completed', 'cancelled', 'failed']);

export function isFinished(view: ScheduledRunView): boolean {
  return FINISHED.has(view.run.status);
}

/** When a run starts (or started) and is likely to finish, for its bar. */
function span(view: ScheduledRunView): { start: number; end: number; estimated: boolean } {
  const { run } = view;
  const attempt = run.attempts[run.attempts.length - 1];
  const start = (run.status === 'running' || run.status === 'paused') && attempt ? Date.parse(attempt.startedAt) : Date.parse(run.scheduledStartAt);
  const likely = view.forecast?.likelyFinishAt ? Date.parse(view.forecast.likelyFinishAt) : undefined;
  return { start, end: likely && likely > start ? likely : start + 45 * 60_000, estimated: !likely };
}

interface WeekProps {
  views: ScheduledRunView[];
  now: number;
  onPick: (id: string) => void;
}

/** The next seven days, from midnight today: one bar per run that starts or runs in them. */
export function LineupWeek({ views, now, onPick }: WeekProps) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const from = today.getTime();
  const to = from + 7 * DAY_MS;
  const days = Array.from({ length: 7 }, (_, index) => new Date(from + index * DAY_MS));
  const x = (time: number) => Math.max(0, Math.min(100, ((time - from) / (to - from)) * 100));
  const shown = views
    .filter(view => !isFinished(view) && view.run.status !== 'missed')
    .map(view => ({ view, ...span(view) }))
    .filter(item => item.end > from && item.start < to)
    .sort((a, b) => a.start - b.start);
  return (
    <section className="lineup-week" aria-label="Next 7 days" data-testid="schedule-week">
      <div className="lineup-week-head">
        <span className="lineup-label">Next 7 days</span>
        <span className="lineup-hint">{shown.length ? 'bars run from the start to the likely finish' : 'Nothing is scheduled this week.'}</span>
      </div>
      <div className="lineup-days" style={{ height: `${Math.max(64, 50 + shown.length * 28)}px` }}>
        {days.map((day, index) => (
          <div key={index} className={`lineup-day${index === 0 ? ' is-today' : ''}`}>
            <b>{index === 0 ? 'Today' : new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</b>
            {new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(day)}
          </div>
        ))}
        {shown.map((item, index) => {
          const left = x(item.start);
          // Wide enough to read its name, even before there is a forecast to size it.
          const width = Math.max(9, x(item.end) - left);
          return (
            <button
              key={item.view.run.id}
              type="button"
              className={`lineup-bar lineup-bar--${item.view.run.status}`}
              style={{ left: `${Math.min(left, 100 - width)}%`, width: `${width}%`, top: `${46 + index * 28}px` }}
              data-testid="schedule-week-bar"
              data-run-id={item.view.run.id}
              title={`${item.view.run.name} · ${formatStart(new Date(item.start).toISOString(), item.view.run.timezone)}${item.estimated ? '' : ` → likely done ${formatHourMinute(new Date(item.end).toISOString(), item.view.run.timezone)}`}`}
              onClick={() => onPick(item.view.run.id)}
            >
              {item.view.run.name}
            </button>
          );
        })}
        <span className="lineup-now" style={{ left: `${x(now)}%` }} aria-hidden="true"><span>now</span></span>
      </div>
    </section>
  );
}

export interface Need {
  id: string;
  tone: 'bad' | 'warn';
  title: string;
  text: string;
  fixes: Array<{ label: string; primary?: boolean; testId: string; run: () => void }>;
}

/** What needs a person, each with the fix beside it. */
export function LineupNeeds({ needs }: { needs: Need[] }) {
  if (needs.length === 0) return null;
  return (
    <section className="lineup-needs" aria-label="Needs you" data-testid="schedule-needs">
      <span className="lineup-label">Needs you · {needs.length}</span>
      {needs.map(need => (
        <div key={need.id} className={`lineup-need lineup-need--${need.tone}`} data-run-id={need.id}>
          <span className="lineup-need-glyph" aria-hidden="true">!</span>
          <div className="lineup-need-text"><strong>{need.title}</strong><span>{need.text}</span></div>
          <div className="lineup-need-fixes">
            {need.fixes.map(fix => (
              <button key={fix.label} type="button" className={`btn${fix.primary ? ' btn-primary' : ''}`} data-testid={fix.testId} onClick={fix.run}>{fix.label}</button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const BEAD_STATE: Record<string, string> = { done: 'done', running: 'running', paused: 'waiting', failed: 'failed', skipped: 'skipped', queued: 'queued' };

/** One line of the row: the beads (a step gap between steps) and what they add up to. */
export function LineupBeads({ view }: { view: ScheduledRunView }) {
  const { run } = view;
  const steps = stepNumbers(run.entries);
  const status = (index: number) => run.entries[index].outcome?.status ?? 'queued';
  const done = run.entries.filter(entry => entry.outcome?.status === 'done').length;
  const skipped = run.entries.filter(entry => entry.outcome?.status === 'skipped').length;
  const flying = run.entries.filter(entry => ['running', 'paused'].includes(entry.outcome?.status ?? '')).length;
  const stepCount = new Set(steps.values()).size;
  const summary = run.status === 'running' || run.status === 'paused'
    ? `${done} of ${run.entries.length} done${flying ? ` · ${flying} in flight` : ''}`
    : isFinished(view)
      ? `${done} of ${run.entries.length} delivered${skipped ? ` · ${skipped} skipped` : ''}`
      : `${run.entries.length} ticket${run.entries.length === 1 ? '' : 's'}${stepCount !== run.entries.length ? ` in ${stepCount} steps` : ''}`;
  return (
    <div className="lineup-beads-cell">
      <ol className="lineup-beads" aria-label="Run order" data-testid="schedule-mini-belt">
        {run.entries.map((entry, index) => (
          <li
            key={entry.id}
            className={`lineup-bead lineup-bead--${BEAD_STATE[status(index)] ?? 'queued'}${index > 0 && steps.get(entry.id) !== steps.get(run.entries[index - 1].id) ? ' is-new-step' : ''}`}
            data-issue={entry.ticket.issueKey}
            data-entry-status={status(index)}
            title={`${entry.sequence}. ${entry.ticket.issueKey} · ${entry.ticket.title} · ${ENTRY_STATUS_LABEL[status(index)] ?? 'Waiting'}`}
          />
        ))}
      </ol>
      <span className="lineup-beads-sum">{run.entries.length === 0 ? 'No tickets yet' : summary}</span>
    </div>
  );
}

/** The "when" cell: the start, and what to expect from it. */
export function lineupWhen(view: ScheduledRunView, now: number): { main: string; sub: string } {
  const { run, forecast } = view;
  const likely = forecast?.likelyFinishAt ? formatHourMinute(forecast.likelyFinishAt, run.timezone) : '';
  const cost = forecast?.spend ? `~${formatMoney(forecast.spend.likely, forecast.spend.currency)}` : '';
  const attempt = run.attempts[run.attempts.length - 1];
  const main = formatStart(attempt && !['draft', 'scheduled', 'missed'].includes(run.status) ? attempt.startedAt : run.scheduledStartAt, run.timezone);
  switch (run.status) {
    case 'running':
      return { main, sub: likely ? `likely done ${likely}` : 'running now' };
    case 'paused':
      return { main, sub: `paused · waiting for you${likely ? ` · likely done ${likely}` : ''}` };
    case 'scheduled':
      return { main, sub: [describeCountdown(run.scheduledStartAt, now), likely && `likely done ${likely}`, cost].filter(Boolean).join(' · ') };
    case 'missed':
      return { main, sub: 'was due while Praxis was closed' };
    case 'draft':
      return { main, sub: Date.parse(run.scheduledStartAt) <= now ? 'start has passed' : [describeCountdown(run.scheduledStartAt, now), cost].filter(Boolean).join(' · ') };
    default: {
      const spends = run.entries.map(entry => entry.outcome?.spend).filter((spend): spend is NonNullable<typeof spend> => !!spend);
      const cost = spends.some(spend => spend.cost !== undefined) ? formatMoney(spends.reduce((sum, spend) => sum + (spend.cost ?? 0), 0), spends.find(spend => spend.currency)?.currency) : '';
      return { main, sub: [attempt?.endedAt && `finished ${formatStart(attempt.endedAt, run.timezone)}`, cost].filter(Boolean).join(' · ') };
    }
  }
}

/** The opened row: the issues (editable runs only), the tickets by step, and the facts. */
export function LineupDetails({ view, editable, onTrust }: { view: ScheduledRunView; editable: boolean; onTrust?: () => void }) {
  const { run, readiness, forecast } = view;
  const steps = stepNumbers(run.entries);
  const issuesByKey = new Map<string, string>();
  for (const issue of readiness.issues) if (issue.issueKey) issuesByKey.set(issue.issueKey, issue.message);
  const lanes = run.policy.mode === 'parallel' ? `up to ${run.policy.maxConcurrency} at once` : 'one at a time';
  const facts: Array<[string, string]> = [
    ['Workflow', run.policy.workflowId ?? 'not chosen'],
    ['Tickets', lanes],
    ['Forecast', forecast?.likelyFinishAt
      ? `likely done ${formatHourMinute(forecast.likelyFinishAt, run.timezone)}${forecast.slowFinishAt ? `, could run to ${formatHourMinute(forecast.slowFinishAt, run.timezone)}` : ''} · from ${forecast.basedOnRuns} runs`
      : forecast?.notEstimable ?? 'not available'],
    ['Start', `${formatStart(run.scheduledStartAt, run.timezone)} · once · ${run.timezone}`],
    ['If Praxis is closed', 'it asks when Praxis reopens']
  ];
  return (
    <div className="lineup-details">
      <div className="lineup-details-main">
        {editable && readiness.issues.length > 0 && (
          <ul className="schedule-issues lineup-issues" data-testid="schedule-issues">
            {condenseIssues(readiness.issues).map((issue, index) => (
              <li key={`${issue.code}-${index}`} className={`schedule-issue schedule-issue--${issue.severity}`} data-code={issue.code}>
                <Icon name="warning" size={12} /> {issue.message}
                {issue.code === 'workflow-untrusted' && onTrust && (
                  <button type="button" className="btn lineup-issue-fix" data-testid="schedule-review-trust" onClick={onTrust}>Review and trust</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ol className="lineup-tickets" aria-label="Tickets">
          {run.entries.map((entry, index) => {
            const status = entry.outcome?.status ?? 'queued';
            const step = steps.get(entry.id);
            const newStep = index === 0 || step !== steps.get(run.entries[index - 1].id);
            const note = status === 'queued' ? issuesByKey.get(entry.ticket.issueKey) : undefined;
            return (
              <li key={entry.id} className={`lineup-ticket lineup-ticket--${status}`} data-issue={entry.ticket.issueKey}>
                <span className="lineup-ticket-step">{newStep ? step : ''}</span>
                <span className="lineup-ticket-key">{entry.ticket.issueKey}</span>
                <span className="lineup-ticket-title" title={entry.ticket.title}>{entry.ticket.title}</span>
                <span className={`lineup-ticket-state${note ? ' is-warn' : ''}`}>
                  {note ?? (status === 'queued' ? (isFinished(view) ? 'Never started' : 'Ready') : status === 'done' && entry.outcome?.spend?.cost !== undefined ? formatMoney(entry.outcome.spend.cost, entry.outcome.spend.currency) : ENTRY_STATUS_LABEL[status])}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <dl className="lineup-facts">
        {facts.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </div>
  );
}

