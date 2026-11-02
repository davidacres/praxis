import { useMemo, useState } from 'react';
import type { ScheduledEntryDetail, ScheduledQueueEntry, ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ENTRY_STATUS_LABEL, STATUS_LABEL, formatSpan, formatStart } from './scheduleFormat';
import { formatHourMinute, formatMoney, formatMs, formatTokens } from './spotlightFormat';
import { STOP_LABEL, collapseLedger, firstLine, formatWait, groupStops, runStops, summarizeHandovers, type Stop, type StopKind } from './reportModel';

/**
 * The report for a scheduled run, as a brief (FX-BF-047 / TASK-466, report
 * redesign "1 · Brief").
 *
 * A long unattended run records hundreds of events, most of them repeats: one
 * run logged 232, 120 of them hand-overs. So the report leads with what matters,
 * consolidated — how long the run waited for a person and on what kind of stop,
 * anything unusual (a ticket bouncing between providers), and where the effort
 * went — then one row per ticket that opens to that ticket's own stops, loops,
 * hand-overs and sessions. Repeats are counted, never listed one by one, and the
 * raw events are behind a disclosure with runs of the same thing folded.
 */
interface ScheduleRunReportProps {
  view: ScheduledRunView;
  /** The run is still going: this is the report so far, and Back returns to the monitor. */
  live?: boolean;
  onBack: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
  onOpenSession?: (sessionKey: string) => void;
}

const STOP_TONE: Record<StopKind, string> = { loop: 'warn', failure: 'bad', approval: 'accent', blocked: 'muted', other: 'muted' };

