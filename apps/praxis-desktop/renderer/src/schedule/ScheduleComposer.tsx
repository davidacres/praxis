import { createPortal } from 'react-dom';
import { ScheduleTickets, expandScheduleTickets, type Candidate } from './ScheduleTickets';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { ProjectRecord, SaveScheduledRunInput, ScheduledRunReadiness, ScheduledRunView, ScheduledTicketRef, ScheduledWorkflowChoice } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { useSettings } from '../settings/useSettings';
import { DEFAULT_APP_SETTINGS } from '../settings/settingsDefaults';
import { condenseIssues, localTimeZone, timeZoneOptions, tomorrowDate } from './scheduleFormat';
import { ScheduleFlowGraph } from './ScheduleFlowGraph';
import { flattenSteps, flowKey, moveEarlier, moveLater, placeTickets, removeTicket, stepsFromEntries, toggleTogether, type FlowSteps, type FlowTarget } from './scheduleFlow';

/**
 * The scheduled-run composer (FX-BF-047 / FX-BE-147 / TASK-384).
 *
 * Tickets are picked from the sidebar and dropped on a flow graph drawn like the
 * Task Designer: steps run left to right, linked by arrows, and tickets dropped
 * onto another ticket share its step (drawn as parallel lanes). The order is kept
 * on the schedule and never on the board. Dragging is an enhancement: every move
 * has a button, so the order can be built entirely from the keyboard.
 *
 * All the rules — what a valid start time is, what arming needs, what is
 * blocking — are decided in main by core's `composeScheduledRun`; this component
 * only collects the form and shows `preview`'s answer.
 */
interface ScheduleComposerProps {
  project: ProjectRecord;
  ticketHost: HTMLElement | null;
  candidates?: Candidate[];
  loadError: string;
  initial?: ScheduledRunView;
  onClose: () => void;
  onSaved: (startedRunId?: string) => void;
  initialTicketKeys?: string[];
  autoAddSelectedTickets?: boolean;
}

function refOf(candidate: Candidate): ScheduledTicketRef {
  return { connectionId: candidate.connectionId, issueKey: candidate.key, title: candidate.title };
}

const sameTicket = (a: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>, b: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>) =>
  a.connectionId === b.connectionId && a.issueKey === b.issueKey;
const SCHEDULE_TICKET_DRAG_TYPE = 'application/x-praxis-schedule-ticket';

