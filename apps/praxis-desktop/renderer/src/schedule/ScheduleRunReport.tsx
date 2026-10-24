import type { ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ENTRY_STATUS_LABEL, STATUS_LABEL, formatSpan, formatSpend, formatStart } from './scheduleFormat';

/**
 * The report for a finished scheduled run (FX-BF-047 / FX-BE-173 / TASK-466).
 *
 * Built only from the run's own ledger: what started when, which provider each
 * ticket ran on, any hand-over (with its checkpoint commit), what it cost and how
 * it ended. A figure a provider did not report is shown as "No usage reported",
 * not as zero. Plain text and tables, so it reads the same with no animation.
 */
interface ScheduleRunReportProps {
  view: ScheduledRunView;
  onBack: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
}

export function ScheduleRunReport({ view, onBack, onOpenWorkflowRun }: ScheduleRunReportProps) {
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

  return (
    <div className="view-scroll schedule-page schedule-report" data-testid="schedule-report" data-status={run.status}>
      <header className="schedule-head">
        <div className="schedule-compose-title">
          <button type="button" className="btn btn-icon" aria-label="Back to scheduled runs" data-testid="schedule-report-back" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
          <h2 className="schedule-title">{run.name}</h2>
          <span className={`schedule-status schedule-status--${run.status}`} data-testid="schedule-report-status">{STATUS_LABEL[run.status]}</span>
        </div>
      </header>

      <div className="schedule-overview" data-testid="schedule-report-totals">
        <ReportTile label="Done" value={`${done} of ${run.entries.length}`} />
        <ReportTile label="Skipped" value={String(skipped)} />
        <ReportTile label="Failed" value={String(failed)} />
        <ReportTile label="Hand-overs" value={String(handovers)} />
        <ReportTile label="Spend" value={formatSpend(total)} />
        <ReportTile label="Active time" value={formatSpan(attempt?.startedAt, attempt?.endedAt) || '—'} />
      </div>
      {attempt && (
        <p className="schedule-hint">
          Started {formatStart(attempt.startedAt, run.timezone)} ({attempt.trigger === 'start-now' ? 'started at your request' : 'on schedule'}).
        </p>
      )}

      <table className="schedule-report-table" data-testid="schedule-report-table">
        <thead>
          <tr><th>#</th><th>Ticket</th><th>Outcome</th><th>Provider</th><th>Spend</th><th>Time</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {run.entries.map(entry => {
            const outcome = entry.outcome;
            const status = outcome?.status ?? 'queued';
            return (
              <tr key={entry.id} data-issue={entry.ticket.issueKey} data-entry-status={status}>
                <td>{entry.sequence}</td>
                <td><span className="schedule-chip-key">{entry.ticket.issueKey}</span> {entry.ticket.title}</td>
                <td>{status === 'queued' ? 'Never started' : ENTRY_STATUS_LABEL[status]}</td>
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

      <section className="schedule-panel" aria-label="Ledger">
        <h3 className="schedule-panel-title">Ledger</h3>
        <ol className="schedule-log" data-testid="schedule-report-ledger">
          {run.events.filter(event => !['created', 'renamed', 'tickets-added', 'ticket-removed', 'reordered', 'rescheduled', 'workflow-changed', 'budget-checked'].includes(event.kind)).map((event, index) => (
            <li key={`${event.at}-${index}`} data-kind={event.kind}><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> {event.message}</li>
          ))}
        </ol>
      </section>
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
