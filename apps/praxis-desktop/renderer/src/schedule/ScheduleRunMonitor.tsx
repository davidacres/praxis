import { useState } from 'react';
import type { ScheduledQueueEntry, ScheduledRunLive, ScheduledRunView, ScheduledStageDetail } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { confirmProjectWorkflowTrust } from '../workflows/workflowProjectTrust';
import { useSettings } from '../settings/useSettings';
import { DEFAULT_APP_SETTINGS } from '../settings/settingsDefaults';
import { ENTRY_STATUS_LABEL, STATUS_LABEL, formatClock, formatSpan, formatSpend } from './scheduleFormat';
import { BeadRail, TaskRows, entryBeadState, formatHourMinute, formatMoney, formatMs, formatTokens, stepNumbers, useNow } from './scheduleSpotlight';

/**
 * The live view of a running or paused scheduled run: Spotlight (FX-BF-047 /
 * FX-BE-193 / TASK-507).
 *
 * A row of beads stands for every ticket in run order. Waiting tickets sit in the
 * deck on the left, every ticket in flight has its own card in the middle with its
 * workflow's agent tasks, and finished tickets become receipts on the right. When
 * a ticket needs a person, the decision is on that ticket's card.
 *
 * Everything shown is what the runner and the workflow engine recorded: a running
 * task shows how long it has been going, never a made-up percentage, and the "now"
 * line is recorded text. Motion is decoration and stops under reduced motion.
 */
interface ScheduleRunMonitorProps {
  view: ScheduledRunView;
  onBack: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
  /** Opens the report for the run so far. */
  onShowReport?: () => void;
}

const PAUSE_TITLE: Record<string, string> = {
  budget: 'Allowance is nearly used.',
  approval: 'Waiting for an approval.',
  policy: 'Needs a decision.',
  trust: 'Workflow not trusted.',
  'no-provider': 'No AI provider available.',
  failure: 'A stage needs attention.',
  user: 'Paused.',
  'launch-interrupted': 'Praxis stopped while starting a ticket.'
};