export function ScheduleComposer({ project, ticketHost, candidates, loadError, initial, onClose, onSaved, initialTicketKeys = [], autoAddSelectedTickets = false }: ScheduleComposerProps) {
  const handoverPercent = useSettings().settings?.ai.providerHandoverPercent ?? DEFAULT_APP_SETTINGS.ai.providerHandoverPercent;
  const [name, setName] = useState(initial?.run.name ?? 'Scheduled run');
  const [date, setDate] = useState(initial?.start.date || tomorrowDate());
  const [time, setTime] = useState(initial?.start.time || '22:00');
  const [timezone, setTimezone] = useState(initial?.run.timezone ?? localTimeZone());
  const [workflowId, setWorkflowId] = useState(initial?.run.policy.workflowId ?? '');
  // FX-BE-149: one at a time unless the user deliberately picks more. Kept as a string for the chip.
  const [lanes, setLanes] = useState(String(initial?.run.policy.mode === 'parallel' ? initial.run.policy.maxConcurrency : 1));
  const [workflowChoices, setWorkflowChoices] = useState<ScheduledWorkflowChoice[]>([]);
  const [steps, setSteps] = useState<FlowSteps>(() => stepsFromEntries(initial?.run.entries ?? []));
  const [preview, setPreview] = useState<{ readiness?: ScheduledRunReadiness; error?: string }>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justAdded, setJustAdded] = useState<string>();
  const dragging = useRef<{ from: 'hopper' | 'belt'; key: string }>();
  const [dropTarget, setDropTarget] = useState<FlowTarget>();
  const autoAddStarted = useRef(false);
  const ticketsSeeded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.scheduledRuns.workflowChoices(project.id).then(({ choices, defaultWorkflowId }) => {
      if (cancelled) return;
      setWorkflowChoices(choices);
      setWorkflowId(current => current || defaultWorkflowId || '');
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [project.id]);

  useEffect(() => {
    if (!initialTicketKeys.length || !candidates) return;
    const selected = expandScheduleTickets(candidates, candidates.filter(candidate => initialTicketKeys.includes(candidate.key))).map(refOf);
    if (autoAddSelectedTickets) {
      if (autoAddStarted.current) return;
      autoAddStarted.current = true;
      const queued = initial?.run.entries.map(entry => ({ ...entry.ticket })) ?? [];
      const next = [...queued];
      for (const ticket of selected) {
        if (!next.some(existing => sameTicket(existing, ticket))) next.push(ticket);
      }
      if (next.length === queued.length) {
        if (initial) { onSaved(); return; }
        setSaveError('None of the selected tickets are available to add to a new schedule.');
        return;
      }
      setSaving(true);
      const saveInput: SaveScheduledRunInput = {
        id: initial?.run.id,
        projectId: project.id,
        name: initial?.run.name ?? 'Scheduled run',
        date: initial?.start.date || tomorrowDate(),
        time: initial?.start.time || '22:00',
        timezone: initial?.run.timezone ?? localTimeZone(),
        tickets: next,
        arm: false
      };
      void window.praxis.scheduledRuns.save(saveInput).then(() => onSaved()).catch(reason => {
        setSaveError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        autoAddStarted.current = false;
      }).finally(() => setSaving(false));
      return;
    }
    if (ticketsSeeded.current) return;
    ticketsSeeded.current = true;
    setSteps(current => {
      const queued = new Set(current.flat().map(flowKey));
      const fresh = selected.filter(ticket => !queued.has(flowKey(ticket)));
      return fresh.length ? placeTickets(current, fresh, { kind: 'gap', step: current.length }) : current;
    });
  }, [autoAddSelectedTickets, candidates, initial?.run.id, initial?.run.name, initial?.run.timezone, initial?.run.entries, initial?.start.date, initial?.start.time, initialTicketKeys.join('\0'), onSaved, project.id]);

  const belt = useMemo(() => flattenSteps(steps), [steps]);
  const input: SaveScheduledRunInput = useMemo(
    () => ({ id: initial?.run.id, projectId: project.id, name, date, time, timezone, tickets: belt.tickets, withPrevious: belt.withPrevious, maxConcurrency: Number(lanes), arm: false, ...(workflowId ? { workflowId } : {}) }),
    [initial?.run.id, project.id, name, date, time, timezone, belt, workflowId, lanes]
  );

  // Readiness is derived from the live board in main, so ask it as the form changes.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void window.praxis.scheduledRuns.preview(input).then(result => {
        if (current) setPreview(result);
      });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [input]);

  const onBelt = (candidate: Candidate) => belt.tickets.some(ticket => sameTicket(ticket, { connectionId: candidate.connectionId, issueKey: candidate.key }));
  const flash = (issueKey: string) => {
    setJustAdded(issueKey);
    window.setTimeout(() => setJustAdded(current => (current === issueKey ? undefined : current)), 700);
  };
  /** Adds new tickets at a target (the end by default); tickets already in the run stay where they are. */
  const addTickets = (tickets: ScheduledTicketRef[], target?: FlowTarget) => {
    setSteps(current => {
      const queued = new Set(current.flat().map(flowKey));
      const fresh = tickets.filter(ticket => !queued.has(flowKey(ticket)));
      return fresh.length ? placeTickets(current, fresh, target ?? { kind: 'gap', step: current.length }) : current;
    });
    if (tickets[0]) flash(tickets[0].issueKey);
  };
  const addCandidate = (candidate: Candidate, target?: FlowTarget) => addTickets(expandScheduleTickets(candidates ?? [], [candidate]).map(refOf), target);

  const dropAt = (target: FlowTarget, dataTransfer?: DataTransfer) => {
    let drag = dragging.current;
    if (!drag && dataTransfer) {
      try {
        const payload = JSON.parse(dataTransfer.getData(SCHEDULE_TICKET_DRAG_TYPE)) as Partial<{ from: 'hopper' | 'belt'; key: string }>;
        if ((payload.from === 'hopper' || payload.from === 'belt') && typeof payload.key === 'string') drag = payload as { from: 'hopper' | 'belt'; key: string };
      } catch { /* Fall back to the in-memory drag state when custom data is unavailable. */ }
    }
    dragging.current = undefined;
    setDropTarget(undefined);
    if (!drag) return;
    if (drag.from === 'belt') {
      const ticket = belt.tickets.find(item => flowKey(item) === drag.key);
      if (ticket) setSteps(current => placeTickets(current, [ticket], target));
      return;
    }
    const candidate = (candidates ?? []).find(item => `${item.connectionId}\u0000${item.key}` === drag.key);
    if (candidate) addCandidate(candidate, target);
  };

  /**
   * The target under a point: a ticket or step joins it, an arrow is a new step
   * there, and anywhere else on the Run order panel adds a step at the end.
   */
  const targetAt = (point: { x: number; y: number }): FlowTarget | undefined => {
    const element = document.elementFromPoint(point.x, point.y);
    if (!element?.closest('.schedule-stage')) return undefined;
    const gapAt = element.closest<HTMLElement>('[data-flow-gap]');
    if (gapAt) return { kind: 'gap', step: Number(gapAt.dataset.flowGap) };
    const joinAt = element.closest<HTMLElement>('[data-flow-join]');
    if (joinAt) return { kind: 'join', step: Number(joinAt.dataset.flowJoin) };
    return { kind: 'gap', step: steps.length };
  };
  const sameTarget = (a?: FlowTarget, b?: FlowTarget) => a?.kind === b?.kind && a?.step === b?.step;
  const hover = (next?: FlowTarget) => setDropTarget(current => (sameTarget(current, next) ? current : next));
  const acceptsDrag = (event: DragEvent) => !!dragging.current || Array.from(event.dataTransfer.types).includes(SCHEDULE_TICKET_DRAG_TYPE);

  const readiness = preview.readiness;
  const blockers = readiness?.issues.filter(issue => issue.severity === 'blocker') ?? [];
  const count = belt.tickets.length;
  const canSchedule = !!readiness && readiness.ready && count > 0 && !preview.error;
  const armedLabel = (() => {
    const when = new Date(`${date}T00:00:00`);
    if (!date || !time || Number.isNaN(when.getTime())) return undefined;
    return {
      time,
      day: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(when)
    };
  })();

  const save = async (arm: boolean, startNow = false) => {
    setSaving(true);
    setSaveError('');
    try {
      const saved = await window.praxis.scheduledRuns.save({ ...input, arm, ...(startNow ? { startNow } : {}) });
      onSaved(startNow ? saved.run.id : undefined);
    } catch (reason) {
      setSaveError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  };

  const stepCount = steps.length;
  const sharedSteps = steps.filter(step => step.length > 1).length;
  const startLabel = armedLabel ? `${armedLabel.day}, ${armedLabel.time}` : undefined;
  const [hh, mm] = time.split(':').map(Number);
  const dial = Number.isFinite(hh) && Number.isFinite(mm) ? { hour: ((hh % 12) + mm / 60) * 30, minute: mm * 6 } : undefined;

  if (autoAddSelectedTickets && !saveError && !loadError) {
    return <div className="view-scroll schedule-page" data-testid="schedule-auto-add-progress" role="status">
      <h2 className="schedule-title">Adding tickets {initial ? `to “${initial.run.name}”` : 'to a new schedule'}</h2>
      <p className="schedule-sub">Saving the selected tickets as a draft scheduled run…</p>
    </div>;
  }

  return (
    <div className="view-scroll schedule-page schedule-composer" data-testid="schedule-composer">
      <header className="schedule-head">
        <div className="schedule-compose-title">
          <Icon name="clock" size={16} />
          <h2 className="schedule-title">{initial ? 'Edit scheduled run' : 'New scheduled run'}</h2>
          <input
            className="schedule-name"
            aria-label="Schedule name"
            data-testid="schedule-name"
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </div>
        <div className="schedule-head-actions">
          <button type="button" className="btn" data-testid="schedule-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" data-testid="schedule-save-draft" disabled={saving} onClick={() => void save(false)}>Save draft</button>
          <button type="button" className="btn btn-primary" data-testid="schedule-run-now" disabled={saving || !name.trim() || !count || !workflowId} onClick={() => void save(false, true)}>Run now</button>
        </div>
      </header>

      {saveError && <div className="schedule-error" role="alert" data-testid="schedule-save-error">{saveError}</div>}

      <div className="schedule-compose-grid">
        {ticketHost && createPortal(<ScheduleTickets candidates={candidates} loadError={loadError} used={onBelt} onAdd={candidate => addCandidate(candidate)} onTicketDrag={point => {
          hover(point ? targetAt(point) : undefined);
        }} onTicketDrop={(candidate, point) => {
          const target = targetAt(point);
          setDropTarget(undefined);
          if (target) addCandidate(candidate, target);
        }} />, ticketHost)}

        <div className="schedule-main-col">
          <section className="schedule-stage" aria-label="Run order"
            onDragOver={event => {
              if (!acceptsDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = dragging.current?.from === 'belt' ? 'move' : 'copy';
              hover(targetAt({ x: event.clientX, y: event.clientY }));
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
            }}
            onDrop={event => {
              event.preventDefault();
              event.stopPropagation();
              dropAt(targetAt({ x: event.clientX, y: event.clientY }) ?? { kind: 'gap', step: steps.length }, event.dataTransfer);
            }}
            data-drag-over={dropTarget !== undefined || undefined}>
            <div className="schedule-stage-head">
              <h3 className="schedule-panel-title">Run order <span className="schedule-panel-note">left to right · drop onto a ticket to share its step</span></h3>
              <span className="schedule-pill" data-testid="schedule-count">{count} ticket{count === 1 ? '' : 's'}</span>
              {stepCount > 0 && <span className="schedule-pill">{stepCount} step{stepCount === 1 ? '' : 's'}</span>}
            </div>
            <ScheduleFlowGraph
              steps={steps}
              candidates={candidates}
              target={dropTarget}
              justAdded={justAdded}
              start={{ time: armedLabel?.time, day: armedLabel?.day, armed: canSchedule }}
              onCardDragStart={(ticket, event) => {
                dragging.current = { from: 'belt', key: flowKey(ticket) };
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(SCHEDULE_TICKET_DRAG_TYPE, JSON.stringify(dragging.current));
                event.dataTransfer.setData('text/plain', ticket.issueKey);
              }}
              onCardDragEnd={() => {
                dragging.current = undefined;
                setDropTarget(undefined);
              }}
              onMoveEarlier={key => setSteps(current => moveEarlier(current, key))}
              onMoveLater={key => setSteps(current => moveLater(current, key))}
              onToggleTogether={key => setSteps(current => toggleTogether(current, key))}
              onRemove={key => setSteps(current => removeTicket(current, key))}
            />
            <p className="schedule-hint">This order belongs to the schedule. It never changes the board.</p>
          </section>

          <div className="schedule-panels">
            <section className="schedule-panel" aria-label="Start">
              <h3 className="schedule-panel-title">Start</h3>
              <div className="schedule-start-row">
                <svg className="schedule-dial" viewBox="-50 -50 100 100" aria-hidden="true">
                  <circle r="46" className="schedule-dial-face" />
                  {[0, 90, 180, 270].map(angle => <path key={angle} className="schedule-dial-tick" d="M0 -46V-39" transform={`rotate(${angle})`} />)}
                  {dial && <path className="schedule-dial-hour" d="M0 0V-24" transform={`rotate(${dial.hour})`} />}
                  {dial && <path className="schedule-dial-minute" d="M0 0V-34" transform={`rotate(${dial.minute})`} />}
                  <circle r="3" className="schedule-dial-pin" />
                </svg>
                <div className="schedule-fields">
                  <label className="schedule-field">Date
                    <input type="date" aria-label="Start date" data-testid="schedule-date" value={date} onChange={event => setDate(event.target.value)} />
                  </label>
                  <label className="schedule-field">Time
                    <input type="time" aria-label="Start time" data-testid="schedule-time" value={time} onChange={event => setTime(event.target.value)} />
                  </label>
                </div>
              </div>
              <div className="schedule-field-row">
                <ChipSelect
                  ariaLabel="Timezone"
                  data-testid="schedule-timezone"
                  value={timezone}
                  options={timeZoneOptions(timezone)}
                  onChange={setTimezone}
                  icon="globe"
                />
                <span className="schedule-pill">Once</span>
              </div>
              <p className="schedule-hint">If Praxis is closed at this time, you choose what happens when you reopen it.</p>
            </section>

            <section className="schedule-panel" aria-label="Run policy">
              <h3 className="schedule-panel-title">Run policy</h3>
              <label className="schedule-field">Workflow for each ticket
                <select aria-label="Workflow" data-testid="schedule-workflow" value={workflowId} onChange={event => setWorkflowId(event.target.value)}>
                  {!workflowId && <option value="">Choose a workflow…</option>}
                  {workflowChoices.map(choice => <option key={choice.workflowId} value={choice.workflowId}>{choice.name}</option>)}
                </select>
              </label>
              <label className="schedule-field">Tickets at once
                <ChipSelect
                  block
                  ariaLabel="Tickets at once"
                  data-testid="schedule-lanes"
                  value={lanes}
                  onChange={setLanes}
                  icon="split-horizontal"
                  options={[
                    { value: '1', label: 'One at a time (recommended)' },
                    { value: '2', label: 'Up to 2 at once' },
                    { value: '3', label: 'Up to 3 at once' },
                    { value: '4', label: 'Up to 4 at once' }
                  ]}
                />
              </label>
              {lanes === '1' ? (
                <p className="schedule-policy"><strong>One ticket at a time.</strong> Each finishes, pauses or is skipped before the next starts. Tickets that share a step have no order between them, but still run one after another.</p>
              ) : (
                <div className="schedule-notice" role="note" data-testid="schedule-lanes-warning">
                  <Icon name="warning" size={14} />
                  <span>
                    <strong>Up to {lanes} tickets of a shared step run at once.</strong> That uses provider allowance up to {lanes} times as fast. A step still waits
                    for every ticket before it, and an extra ticket only starts while its provider reports room for it, so the run may use fewer lanes.
                  </span>
                </div>
              )}
              <p className="schedule-policy"><strong>Approval gates always pause the run.</strong> Nothing is approved while you are away.</p>
              <p className="schedule-policy">
                <strong>Provider allowance.</strong> At {handoverPercent}% of a provider&rsquo;s allowance the run records its status, commits a
                checkpoint and hands over to the next provider, or pauses if none has room.
              </p>
            </section>
          </div>
        </div>
      </div>

      <section className="schedule-readiness" aria-label="Readiness" data-testid="schedule-readiness">
        <h3 className="schedule-panel-title">Readiness</h3>
        <div className="schedule-chips">
          {preview.error && <span className="schedule-chip-pill schedule-chip-pill--blocker" data-testid="schedule-preview-error"><Icon name="warning" size={12} /> {preview.error}</span>}
          {!preview.error && !readiness && <span className="schedule-hint">Checking…</span>}
          {!preview.error && readiness?.ready && count > 0 && (
            <span className="schedule-chip-pill schedule-chip-pill--ok" data-testid="schedule-ready"><Icon name="check" size={12} /> Ready to schedule</span>
          )}
          {!preview.error && condenseIssues(readiness?.issues ?? []).map((issue, index) => (
            <span key={`${issue.code}-${index}`} className={`schedule-chip-pill schedule-chip-pill--${issue.severity}`} data-code={issue.code}>
              <Icon name="warning" size={12} /> {issue.message}
            </span>
          ))}
        </div>
      </section>

      <footer className="schedule-summary" data-testid="schedule-summary">
        <div>
          <span className="schedule-panel-title">Summary</span>
          <p className="schedule-summary-text">
            <strong>{count} ticket{count === 1 ? '' : 's'}</strong>{stepCount !== count ? <> in <strong>{stepCount} step{stepCount === 1 ? '' : 's'}</strong></> : null} will run {lanes === '1' || stepCount === count ? 'one at a time' : <>up to <strong>{lanes} at once</strong> within a step</>}
            {startLabel ? <> starting <strong>{startLabel}</strong> <span className="schedule-summary-zone">({timezone})</span></> : null}.
          </p>
          <p className="schedule-hint">Once only. Approval gates pause the run until you decide.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary schedule-summary-action"
          data-testid="schedule-save"
          disabled={saving || !canSchedule}
          title={canSchedule ? 'Schedule this run' : blockers[0]?.message ?? preview.error ?? 'Add a ticket first'}
          onClick={() => void save(true)}
        >
          <Icon name="clock" size={14} /> Schedule run
        </button>
      </footer>
    </div>
  );
}