export function ScheduleRunReport({ view, live = false, onBack, onOpenWorkflowRun, onOpenSession }: ScheduleRunReportProps) {
  const { run } = view;
  const [open, setOpen] = useState<string>();
  const [showLedger, setShowLedger] = useState(false);
  const attempt = run.attempts[run.attempts.length - 1];
  const ended = attempt?.endedAt;
  const details = view.details ?? [];
  const detailFor = (entry: ScheduledQueueEntry) => details.find(detail => detail.entryId === entry.id);

  const stops = useMemo(() => runStops(run.events, run.entries), [run.events, run.entries]);
  const groups = groupStops(stops);
  const waitedMs = groups.reduce((sum, group) => sum + group.waitedMs, 0);
  const elapsedMs = attempt ? (ended ? Date.parse(ended) : Date.now()) - Date.parse(attempt.startedAt) : 0;
  const done = run.entries.filter(entry => entry.outcome?.status === 'done').length;
  const spends = run.entries.map(entry => entry.outcome?.spend).filter((spend): spend is NonNullable<typeof spend> => !!spend);
  const cost = spends.some(spend => spend.cost !== undefined) ? spends.reduce((sum, spend) => sum + (spend.cost ?? 0), 0) : undefined;
  const currency = spends.find(spend => spend.currency)?.currency;
  const tokens = spends.some(spend => spend.tokens !== undefined) ? spends.reduce((sum, spend) => sum + (spend.tokens ?? 0), 0) : undefined;
  const hours = elapsedMs / 3_600_000;
  const headline = `${done} of ${run.entries.length} delivered${live ? ' so far' : ''}${hours >= 1 ? ` in ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}` : ''}${waitedMs >= 30 * 60_000 && elapsedMs ? ` — ${formatWait(waitedMs)} of it waiting for you` : ''}`;

  // Anything unusual, once each.
  const unusual = run.entries.flatMap(entry => {
    const notes: Array<{ key: string; title: string; text: string }> = [];
    const summary = summarizeHandovers(entry.outcome?.handovers ?? []);
    if (summary.bounced) {
      const span = summary.firstAt && summary.lastAt ? formatSpan(summary.firstAt, summary.lastAt) : '';
      notes.push({
        key: `${entry.id}-bounce`,
        title: `${entry.ticket.issueKey} bounced between providers ${summary.total} times`,
        text: `${summary.pairs.slice(0, 2).map(pair => `${pair.from} → ${pair.to} ×${pair.count}`).join(', ')}${span ? `, over ${span}` : ''}. Shown once here instead of ${summary.total} rows.`
      });
    }
    if (entry.outcome?.status === 'failed') notes.push({ key: `${entry.id}-failed`, title: `${entry.ticket.issueKey} failed`, text: entry.outcome.reason ? firstLine(entry.outcome.reason) : 'It stopped without delivering.' });
    if (entry.outcome?.status === 'skipped') notes.push({ key: `${entry.id}-skipped`, title: `${entry.ticket.issueKey} was skipped`, text: entry.outcome.reason ? firstLine(entry.outcome.reason) : 'Left out of the run.' });
    return notes;
  });

  // Where the effort went: the tickets that took the most attempts or loops, then the clean ones.
  const effort = run.entries.map(entry => {
    const detail = detailFor(entry);
    const attempts = detail?.stages.reduce((sum, stage) => sum + stage.attempts, 0) ?? 0;
    const extra = detail?.stages.reduce((sum, stage) => sum + Math.max(0, stage.attempts - 1), 0) ?? 0;
    const failed = detail?.stages.filter(stage => stage.lane === 'failed').length ?? 0;
    const time = formatSpan(entry.outcome?.startedAt, entry.outcome?.endedAt);
    return { entry, detail, attempts, extra, failed, loops: detail?.loops.length ?? 0, time };
  });
  const busiest = effort.filter(item => item.extra > 0 || item.loops > 0).sort((a, b) => b.extra + b.loops - (a.extra + a.loops)).slice(0, 3);
  // Clean only when the workflow recorded its tasks and none took a second go; shortest first.
  const clean = effort
    .filter(item => item.entry.outcome?.status === 'done' && item.detail && item.detail.stages.length > 0 && item.extra === 0 && item.loops === 0)
    .sort((a, b) => spanMs(a.entry) - spanMs(b.entry));

  const ledger = useMemo(() => collapseLedger(run.events.filter(event => !['created', 'renamed', 'tickets-added', 'ticket-removed', 'reordered', 'rescheduled', 'workflow-changed'].includes(event.kind))), [run.events]);

  return (
    <div className="view-scroll schedule-page schedule-report brief" data-testid="schedule-report" data-status={run.status}>
      <header className="brief-head">
        <div className="brief-head-main">
          <div className="spot-head-meta">
            <button type="button" className="btn btn-icon" aria-label={live ? 'Back to the live run' : 'Back to scheduled runs'} data-testid="schedule-report-back" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
            <span className={`spot-pill spot-pill--${run.status}`} data-testid="schedule-report-status">{STATUS_LABEL[run.status]}</span>
            <span className="spot-head-sub">{run.name}{attempt ? ` · ${formatStart(attempt.startedAt, run.timezone)}${ended ? ` → ${formatHourMinute(ended, run.timezone)}` : ''}` : ''}</span>
          </div>
          <h2 className="spot-headline">{headline}</h2>
        </div>
        <div className="brief-kpis" data-testid="schedule-report-totals">
          <div><b>{cost !== undefined ? formatMoney(cost, currency) : '—'}</b><span>{tokens !== undefined ? `${formatTokens(tokens)} tokens` : 'no usage reported'}</span></div>
          <div><b>{elapsedMs ? formatWait(Math.max(0, elapsedMs - waitedMs)) : '—'}</b><span>working</span></div>
          <div><b className={waitedMs ? 'is-warn' : undefined}>{formatWait(waitedMs)}</b><span>waiting for you</span></div>
        </div>
      </header>

      <div className="brief-insights">
        <section className="brief-card" aria-label="Waiting for you" data-testid="schedule-report-needs">
          <span className="lineup-label">Waiting for you · {stops.length} stop{stops.length === 1 ? '' : 's'}</span>
          {stops.length === 0 ? <p className="schedule-hint">Nothing stopped for a person.</p> : (
            <>
              <div className="brief-big">{formatWait(waitedMs)}</div>
              <div className="brief-stack" aria-hidden="true">
                {groups.map(group => <i key={group.kind} className={`tone-${STOP_TONE[group.kind]}`} style={{ width: `${waitedMs ? (group.waitedMs / waitedMs) * 100 : 100 / groups.length}%` }} />)}
              </div>
              <ul className="brief-legend">
                {groups.map(group => (
                  <li key={group.kind} data-kind={group.kind}><i className={`tone-${STOP_TONE[group.kind]}`} />{STOP_LABEL[group.kind]}<span>{group.count} · {formatWait(group.waitedMs)}</span></li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className={`brief-card${unusual.length ? ' is-bad' : ''}`} aria-label="Worth a look" data-testid="schedule-report-notes">
          <span className="lineup-label">Worth a look</span>
          {unusual.length === 0 ? <p className="schedule-hint">Nothing unusual: no bouncing hand-overs, failures or skips.</p> : (
            <ul className="brief-notes">
              {unusual.slice(0, 3).map(note => <li key={note.key}><strong>{note.title}</strong><span>{note.text}</span></li>)}
              {unusual.length > 3 && <li className="brief-more">and {unusual.length - 3} more in the tickets below</li>}
            </ul>
          )}
        </section>
        <section className="brief-card" aria-label="Where the effort went">
          <span className="lineup-label">Where the effort went</span>
          <ul className="brief-notes">
            {busiest.map(item => (
              <li key={item.entry.id}>
                <strong>{item.entry.ticket.issueKey}</strong>
                <span>{[item.extra ? `${item.extra} extra attempt${item.extra === 1 ? '' : 's'}` : '', item.loops ? `${item.loops} review loop${item.loops === 1 ? '' : 's'}` : '', item.time].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
            {clean.length > 0 && <li><strong>{clean.length === run.entries.length ? 'Every ticket' : busiest.length ? `The other ${clean.length}` : `${clean.length} ticket${clean.length === 1 ? '' : 's'}`}</strong><span>ran every task first time{cleanRange(clean.map(item => item.time))}.</span></li>}
            {busiest.length === 0 && clean.length === 0 && <li className="brief-more">{done ? 'The workflow runs recorded no per-task detail to compare.' : 'Nothing has finished yet.'}</li>}
          </ul>
        </section>
      </div>

      <section className="brief-table-wrap" aria-label="Tickets">
        <div className="brief-table-head"><span className="lineup-label">Tickets</span><span className="lineup-hint">one row each · open a row for its stops, loops, hand-overs and sessions</span></div>
        <table className="schedule-report-table brief-table" data-testid="schedule-report-table">
          <thead><tr><th>Ticket</th><th>Outcome</th><th>Agent tasks</th><th>Stops</th><th className="num">Time</th><th className="num">Spend</th><th aria-label="Details" /></tr></thead>
          <tbody>
            {run.entries.map(entry => {
              const status = entry.outcome?.status ?? 'queued';
              const detail = detailFor(entry);
              const isOpen = open === entry.id;
              const own = stops.filter(stop => stop.entryId === entry.id || (!stop.entryId && stop.issueKey === entry.ticket.issueKey));
              const handovers = summarizeHandovers(entry.outcome?.handovers ?? []);
              const chips = ticketChips(own, handovers.total, entry.outcome?.retries ?? 0, detail);
              return (
                <ReportRows
                  key={entry.id}
                  entry={entry}
                  status={status}
                  detail={detail}
                  isOpen={isOpen}
                  chips={chips}
                  stops={own}
                  handovers={handovers}
                  onToggle={() => setOpen(isOpen ? undefined : entry.id)}
                  onOpenWorkflowRun={onOpenWorkflowRun}
                  onOpenSession={onOpenSession}
                />
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="brief-ledger">
        <button type="button" className="btn btn-link" aria-expanded={showLedger} onClick={() => setShowLedger(value => !value)}>
          {showLedger ? 'Hide raw events' : `Show raw events (${run.events.length}, ${ledger.length} after folding repeats)`}
        </button>
        {showLedger && (
          <ol className="schedule-log brief-log" data-testid="schedule-report-ledger">
            {ledger.map((line, index) => (
              <li key={`${line.at}-${index}`} data-kind={line.kind}>
                <time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time> {firstLine(line.message, 220)}
                {line.count > 1 && <span className="brief-count"> ×{line.count} until {new Date(line.lastAt).toLocaleTimeString()}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function spanMs(entry: ScheduledQueueEntry): number {
  const outcome = entry.outcome;
  return outcome?.startedAt && outcome.endedAt ? Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt) : 0;
}

function cleanRange(times: string[]): string {
  const known = times.filter(Boolean);
  if (known.length === 0) return '';
  return known.length === 1 ? `, in ${known[0]}` : `, in ${known[0]}–${known[known.length - 1]} each`;
}

interface Chip { text: string; tone: '' | 'warn' | 'bad' }

/** A ticket's stops and repeats, as a few counted chips. */
function ticketChips(stops: Stop[], handovers: number, retries: number, detail: ScheduledEntryDetail | undefined): Chip[] {
  const chips: Chip[] = [];
  for (const group of groupStops(stops)) {
    if (group.kind === 'approval' && group.count === 1) continue;
    chips.push({ text: `${group.count} ${STOP_LABEL[group.kind].toLowerCase().replace(/s$/, group.count === 1 ? '' : 's')}`, tone: group.kind === 'failure' || group.kind === 'blocked' ? 'bad' : 'warn' });
  }
  const loops = detail?.loops.length ?? 0;
  if (loops) chips.push({ text: `${loops} loop${loops === 1 ? '' : 's'}`, tone: 'warn' });
  if (retries) chips.push({ text: `${retries} retr${retries === 1 ? 'y' : 'ies'}`, tone: 'warn' });
  if (handovers) chips.push({ text: `${handovers} hand-over${handovers === 1 ? '' : 's'}`, tone: handovers > 3 ? 'bad' : '' });
  return chips;
}

interface ReportRowsProps {
  entry: ScheduledQueueEntry;
  status: string;
  detail?: ScheduledEntryDetail;
  isOpen: boolean;
  chips: Chip[];
  stops: Stop[];
  handovers: ReturnType<typeof summarizeHandovers>;
  onToggle: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
  onOpenSession?: (sessionKey: string) => void;
}

function ReportRows({ entry, status, detail, isOpen, chips, stops, handovers, onToggle, onOpenWorkflowRun, onOpenSession }: ReportRowsProps) {
  const outcome = entry.outcome;
  const stages = detail?.stages ?? [];
  const sessions = stages.filter(stage => stage.sessionKey && stage.type === 'agent-task');
  return (
    <>
      <tr className={`brief-row${isOpen ? ' is-open' : ''}`} data-issue={entry.ticket.issueKey} data-entry-status={status} onClick={onToggle}>
        <td><span className="lineup-ticket-key">{entry.ticket.issueKey}</span><div className="brief-title">{entry.ticket.title}</div></td>
        <td className={`brief-outcome brief-outcome--${status}`}>{status === 'queued' ? 'Never started' : ENTRY_STATUS_LABEL[status]}</td>
        <td>
          {stages.length > 0 ? (
            <span className="spot-bars" data-testid="schedule-report-tasks">
              {stages.map(stage => {
                const label = `${stage.name} · ${stage.lane}${stage.totalMs ? ` · ${formatMs(stage.totalMs)}` : ''}${stage.attempts > 1 ? ` · ${stage.attempts} attempts` : ''}`;
                return <span key={stage.nodeId} className={`spot-bar spot-bar--${stage.lane}${stage.attempts > 1 ? ' is-again' : ''}`} title={label} aria-label={label}>{stage.attempts > 1 ? stage.attempts : ''}</span>;
              })}
            </span>
          ) : '—'}
        </td>
        <td><span className="brief-chips">{chips.map(chip => <span key={chip.text} className={`brief-chip${chip.tone ? ` is-${chip.tone}` : ''}`}>{chip.text}</span>)}</span></td>
        <td className="num">{formatSpan(outcome?.startedAt, outcome?.endedAt) || '—'}</td>
        <td className="num">{outcome?.spend?.cost !== undefined ? formatMoney(outcome.spend.cost, outcome.spend.currency) : '—'}</td>
        <td className="num"><button type="button" className="btn btn-icon" aria-label={isOpen ? `Hide ${entry.ticket.issueKey} details` : `Show ${entry.ticket.issueKey} details`} aria-expanded={isOpen} onClick={event => { event.stopPropagation(); onToggle(); }}><Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={13} /></button></td>
      </tr>
      {isOpen && (
        <tr className="brief-detail" data-testid="schedule-report-detail">
          <td colSpan={7}>
            <div className="brief-detail-grid">
              <div>
                <h5>Stops</h5>
                {stops.length === 0 ? <p className="schedule-hint">None.</p> : (
                  <ul>{groupStops(stops).map(group => <li key={group.kind}>{STOP_LABEL[group.kind]} ×{group.count} · {formatWait(group.waitedMs)}<span className="brief-sub">{firstLine(stops.filter(stop => stop.kind === group.kind)[0].message)}</span></li>)}</ul>
                )}
              </div>
              <div>
                <h5>Loops, retries and hand-overs</h5>
                <ul>
                  {(detail?.loops ?? []).length > 0 && <li>{detail!.loops.length} × {detail!.loops[0].fromName} → {detail!.loops[0].toName}{detail!.loops[0].findings[0] ? <span className="brief-sub">{firstLine(detail!.loops[0].findings[0])}</span> : null}</li>}
                  {stages.filter(stage => stage.attempts > 1 && stage.lastError).map(stage => <li key={stage.nodeId}>{stage.name}: {stage.attempts} attempts<span className="brief-sub">{firstLine(stage.lastError!)}</span></li>)}
                  {handovers.pairs.map(pair => <li key={`${pair.from}-${pair.to}`}>{pair.from} → {pair.to}{pair.count > 1 ? ` ×${pair.count}` : ''}</li>)}
                  {(detail?.loops ?? []).length === 0 && handovers.total === 0 && !stages.some(stage => stage.attempts > 1) && <li className="brief-sub">Every task passed first time.</li>}
                </ul>
              </div>
              <div>
                <h5>Open</h5>
                <div className="brief-open">
                  {outcome?.workflowRunId && onOpenWorkflowRun && <button type="button" className="btn" data-testid="schedule-report-open" onClick={() => onOpenWorkflowRun(outcome.workflowRunId!)}>Workflow run</button>}
                  {onOpenSession && sessions.map(stage => <button key={stage.nodeId} type="button" className="btn" data-testid="schedule-report-session" onClick={() => onOpenSession(stage.sessionKey!)}>{stage.name} session</button>)}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
