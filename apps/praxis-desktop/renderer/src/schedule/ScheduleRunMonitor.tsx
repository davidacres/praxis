import { useState } from 'react';
import type { ScheduledQueueEntry, ScheduledRunView } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { useSettings } from '../settings/useSettings';
import { DEFAULT_APP_SETTINGS } from '../settings/settingsDefaults';
import { ENTRY_STATUS_LABEL, STATUS_LABEL, formatClock, formatSpend } from './scheduleFormat';

/**
 * The live view of a running or paused scheduled run (FX-BF-047 / FX-BE-173 / TASK-465).
 *
 * Tickets wait on the belt, the one being worked on sits in the processor, and
 * finished ones collect in the Done tray. Everything shown is what the runner has
 * recorded: the progress bar is the workflow's own stage count, and nothing
 * animates beyond that. When a ticket needs a person (an approval gate, a failure,
 * a budget stop) the processor stops, turns to the warning tone and says what is
 * waiting, with the decision right there.
 */
interface ScheduleRunMonitorProps {
  view: ScheduledRunView;
  onBack: () => void;
  onOpenWorkflowRun?: (workflowRunId: string) => void;
}

export function ScheduleRunMonitor({ view, onBack, onOpenWorkflowRun }: ScheduleRunMonitorProps) {
  const { run, live } = view;
  const headroom = view.headroom ?? live?.headroom ?? [];
  const { confirm } = useDialogs();
  const handoverPercent = useSettings().settings?.ai.providerHandoverPercent ?? DEFAULT_APP_SETTINGS.ai.providerHandoverPercent;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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

  const queued = run.entries.filter(entry => (entry.outcome?.status ?? 'queued') === 'queued');
  const actives = run.entries.filter(entry => entry.outcome?.status === 'running' || entry.outcome?.status === 'paused' || entry.outcome?.status === 'failed');
  const done = run.entries.filter(entry => entry.outcome?.status === 'done' || entry.outcome?.status === 'skipped');
  const pause = run.status === 'paused' ? run.pause : undefined;
  // With parallel lanes several tickets can be active; the processor shows the one the pause is about.
  const active = actives.find(entry => entry.id === pause?.entryId) ?? actives[0];
  const parallel = run.policy.mode === 'parallel';
  // A ticket that could not be launched is put back on the belt, so the pause names it rather than an active entry.
  const pausedOn = pause?.entryId ? run.entries.find(entry => entry.id === pause.entryId && !['done', 'skipped'].includes(entry.outcome?.status ?? 'queued')) : undefined;
  const atGate = !!active?.outcome?.gate;
  const waiting = !!pause;

  const stop = async () => {
    const ok = await confirm({
      title: 'Stop this scheduled run?',
      message: 'The ticket in progress is cancelled and tickets that have not started are skipped.',
      confirmLabel: 'Stop run',
      danger: true
    });
    if (ok) await act(() => api.cancel(run.id));
  };

  return (
    <div className="view-scroll schedule-page schedule-monitor" data-testid="schedule-monitor" data-status={run.status}>
      <header className="schedule-head">
        <div className="schedule-compose-title">
          <button type="button" className="btn btn-icon" aria-label="Back to scheduled runs" data-testid="schedule-monitor-back" onClick={onBack}><Icon name="arrow-left" size={14} /></button>
          <h2 className="schedule-title">{run.name}</h2>
          <span className={`schedule-status schedule-status--${run.status}`} data-testid="schedule-monitor-status">{STATUS_LABEL[run.status]}</span>
        </div>
        <div className="schedule-head-actions">
          {run.status === 'running' && <button type="button" className="btn" data-testid="schedule-pause" disabled={busy} onClick={() => void act(() => api.pause(run.id))}>Pause</button>}
          {run.status === 'paused' && pause && !['failure', 'approval', 'launch-interrupted'].includes(pause.reason) && (
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
          {active && (pause.reason === 'failure' || pause.reason === 'launch-interrupted') && (
            <span className="schedule-pause-actions">
              <button type="button" className="btn btn-primary" data-testid="schedule-retry" disabled={busy} onClick={() => void act(() => live?.recovery ? window.praxis.workflows.retryStage(live.workflowRunId, live.recovery.nodeId) : api.retryEntry(run.id, active.id))}>{live?.recovery ? 'Retry stage' : 'Retry ticket'}</button>
              <button type="button" className="btn" data-testid="schedule-skip-entry" disabled={busy} onClick={() => void act(() => api.skipEntry(run.id, active.id))}>Skip</button>
            </span>
          )}
          {active && atGate && (
            <span className="schedule-pause-actions">
              <button type="button" className="btn btn-primary" data-testid="schedule-approve" disabled={busy} onClick={() => void act(() => api.approveGate(run.id, active.id))}>Approve</button>
              {active.outcome?.workflowRunId && onOpenWorkflowRun && (
                <button type="button" className="btn" data-testid="schedule-open-workflow" onClick={() => onOpenWorkflowRun(active.outcome!.workflowRunId!)}>Open run</button>
              )}
            </span>
          )}
          {pausedOn && !(active && (pause.reason === 'failure' || pause.reason === 'launch-interrupted')) && !atGate && (
            <span className="schedule-pause-actions">
              <button type="button" className="btn" data-testid="schedule-skip-entry" disabled={busy} onClick={() => void act(() => api.skipEntry(run.id, pausedOn.id))}>Skip ticket</button>
            </span>
          )}
        </div>
      )}

      {active?.outcome?.workflowRunId && onOpenWorkflowRun && <div className="schedule-head-actions">
        <button type="button" className="btn" data-testid="schedule-review-workflow" onClick={() => onOpenWorkflowRun(active.outcome!.workflowRunId!)}>Open workflow and logs</button>
      </div>}
      {live?.recovery && <section className="schedule-panel" aria-label="Stage failure" data-testid="schedule-stage-failure">
        <h3 className="schedule-panel-title">Stage needs attention</h3>
        <p>{live.stageLabel} · Attempt {live.recovery.attempts}{live.recovery.maxAttempts ? ` of ${live.recovery.maxAttempts}` : ''}</p>
        {live.recovery.error && <pre className="schedule-failure-detail">{live.recovery.error}</pre>}
        <p className="schedule-hint">Retry continues this workflow in its existing worktree. Completed stages are kept. Remaining attempts do not start automatically. Waiting tickets stay queued.</p>
      </section>}

      <section className="schedule-line" aria-label="Run progress" data-testid="schedule-line">
        <div className="schedule-line-col">
          <h3 className="schedule-panel-title">Belt <span className="schedule-panel-note">{queued.length} waiting</span></h3>
          <ol className="schedule-line-list" data-testid="schedule-belt">
            {queued.map(entry => <EntryChip key={entry.id} entry={entry} />)}
            {queued.length === 0 && <li className="schedule-chip schedule-chip--empty">Nothing waiting</li>}
          </ol>
        </div>

        <div className={`schedule-proc${waiting ? ' is-waiting' : ''}${run.status === 'running' && active ? ' is-working' : ''}`} data-testid="schedule-processor" data-state={waiting ? 'waiting' : active ? 'working' : 'idle'}>
          <h3 className="schedule-panel-title">Processor</h3>
          {active ? (
            <>
              <div className="schedule-proc-ticket">
                <span className="schedule-chip-key">{active.ticket.issueKey}</span>
                <strong>{active.ticket.title}</strong>
              </div>
              <div className="schedule-proc-state" data-testid="schedule-proc-state">
                {atGate ? `Waiting for approval: ${active.outcome?.gate?.label}` : live ? `${live.stageLabel}` : ENTRY_STATUS_LABEL[active.outcome?.status ?? 'queued']}
              </div>
              {live && live.stageCount > 0 && live.entryId === active.id && (
                <>
                  <div className="schedule-progress" role="progressbar" aria-label="Stages completed" aria-valuemin={0} aria-valuemax={live.stageCount} aria-valuenow={live.stageIndex}>
                    <span style={{ width: `${Math.min(100, (live.stageIndex / live.stageCount) * 100)}%` }} />
                  </div>
                  <div className="schedule-proc-meta">Stage {live.stageIndex} of {live.stageCount}</div>
                </>
              )}
              <div className="schedule-proc-meta" data-testid="schedule-proc-provider">
                {active.outcome?.provider ? `On ${active.outcome.provider}` : 'Provider not reported yet'}
                {' · '}{formatSpend(active.outcome?.spend)}
              </div>
            </>
          ) : (
            <div className="schedule-proc-state">{run.status === 'completed' ? 'All tickets handled' : 'Getting the next ticket ready'}</div>
          )}
        </div>

        <div className="schedule-line-col">
          <h3 className="schedule-panel-title">Done <span className="schedule-panel-note">{done.length}</span></h3>
          <ol className="schedule-line-list" data-testid="schedule-done-tray">
            {done.map(entry => <EntryChip key={entry.id} entry={entry} />)}
            {done.length === 0 && <li className="schedule-chip schedule-chip--empty">None yet</li>}
          </ol>
        </div>
      </section>

      {parallel && <LanesPanel view={view} actives={actives} queued={queued} />}

      <section className="schedule-panel" aria-label="Provider allowance" data-testid="schedule-budget">
        <h3 className="schedule-panel-title">Provider allowance <span className="schedule-panel-note">work moves to another provider at {handoverPercent}%</span></h3>
        {headroom.length > 0 ? (
          <ul className="schedule-budget-list">
            {headroom.map(item => (
              <li key={item.provider} data-provider={item.provider}>
                <span className="schedule-budget-name">{item.provider}</span>
                {item.usedFraction === undefined ? (
                  <span className="schedule-budget-unknown">Not reported · remaining unknown</span>
                ) : (
                  <>
                    <span className="schedule-progress schedule-progress--small" role="progressbar" aria-label={`${item.provider} allowance used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.usedFraction * 100)}>
                      <span className={item.usedFraction * 100 >= handoverPercent ? 'is-full' : undefined} style={{ width: `${Math.min(100, item.usedFraction * 100)}%` }} />
                    </span>
                    <span>{Math.round(item.usedFraction * 100)}% used</span>
                    <span className="schedule-budget-left">{Math.max(0, handoverPercent - Math.round(item.usedFraction * 100))}% left before hand-over</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="schedule-hint">No provider reports its allowance right now.</p>}
      </section>

      <section className="schedule-panel" aria-label="Activity" data-testid="schedule-activity">
        <h3 className="schedule-panel-title">Activity</h3>
        <ol className="schedule-log">
          {[...run.events].reverse().map((event, index) => (
            <li key={`${event.at}-${index}`} data-kind={event.kind}><time dateTime={event.at}>{formatClock(event.at)}</time> {event.message}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * Parallel runs only (FX-BE-149): which ticket holds which lane and why it was
 * allowed to run alongside the others, and why each waiting ticket is waiting.
 * Everything here is what the runner recorded; nothing is inferred live.
 */
function LanesPanel({ view, actives, queued }: { view: ScheduledRunView; actives: ScheduledQueueEntry[]; queued: ScheduledQueueEntry[] }) {
  const { run } = view;
  const cap = run.policy.mode === 'parallel' ? run.policy.maxConcurrency : 1;
  const stepOf = new Map<string, number>();
  let step = 0;
  run.entries.forEach((entry, index) => { if (index === 0 || !entry.withPrevious) step += 1; stepOf.set(entry.id, step); });
  const current = run.entries.find(entry => !['done', 'skipped'].includes(entry.outcome?.status ?? 'queued'));
  const currentStep = current ? stepOf.get(current.id) : undefined;
  const why = (entry: ScheduledQueueEntry): string => {
    const own = stepOf.get(entry.id);
    if (currentStep !== undefined && own !== undefined && own > currentStep) return `Waits for step ${currentStep} to finish.`;
    if (run.status === 'paused') return 'Waits until the run continues.';
    const last = [...run.events].reverse().find(event => event.entryId === entry.id && event.kind === 'budget-checked');
    if (last && /\bwaits\b/.test(last.message)) return last.message;
    return actives.length >= cap ? `Waits for a free lane (${cap} in use).` : 'Next to start.';
  };
  const lanes = [...actives].sort((a, b) => (a.outcome?.lane ?? 99) - (b.outcome?.lane ?? 99));
  return (
    <section className="schedule-panel" aria-label="Lanes" data-testid="schedule-lanes-panel">
      <h3 className="schedule-panel-title">Lanes <span className="schedule-panel-note">{actives.length} of up to {cap} in use</span></h3>
      <ol className="schedule-lanes">
        {lanes.map(entry => (
          <li key={entry.id} className={`schedule-lane schedule-lane--${entry.outcome?.status}`} data-testid="schedule-lane" data-issue={entry.ticket.issueKey} data-lane={entry.outcome?.lane}>
            <span className="schedule-lane-number">Lane {entry.outcome?.lane ?? '–'}</span>
            <span className="schedule-lane-main">
              <span className="schedule-chip-key">{entry.ticket.issueKey} · {ENTRY_STATUS_LABEL[entry.outcome?.status ?? 'queued']} · step {stepOf.get(entry.id)}</span>
              <strong className="schedule-chip-title">{entry.ticket.title}</strong>
              {entry.outcome?.laneReason && <span className="schedule-lane-reason" data-testid="schedule-lane-reason">Why now: {entry.outcome.laneReason}</span>}
            </span>
            <span className="schedule-lane-meta">{entry.outcome?.provider ?? 'Provider not reported'} · {formatSpend(entry.outcome?.spend)}</span>
          </li>
        ))}
        {lanes.length === 0 && <li className="schedule-chip schedule-chip--empty">No ticket is running</li>}
      </ol>
      {queued.length > 0 && <>
        <h4 className="schedule-panel-title schedule-lanes-sub">Waiting</h4>
        <ul className="schedule-lanes-waiting" data-testid="schedule-lanes-waiting">
          {queued.map(entry => (
            <li key={entry.id} data-issue={entry.ticket.issueKey}><span className="schedule-chip-key">{entry.ticket.issueKey}</span> {why(entry)}</li>
          ))}
        </ul>
      </>}
    </section>
  );
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

function EntryChip({ entry }: { entry: ScheduledQueueEntry }) {
  const status = entry.outcome?.status ?? 'queued';
  return (
    <li className={`schedule-chip schedule-chip--${status}`} data-issue={entry.ticket.issueKey} data-entry-status={status}>
      <span className="schedule-chip-seq">{entry.sequence}</span>
      <span className="schedule-chip-text">
        <span className="schedule-chip-key">{entry.ticket.issueKey} · {ENTRY_STATUS_LABEL[status]}</span>
        <span className="schedule-chip-title" title={entry.ticket.title}>{entry.ticket.title}</span>
      </span>
    </li>
  );
}
