import type { ScheduledEntryDetail, ScheduledQueueEntry, ScheduledRunView, ScheduledStageDetail } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ENTRY_STATUS_LABEL, STATUS_LABEL, formatSpan, formatSpend, formatStart } from './scheduleFormat';
import { BeadRail, entryBeadState, formatHourMinute, formatMs, stepNumbers } from './scheduleSpotlight';

/**
 * The report for a scheduled run (FX-BF-047 / FX-BE-173 / TASK-466, in the
 * FX-BE-193 design): what needed a person and how long it waited, what is worth
 * knowing (review loops and their findings, provider hand-overs, retries, skips),
 * one row per ticket with a bar for each agent task, and where the time went.
 *
 * Built only from what the runner and the workflow engine recorded. A figure a
 * provider did not report reads "No usage reported", never zero. Plain text and
 * tables, so it reads the same with no animation.
 */
interface ScheduleRunReportProps {
  view: ScheduledRunView;
  /** The run is still going: this is the report so far, and Back returns to the monitor. */
  live?: boolean;
  onBack: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
  onOpenSession?: (sessionKey: string) => void;
}

interface Need { at: string; until?: string; message: string; tone: 'warn' | 'bad' }
interface Note { glyph: string; title: string; text: string }

/** Each time the run stopped for a person, and how long it waited before it carried on. */
function neededYou(view: ScheduledRunView): Need[] {
  const events = view.run.events;
  const needs: Need[] = [];
  events.forEach((event, index) => {
    // A stop for a person is logged as `paused`, or as `entry-gate` for an approval.
    if (event.kind !== 'paused' && event.kind !== 'entry-gate') return;
    const until = events.slice(index + 1).find(next =>
      ['resumed', 'completed', 'cancelled'].includes(next.kind) ||
      (!!event.entryId && next.entryId === event.entryId && ['entry-done', 'entry-skipped', 'entry-retried', 'entry-failed'].includes(next.kind)));
    needs.push({ at: event.at, ...(until ? { until: until.at } : {}), message: event.message, tone: /fail|could not|interrupted/i.test(event.message) ? 'bad' : 'warn' });
  });
  return needs;
}

function worthKnowing(view: ScheduledRunView): Note[] {
  const notes: Note[] = [];
  const byEntry = new Map(view.run.entries.map(entry => [entry.id, entry] as const));
  for (const detail of view.details ?? []) {
    const key = byEntry.get(detail.entryId)?.ticket.issueKey ?? '';
    for (const loop of detail.loops) {
      notes.push({ glyph: '↺', title: `${key}: ${loop.fromName} sent it back to ${loop.toName} (pass ${loop.iteration})`, text: loop.findings.slice(0, 2).join(' · ') || 'No findings were recorded with it.' });
    }
    for (const stage of detail.stages.filter(item => item.attempts > 1 && !detail.loops.some(loop => loop.toName === item.name || loop.fromName === item.name))) {
      notes.push({ glyph: `×${stage.attempts}`, title: `${key}: ${stage.name} took ${stage.attempts} attempts`, text: stage.lastError ? `Last error: ${stage.lastError}` : 'It passed on a later attempt.' });
    }
  }
  for (const entry of view.run.entries) {
    for (const handover of entry.outcome?.handovers ?? []) {
      notes.push({ glyph: '⇄', title: `${entry.ticket.issueKey}: handed over ${handover.from} → ${handover.to}`, text: `At ${Math.round(handover.usedPercent)}% of ${handover.from}'s allowance${handover.checkpointRef ? `, from checkpoint ${handover.checkpointRef.slice(0, 8)}` : ''}.` });
    }
    if (entry.outcome?.retries) notes.push({ glyph: '↻', title: `${entry.ticket.issueKey}: retried ${entry.outcome.retries} time${entry.outcome.retries === 1 ? '' : 's'}`, text: entry.outcome.reason ?? 'Started again after it stopped.' });
    if (entry.outcome?.status === 'skipped') notes.push({ glyph: '–', title: `${entry.ticket.issueKey}: skipped`, text: entry.outcome.reason ?? 'Left out of the run.' });
  }
  return notes;
}

/** Each agent task's time added up across tickets, with the median ticket and the attempts it took. */
function timeByTask(details: readonly ScheduledEntryDetail[]) {
  const rows = new Map<string, { name: string; type: ScheduledStageDetail['type']; times: number[]; attempts: number }>();
  for (const detail of details) {
    for (const stage of detail.stages) {
      const row = rows.get(stage.nodeId) ?? { name: stage.name, type: stage.type, times: [], attempts: 0 };
      if (stage.totalMs) row.times.push(stage.totalMs);
      row.attempts += stage.attempts;
      rows.set(stage.nodeId, row);
    }
  }
  const list = [...rows.entries()].map(([nodeId, row]) => {
    const sorted = [...row.times].sort((a, b) => a - b);
    return { nodeId, name: row.name, type: row.type, total: row.times.reduce((sum, value) => sum + value, 0), median: sorted[Math.floor(sorted.length / 2)], attempts: row.attempts, tickets: row.times.length };
  });
  const max = Math.max(1, ...list.map(row => row.total));
  return list.map(row => ({ ...row, share: row.total / max }));
}