export function ScheduleRunMonitor({ view, onBack, onOpenWorkflowRun, onShowReport }: ScheduleRunMonitorProps) {
  const { run } = view;
  const headroom = view.headroom ?? [];
  const lives = view.lives ?? [];
  const { confirm } = useDialogs();
  const handoverPercent = useSettings().settings?.ai.providerHandoverPercent ?? DEFAULT_APP_SETTINGS.ai.providerHandoverPercent;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const api = window.praxis.scheduledRuns;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const steps = stepNumbers(run.entries);
  const pause = run.status === 'paused' ? run.pause : undefined;
  const inFlight = run.status === 'running' || run.status === 'paused';
  const statusOf = (entry: ScheduledQueueEntry) => entry.outcome?.status ?? 'queued';
  const flying = inFlight ? run.entries.filter(entry => ['running', 'paused', 'failed'].includes(statusOf(entry))) : [];
  const queued = run.entries.filter(entry => statusOf(entry) === 'queued');
  const finished = run.entries
    .filter(entry => !flying.includes(entry) && !queued.includes(entry))
    .sort((a, b) => Date.parse(b.outcome?.endedAt ?? '') - Date.parse(a.outcome?.endedAt ?? '') || b.sequence - a.sequence);
  const parallel = run.policy.mode === 'parallel';
  const cap = run.policy.mode === 'parallel' ? run.policy.maxConcurrency : 1;
  const forecast = view.forecast;
  const tz = run.timezone;

  const spent = run.entries.map(entry => entry.outcome?.spend).filter((spend): spend is NonNullable<typeof spend> => !!spend);
  const currency = spent.find(spend => spend.currency)?.currency;
  const spendSoFar = spent.some(spend => spend.cost !== undefined) ? formatMoney(spent.reduce((sum, spend) => sum + (spend.cost ?? 0), 0), currency) : '';
  const started = run.attempts[run.attempts.length - 1]?.startedAt;

  // Why each waiting ticket is waiting — what the runner recorded, never inferred live.
  const currentStep = (() => {
    const next = run.entries.find(entry => !['done', 'skipped'].includes(statusOf(entry)));
    return next ? steps.get(next.id) : undefined;
  })();
  const waitReason = (entry: ScheduledQueueEntry): string => {
    if (pause?.entryId === entry.id) return pause.message;
    const own = steps.get(entry.id);
    if (currentStep !== undefined && own !== undefined && own > currentStep) return `Waits for step ${currentStep} to finish.`;
    if (run.status === 'paused') return 'Waits until the run continues.';
    const last = [...run.events].reverse().find(event => event.entryId === entry.id && event.kind === 'budget-checked');
    if (last && /\bwaits\b/.test(last.message)) return last.message;
    return parallel && flying.length >= cap ? `Waits for a free lane (${cap} in use).` : 'Next to start.';
  };

  const headline = (() => {
    if (pause?.entryId) {
      const about = run.entries.find(entry => entry.id === pause.entryId);
      if (about) return `${about.ticket.issueKey} needs you`;
    }
    if (pause) return PAUSE_TITLE[pause.reason] ?? 'Paused';
    if (flying.length) return `Working on ${flying.map(entry => entry.ticket.issueKey).join(' and ')}`;
    return queued.length ? 'Getting the next ticket ready' : 'All tickets handled';
  })();

  const stop = async () => {
    const ok = await confirm({
      title: 'Stop this scheduled run?',
      message: 'The tickets in progress are cancelled and tickets that have not started are skipped.',
      confirmLabel: 'Stop run',
      danger: true
    });
    if (ok) await act(() => api.cancel(run.id));
  };

  const beads = run.entries.map(entry => ({
    key: entry.id,
    issueKey: entry.ticket.issueKey,
    title: entry.ticket.title,
    step: steps.get(entry.id) ?? 1,
    state: entryBeadState(entry, pause?.entryId)
  }));

  return (
    <div className="view-scroll schedule-page schedule-monitor spot" data-testid="schedule-monitor" data-status={run.status}>
      <header className="spot-head">
        <div className="spot-head-main">
          <div className="spot-head-meta">
            <button type="button" className="btn btn-icon" aria-label="Back to scheduled runs" data-testid="schedule-monitor-back" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
            <span className={`spot-pill spot-pill--${run.status}`} data-testid="schedule-monitor-status">{STATUS_LABEL[run.status]}</span>
            <span className="spot-head-sub">
              {run.name}
              {parallel && <> · <span data-testid="schedule-lanes-in-use">{flying.length} of up to {cap} lanes in use</span></>}
              {started && <> · started {formatHourMinute(started, tz)}</>}
            </span>
          </div>
          <h2 className="spot-headline">{headline}</h2>
        </div>
        <div className="spot-head-clock" data-testid="schedule-forecast">
          {forecast?.likelyFinishAt ? (
            <>
              <span className="spot-clock">{formatHourMinute(forecast.likelyFinishAt, tz)}</span>
              <span className="spot-clock-sub">likely done{forecast.slowFinishAt && forecast.slowFinishAt !== forecast.likelyFinishAt ? ` · could run to ${formatHourMinute(forecast.slowFinishAt, tz)}` : ''}{spendSoFar ? ` · ${spendSoFar} so far` : ''}</span>
            </>
          ) : (
            <span className="spot-clock-sub" title={forecast?.notEstimable}>{spendSoFar ? `${spendSoFar} so far` : 'No forecast yet'}</span>
          )}
        </div>
        <div className="schedule-head-actions">
          {onShowReport && <button type="button" className="btn" data-testid="schedule-show-report" onClick={onShowReport}>Report so far</button>}
          {run.status === 'running' && <button type="button" className="btn" data-testid="schedule-pause" disabled={busy} onClick={() => void act(() => api.pause(run.id))}>Pause</button>}
          {pause && !['failure', 'approval', 'launch-interrupted'].includes(pause.reason) && (
            <button type="button" className="btn btn-primary" data-testid="schedule-resume" disabled={busy} onClick={() => void act(() => api.resume(run.id))}>Resume</button>
          )}
          <button type="button" className="btn" data-testid="schedule-stop" disabled={busy} onClick={() => void stop()}>Stop run</button>
        </div>
      </header>

      {error && <div className="schedule-error" role="alert" data-testid="schedule-error">{error}</div>}

      {pause && (
        <div className="schedule-pause-banner" role="status" data-testid="schedule-pause-banner" data-reason={pause.reason}>
          <Icon name="warning" size={14} />
          <span><strong>{PAUSE_TITLE[pause.reason]}</strong> {pause.message}</span>
          {pause.reason === 'trust' && run.projectId && run.policy.workflowId && (
            <span className="schedule-pause-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="schedule-trust-workflow"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    // Shows the workflow's exact commands first; Cancel leaves it untrusted and paused.
                    await confirmProjectWorkflowTrust(run.projectId!, run.policy.workflowId!, confirm);
                    return api.resume(run.id);
                  })
                }
              >
                Review and trust workflow
              </button>
            </span>
          )}
        </div>
      )}

      <BeadRail beads={beads} />

      <section className={`spot-stage${parallel ? ' is-parallel' : ''}`} aria-label="Run progress" data-testid="schedule-line">
        <div className="spot-col spot-col--deck">
          <h3 className="spot-col-title">Up next <span>{queued.length}</span></h3>
          <ol className="spot-deck" data-testid="schedule-deck">
            {queued.map((entry, index) => (
              <li key={entry.id} className={`spot-deck-card${index === 0 ? ' is-next' : ''}${pause?.entryId === entry.id ? ' is-held' : ''}`} data-testid="schedule-deck-card" data-issue={entry.ticket.issueKey} data-entry-status="queued">
                <div className="spot-card-top"><span className="spot-key">{entry.ticket.issueKey}</span><span className="spot-step">step {steps.get(entry.id)}</span></div>
                <span className="spot-deck-title" title={entry.ticket.title}>{entry.ticket.title}</span>
                <span className="spot-wait" data-testid="schedule-wait-reason">{waitReason(entry)}</span>
                {pause?.entryId === entry.id && (
                  <div className="spot-decide">
                    <button type="button" className="btn" data-testid="schedule-skip-entry" disabled={busy} onClick={() => void act(() => api.skipEntry(run.id, entry.id))}>Skip ticket</button>
                  </div>
                )}
              </li>
            ))}
            {queued.length === 0 && <li className="spot-empty">Nothing waiting</li>}
          </ol>
        </div>

        <div className="spot-col spot-col--flight">
          <h3 className="spot-col-title">In flight <span>{flying.length}</span></h3>
          <div className="spot-flight" style={{ ['--spot-lanes' as string]: Math.max(1, Math.min(cap, Math.max(flying.length, 1))) }}>
            {flying.map(entry => (
              <FlightCard
                key={entry.id}
                entry={entry}
                live={lives.find(item => item.entryId === entry.id)}
                step={steps.get(entry.id) ?? 1}
                parallel={parallel}
                pauseReason={pause?.entryId === entry.id ? pause.reason : undefined}
                now={now}
                busy={busy}
                onApprove={() => void act(() => api.approveGate(run.id, entry.id))}
                onRetry={live => void act(() => live?.recovery ? window.praxis.workflows.retryStage(live.workflowRunId, live.recovery.nodeId) : api.retryEntry(run.id, entry.id))}
                onSkip={() => void act(() => api.skipEntry(run.id, entry.id))}
                onOpenWorkflowRun={onOpenWorkflowRun}
              />
            ))}
            {flying.length === 0 && (
              <div className="spot-flight-empty" data-testid="schedule-flight-empty">
                {run.status === 'completed' ? 'All tickets handled' : pause ? 'Nothing is running while the run waits.' : 'Getting the next ticket ready'}
              </div>
            )}
          </div>
        </div>

        <div className="spot-col spot-col--receipts">
          <h3 className="spot-col-title">Delivered <span>{finished.filter(entry => statusOf(entry) === 'done').length}</span></h3>
          <ol className="spot-receipts" data-testid="schedule-receipts">
            {finished.map(entry => (
              <li key={entry.id} className={`spot-receipt spot-receipt--${statusOf(entry)}`} data-testid="schedule-receipt" data-issue={entry.ticket.issueKey} data-entry-status={statusOf(entry)}>
                <div className="spot-card-top">
                  <span className="spot-key">{entry.ticket.issueKey}</span>
                  <span className={`spot-stamp spot-stamp--${statusOf(entry)}`}>{ENTRY_STATUS_LABEL[statusOf(entry)]}</span>
                </div>
                <span className="spot-deck-title" title={entry.ticket.title}>{entry.ticket.title}</span>
                <span className="spot-receipt-meta">
                  {[formatSpan(entry.outcome?.startedAt, entry.outcome?.endedAt), entry.outcome?.spend ? formatSpend(entry.outcome.spend) : '', statusOf(entry) === 'skipped' ? entry.outcome?.reason ?? '' : ''].filter(Boolean).join(' · ')}
                </span>
                {entry.outcome?.workflowRunId && onOpenWorkflowRun && (
                  <button type="button" className="btn btn-link spot-receipt-open" onClick={() => onOpenWorkflowRun(entry.outcome!.workflowRunId!)}>Open run</button>
                )}
              </li>
            ))}
            {finished.length === 0 && <li className="spot-empty">None yet</li>}
          </ol>
        </div>
      </section>

      <footer className="spot-foot">
        <section className="spot-allowance" aria-label="Provider allowance" data-testid="schedule-budget">
          <h3 className="spot-col-title">Provider allowance <span>work moves to another provider at {handoverPercent}%</span></h3>
          {headroom.length > 0 ? (
            <ul className="spot-allowance-list">
              {headroom.map(item => {
                const used = item.usedFraction === undefined ? undefined : Math.round(item.usedFraction * 100);
                return (
                  <li key={item.provider} data-provider={item.provider} className={used !== undefined && used >= handoverPercent ? 'is-full' : undefined}>
                    <span className="spot-allowance-name">{item.provider}</span>
                    {used === undefined ? (
                      <span className="spot-allowance-unknown">not reported</span>
                    ) : (
                      <>
                        <span className="spot-allowance-bar" role="progressbar" aria-label={`${item.provider} allowance used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
                          <span style={{ width: `${Math.min(100, used)}%` }} />
                          <i style={{ left: `${handoverPercent}%` }} aria-hidden="true" />
                        </span>
                        <span>{used}% used</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : <p className="schedule-hint">No provider reports its allowance right now.</p>}
        </section>
        <section className="spot-activity-panel" aria-label="Activity">
          <h3 className="spot-col-title">Activity</h3>
          <ol className="schedule-log spot-log" data-testid="schedule-activity">
            {[...run.events].reverse().slice(0, 40).map((event, index) => (
              <li key={`${event.at}-${index}`} data-kind={event.kind}><time dateTime={event.at}>{formatClock(event.at)}</time> {event.message}</li>
            ))}
          </ol>
        </section>
      </footer>
    </div>
  );
}

interface FlightCardProps {
  entry: ScheduledQueueEntry;
  live?: ScheduledRunLive;
  step: number;
  parallel: boolean;
  pauseReason?: string;
  now: number;
  busy: boolean;
  onApprove: () => void;
  onRetry: (live?: ScheduledRunLive) => void;
  onSkip: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
}

/** One ticket in flight: its agent tasks, what the running one is doing, and any decision it needs. */
function FlightCard({ entry, live, step, parallel, pauseReason, now, busy, onApprove, onRetry, onSkip, onOpenWorkflowRun }: FlightCardProps) {
  const outcome = entry.outcome;
  const status = outcome?.status ?? 'running';
  const stages: ScheduledStageDetail[] = live?.stages ?? [];
  const running = stages.find(stage => stage.activity) ?? stages.find(stage => stage.lane === 'running');
  const atGate = !!outcome?.gate;
  const failed = status === 'failed' || pauseReason === 'failure' || pauseReason === 'launch-interrupted';
  const tokens = stages.reduce((sum, stage) => sum + (stage.tokens ?? 0), 0);
  const handover = outcome?.handovers?.[outcome.handovers.length - 1];
  const tone = atGate ? 'waiting' : failed ? 'failed' : status;
  return (
    <article className={`spot-card spot-card--${tone}`} data-testid="schedule-flight-card" data-issue={entry.ticket.issueKey} data-entry-status={status} data-lane={outcome?.lane ?? 1} aria-label={`${entry.ticket.issueKey} ${entry.ticket.title}`}>
      <div className="spot-card-top">
        <span className="spot-key spot-key--strong">{entry.ticket.issueKey}</span>
        {parallel && <span className="spot-chip">lane {outcome?.lane ?? 1}</span>}
        <span className="spot-chip">step {step}</span>
        <span className="spot-grow" />
        {outcome?.provider && <span className="spot-chip spot-chip--provider" data-testid="schedule-proc-provider">{outcome.provider}</span>}
      </div>
      <h4 className="spot-card-title" title={entry.ticket.title}>{entry.ticket.title}</h4>
      {handover && <p className="spot-note spot-note--handover">Handed over {handover.from} → {handover.to} at {Math.round(handover.usedPercent)}%{handover.checkpointRef ? ` · checkpoint ${handover.checkpointRef.slice(0, 8)}` : ''}</p>}
      {outcome?.laneReason && <p className="spot-note" data-testid="schedule-lane-reason">Why now: {outcome.laneReason}</p>}

      {stages.length > 0 ? <TaskRows stages={stages} now={now} /> : <p className="spot-note">{live?.stageLabel ?? 'Starting the workflow…'}</p>}

      {running?.activity && (
        <p className="spot-now" data-testid="schedule-activity-line" title={running.activity.text}>
          <span className="spot-now-label">{running.name}</span>
          <span key={running.activity.text} className="spot-typed">{running.activity.text}</span>
        </p>
      )}

      {live?.recovery && (
        <div className="spot-failure" data-testid="schedule-stage-failure">
          <strong>{live.stageLabel}</strong>
          <span> · Attempt {live.recovery.attempts}{live.recovery.maxAttempts ? ` of ${live.recovery.maxAttempts}` : ''}</span>
          {live.recovery.error && <pre className="schedule-failure-detail">{live.recovery.error}</pre>}
          <p className="schedule-hint">Retry continues this workflow in its existing worktree. Completed stages are kept. Waiting tickets stay queued.</p>
        </div>
      )}

      {atGate && (
        <div className="spot-decide">
          <span className="spot-decide-label">Waiting for approval: {outcome?.gate?.label}</span>
          <button type="button" className="btn btn-primary" data-testid="schedule-approve" disabled={busy} onClick={onApprove}>Approve</button>
          {outcome?.workflowRunId && onOpenWorkflowRun && <button type="button" className="btn" data-testid="schedule-open-workflow" onClick={() => onOpenWorkflowRun(outcome.workflowRunId!)}>Open run</button>}
        </div>
      )}
      {!atGate && failed && (
        <div className="spot-decide">
          <button type="button" className="btn btn-primary" data-testid="schedule-retry" disabled={busy} onClick={() => onRetry(live)}>{live?.recovery ? 'Retry stage' : 'Retry ticket'}</button>
          <button type="button" className="btn" data-testid="schedule-skip-entry" disabled={busy} onClick={onSkip}>Skip</button>
        </div>
      )}

      <div className="spot-card-foot">
        <span>{outcome?.startedAt ? formatMs(now - Date.parse(outcome.startedAt)) : ''}</span>
        {tokens > 0 && <span>{formatTokens(tokens)} tokens</span>}
        {outcome?.spend?.cost !== undefined && <span>{formatMoney(outcome.spend.cost, outcome.spend.currency)}</span>}
        <span className="spot-grow" />
        {outcome?.workflowRunId && onOpenWorkflowRun && (
          <button type="button" className="btn btn-link" data-testid="schedule-review-workflow" onClick={() => onOpenWorkflowRun(outcome.workflowRunId!)}>Open workflow and logs</button>
        )}
      </div>
    </article>
  );
}