export function ScheduleRunReport({ view, live = false, onBack, onOpenWorkflowRun, onOpenSession }: ScheduleRunReportProps) {
  const { run } = view;
  const attempt = run.attempts[run.attempts.length - 1];
  const done = run.entries.filter(entry => entry.outcome?.status === 'done').length;
  const skipped = run.entries.filter(entry => entry.outcome?.status === 'skipped').length;
  const failed = run.entries.filter(entry => entry.outcome?.status === 'failed').length;
  const handovers = run.entries.reduce((count, entry) => count + (entry.outcome?.handovers?.length ?? 0), 0);
  const spends = run.entries.map(entry => entry.outcome?.spend).filter((spend): spend is NonNullable<typeof spend> => !!spend);
  const total = spends.length === 0 ? undefined : {
    tokens: spends.some(spend => spend.tokens !== undefined) ? spends.reduce((sum, spend) => sum + (spend.tokens ?? 0), 0) : undefined,
    cost: spends.some(spend => spend.cost !== undefined) ? spends.reduce((sum, spend) => sum + (spend.cost ?? 0), 0) : undefined,
    currency: spends.find(spend => spend.currency)?.currency
  };
  const needs = neededYou(view);
  const waited = needs.reduce((sum, need) => sum + (need.until ? Date.parse(need.until) - Date.parse(need.at) : 0), 0);
  const notes = worthKnowing(view);
  const details = view.details ?? [];
  const detailFor = (entry: ScheduledQueueEntry) => details.find(detail => detail.entryId === entry.id);
  const timing = timeByTask(details);
  const steps = stepNumbers(run.entries);
  const ended = attempt?.endedAt;
  const headline = live
    ? `${done} of ${run.entries.length} delivered so far`
    : done === run.entries.length ? `All ${done} delivered` : `${done} of ${run.entries.length} delivered`;

  return (
    <div className="view-scroll schedule-page schedule-report spot" data-testid="schedule-report" data-status={run.status}>
      <header className="spot-head">
        <div className="spot-head-main">
          <div className="spot-head-meta">
            <button type="button" className="btn btn-icon" aria-label={live ? 'Back to the live run' : 'Back to scheduled runs'} data-testid="schedule-report-back" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
            <span className={`spot-pill spot-pill--${run.status}`} data-testid="schedule-report-status">{STATUS_LABEL[run.status]}</span>
            <span className="spot-head-sub">{run.name}{attempt ? ` · ${attempt.trigger === 'start-now' ? 'started at your request' : 'started on schedule'}` : ''}</span>
          </div>
          <h2 className="spot-headline">{headline}</h2>
        </div>
        {attempt && (
          <div className="spot-head-clock">
            <span className="spot-clock">{formatHourMinute(attempt.startedAt, run.timezone)} → {ended ? formatHourMinute(ended, run.timezone) : 'now'}</span>
            <span className="spot-clock-sub">{formatStart(attempt.startedAt, run.timezone)}{ended ? ` · ${formatSpan(attempt.startedAt, ended)} end to end` : ''}{waited > 0 ? ` · ${formatMs(waited)} waiting for you` : ''}</span>
          </div>
        )}
      </header>

      <div className="schedule-overview spot-totals" data-testid="schedule-report-totals">
        <ReportTile label="Done" value={`${done} of ${run.entries.length}`} />
        <ReportTile label="Skipped" value={String(skipped)} />
        <ReportTile label="Failed" value={String(failed)} />
        <ReportTile label="Hand-overs" value={String(handovers)} />
        <ReportTile label="Spend" value={formatSpend(total)} />
        <ReportTile label="Active time" value={formatSpan(attempt?.startedAt, attempt?.endedAt) || (live ? 'running' : '—')} />
      </div>

      <BeadRail beads={run.entries.map(entry => ({ key: entry.id, issueKey: entry.ticket.issueKey, title: entry.ticket.title, step: steps.get(entry.id) ?? 1, state: entryBeadState(entry) }))} />

      <div className="spot-report-grid">
        <section className="schedule-panel" aria-label="Needed you" data-testid="schedule-report-needs">
          <h3 className="schedule-panel-title">Needed you <span className="schedule-panel-note">{needs.length}</span></h3>
          {needs.length === 0 && <p className="schedule-hint">Nothing stopped for a person.</p>}
          <ul className="spot-notes">
            {needs.map(need => (
              <li key={need.at} className={`spot-note-row spot-note-row--${need.tone}`}>
                <span className="spot-note-glyph" aria-hidden="true">!</span>
                <span><strong>{need.message}</strong><span className="spot-note-sub">{formatHourMinute(need.at, run.timezone)}{need.until ? ` · waited ${formatSpan(need.at, need.until)}` : ' · still waiting'}</span></span>
              </li>
            ))}
          </ul>
        </section>
        <section className="schedule-panel" aria-label="Worth knowing" data-testid="schedule-report-notes">
          <h3 className="schedule-panel-title">Worth knowing <span className="schedule-panel-note">{notes.length}</span></h3>
          {notes.length === 0 && <p className="schedule-hint">No loops, retries, hand-overs or skips.</p>}
          <ul className="spot-notes">
            {notes.map((note, index) => (
              <li key={`${note.title}-${index}`} className="spot-note-row">
                <span className="spot-note-glyph" aria-hidden="true">{note.glyph}</span>
                <span><strong>{note.title}</strong><span className="spot-note-sub">{note.text}</span></span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <table className="schedule-report-table" data-testid="schedule-report-table">
        <thead>
          <tr><th>#</th><th>Ticket</th><th>Outcome</th><th>Agent tasks</th><th>Provider</th><th>Spend</th><th>Time</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {run.entries.map(entry => {
            const outcome = entry.outcome;
            const status = outcome?.status ?? 'queued';
            const stages = detailFor(entry)?.stages ?? [];
            return (
              <tr key={entry.id} data-issue={entry.ticket.issueKey} data-entry-status={status}>
                <td>{entry.sequence}</td>
                <td><span className="schedule-chip-key">{entry.ticket.issueKey}</span> {entry.ticket.title}</td>
                <td>{status === 'queued' ? 'Never started' : ENTRY_STATUS_LABEL[status]}</td>
                <td>
                  {stages.length > 0 ? (
                    <span className="spot-bars" data-testid="schedule-report-tasks">
                      {stages.map(stage => {
                        const label = `${stage.name} · ${stage.lane}${stage.totalMs ? ` · ${formatMs(stage.totalMs)}` : ''}${stage.attempts > 1 ? ` · ${stage.attempts} attempts` : ''}`;
                        const className = `spot-bar spot-bar--${stage.lane}${stage.attempts > 1 ? ' is-again' : ''}`;
                        return stage.sessionKey && onOpenSession
                          ? <button key={stage.nodeId} type="button" className={className} title={`${label} — open its session`} aria-label={`${label}, open its session`} data-testid="schedule-report-session" onClick={() => onOpenSession(stage.sessionKey!)}>{stage.attempts > 1 ? `×${stage.attempts}` : ''}</button>
                          : <span key={stage.nodeId} className={className} title={label} aria-label={label}>{stage.attempts > 1 ? `×${stage.attempts}` : ''}</span>;
                      })}
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {outcome?.provider ?? '—'}
                  {outcome?.handovers?.map(handover => (
                    <div key={handover.at} className="schedule-report-handover">{handover.from} → {handover.to} at {Math.round(handover.usedPercent)}%{handover.checkpointRef ? ` · checkpoint ${handover.checkpointRef}` : ''}</div>
                  ))}
                </td>
                <td>{outcome?.spend ? formatSpend(outcome.spend) : '—'}</td>
                <td>{formatSpan(outcome?.startedAt, outcome?.endedAt) || '—'}</td>
                <td>
                  {outcome?.reason ?? ''}
                  {outcome?.retries ? ` Retried ${outcome.retries} time${outcome.retries === 1 ? '' : 's'}.` : ''}
                  {outcome?.workflowRunId && onOpenWorkflowRun && (
                    <button type="button" className="btn btn-link" data-testid="schedule-report-open" onClick={() => onOpenWorkflowRun(outcome.workflowRunId!)}>Open run</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {timing.length > 0 && (
        <section className="schedule-panel" aria-label="Where the time went" data-testid="schedule-report-time">
          <h3 className="schedule-panel-title">Where the time went <span className="schedule-panel-note">every attempt of each task, all tickets</span></h3>
          <ul className="spot-time">
            {timing.map(row => (
              <li key={row.nodeId} data-node={row.nodeId}>
                <span className="spot-time-name">{row.name}</span>
                <span className="spot-time-bar"><span className={`spot-time-fill spot-time-fill--${row.type}`} style={{ width: `${Math.max(1, row.share * 100)}%` }} /></span>
                <span className="spot-time-num">{formatMs(row.total) || '—'}</span>
                <span className="spot-time-num spot-time-sub">{row.median ? `median ${formatMs(row.median)}` : ''}</span>
                <span className="spot-time-num spot-time-sub">{row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="schedule-panel spot-ledger">
        <summary className="schedule-panel-title">Ledger</summary>
        <ol className="schedule-log" data-testid="schedule-report-ledger">
          {run.events.filter(event => !['created', 'renamed', 'tickets-added', 'ticket-removed', 'reordered', 'rescheduled', 'workflow-changed', 'budget-checked'].includes(event.kind)).map((event, index) => (
            <li key={`${event.at}-${index}`} data-kind={event.kind}><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> {event.message}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function ReportTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="schedule-tile">
      <span className="schedule-tile-label">{label}</span>
      <strong className="schedule-report-value">{value}</strong>
    </div>
  );
}
