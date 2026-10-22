import { createPortal } from 'react-dom';
import { ScheduleTickets, expandScheduleTickets, type Candidate } from './ScheduleTickets';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord, SaveScheduledRunInput, ScheduledRunReadiness, ScheduledRunView, ScheduledTicketRef } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { condenseIssues, localTimeZone, timeZoneOptions, tomorrowDate } from './scheduleFormat';

/**
 * The scheduled-run composer (FX-BF-047 / FX-BE-147 / TASK-384).
 *
 * Tickets are picked from a hopper and dropped on a belt; the belt's left-to-right
 * order *is* the run order, kept on the schedule and never on the board. The
 * processor on the right is a preview of the armed run, not something that is
 * running. Dragging is an enhancement: every move has a button, so the order can
 * be built entirely from the keyboard.
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
  onSaved: () => void;
  initialTicketKeys?: string[];
  autoAddSelectedTickets?: boolean;
}

function refOf(candidate: Candidate): ScheduledTicketRef {
  return { connectionId: candidate.connectionId, issueKey: candidate.key, title: candidate.title };
}

const sameTicket = (a: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>, b: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>) =>
  a.connectionId === b.connectionId && a.issueKey === b.issueKey;

export function ScheduleComposer({ project, ticketHost, candidates, loadError, initial, onClose, onSaved, initialTicketKeys = [], autoAddSelectedTickets = false }: ScheduleComposerProps) {
  const [name, setName] = useState(initial?.run.name ?? 'Scheduled run');
  const [date, setDate] = useState(initial?.start.date || tomorrowDate());
  const [time, setTime] = useState(initial?.start.time || '22:00');
  const [timezone, setTimezone] = useState(initial?.run.timezone ?? localTimeZone());
  const [belt, setBelt] = useState<ScheduledTicketRef[]>(() => initial?.run.entries.map(entry => ({ ...entry.ticket })) ?? []);
  const [preview, setPreview] = useState<{ readiness?: ScheduledRunReadiness; error?: string }>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justAdded, setJustAdded] = useState<string>();
  const dragging = useRef<{ from: 'hopper' | 'belt'; key: string }>();
  const [overIndex, setOverIndex] = useState<number>();
  const autoAddStarted = useRef(false);
  const ticketsSeeded = useRef(false);

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
    setBelt(current => {
      const next = [...current];
      for (const ticket of selected) if (!next.some(existing => sameTicket(existing, ticket))) next.push(ticket);
      return next;
    });
  }, [autoAddSelectedTickets, candidates, initial?.run.id, initial?.run.name, initial?.run.timezone, initial?.run.entries, initial?.start.date, initial?.start.time, initialTicketKeys.join('\0'), onSaved, project.id]);

  const input: SaveScheduledRunInput = useMemo(
    () => ({ id: initial?.run.id, projectId: project.id, name, date, time, timezone, tickets: belt, arm: false }),
    [initial?.run.id, project.id, name, date, time, timezone, belt]
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

  const onBelt = (candidate: Candidate) => belt.some(ticket => sameTicket(ticket, { connectionId: candidate.connectionId, issueKey: candidate.key }));
  const addTicket = (ticket: ScheduledTicketRef, at?: number) => {
    setBelt(current => {
      if (current.some(existing => sameTicket(existing, ticket))) return current;
      const next = [...current];
      next.splice(at === undefined ? next.length : Math.max(0, Math.min(next.length, at)), 0, ticket);
      return next;
    });
    setJustAdded(ticket.issueKey);
    window.setTimeout(() => setJustAdded(current => (current === ticket.issueKey ? undefined : current)), 700);
  };
  const addCandidate = (candidate: Candidate, at?: number) => {
    const tickets = expandScheduleTickets(candidates ?? [], [candidate]);
    tickets.forEach((item, offset) => addTicket(refOf(item), at === undefined ? undefined : at + offset));
  };
  const removeAt = (index: number) => setBelt(current => current.filter((_, i) => i !== index));
  const move = (from: number, to: number) =>
    setBelt(current => {
      if (to < 0 || to >= current.length || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const dropAt = (index: number) => {
    const drag = dragging.current;
    dragging.current = undefined;
    setOverIndex(undefined);
    if (!drag) return;
    if (drag.from === 'belt') {
      const from = belt.findIndex(ticket => `${ticket.connectionId}\u0000${ticket.issueKey}` === drag.key);
      if (from >= 0) move(from, index > from ? index - 1 : index);
      return;
    }
    const candidate = (candidates ?? []).find(item => `${item.connectionId}\u0000${item.key}` === drag.key);
    if (candidate) addCandidate(candidate, index);
  };

  const readiness = preview.readiness;
  const blockers = readiness?.issues.filter(issue => issue.severity === 'blocker') ?? [];
  const canSchedule = !!readiness && readiness.ready && belt.length > 0 && !preview.error;
  const armedLabel = (() => {
    const when = new Date(`${date}T00:00:00`);
    if (!date || !time || Number.isNaN(when.getTime())) return undefined;
    return {
      time,
      day: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(when)
    };
  })();

  const save = async (arm: boolean) => {
    setSaving(true);
    setSaveError('');
    try {
      await window.praxis.scheduledRuns.save({ ...input, arm });
      onSaved();
    } catch (reason) {
      setSaveError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  };

  const count = belt.length;
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
        </div>
      </header>

      {saveError && <div className="schedule-error" role="alert" data-testid="schedule-save-error">{saveError}</div>}

      <div className="schedule-compose-grid">
        {ticketHost && createPortal(<ScheduleTickets candidates={candidates} loadError={loadError} used={onBelt} onAdd={candidate => addCandidate(candidate)} onDrag={candidate => { dragging.current = { from: 'hopper', key: `${candidate.connectionId}\u0000${candidate.key}` }; }} onDragEnd={() => { dragging.current = undefined; setOverIndex(undefined); }} />, ticketHost)}

        <div className="schedule-main-col">
          <section className="schedule-stage" aria-label="Run order">
            <div className="schedule-stage-head">
              <h3 className="schedule-panel-title">Run order <span className="schedule-panel-note">one at a time, left to right</span></h3>
              <span className="schedule-pill" data-testid="schedule-count">{count} ticket{count === 1 ? '' : 's'}</span>
            </div>
            <div className="schedule-stage-body">
              <ol
                className="schedule-belt"
                data-testid="schedule-belt"
                onDragOver={event => {
                  if (dragging.current) event.preventDefault();
                }}
                onDrop={event => {
                  event.preventDefault();
                  dropAt(belt.length);
                }}
              >
                {belt.map((ticket, index) => (
                  <li
                    key={`${ticket.connectionId}:${ticket.issueKey}`}
                    className={`schedule-belt-card${justAdded === ticket.issueKey ? ' is-entering' : ''}${overIndex === index ? ' is-over' : ''}`}
                    data-testid="schedule-belt-card"
                    data-issue={ticket.issueKey}
                    draggable
                    onDragStart={event => {
                      dragging.current = { from: 'belt', key: `${ticket.connectionId}\u0000${ticket.issueKey}` };
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', ticket.issueKey);
                    }}
                    onDragOver={event => {
                      if (!dragging.current) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setOverIndex(index);
                    }}
                    onDragLeave={() => setOverIndex(current => (current === index ? undefined : current))}
                    onDrop={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      dropAt(index);
                    }}
                    onDragEnd={() => {
                      dragging.current = undefined;
                      setOverIndex(undefined);
                    }}
                  >
                    <span className="schedule-belt-seq" aria-label={`Position ${index + 1}`}>{index + 1}</span>
                    <span className="schedule-belt-key">{ticket.issueKey}</span>
                    <span className="schedule-belt-title" title={ticket.title}>{ticket.title}</span>
                    <span className="schedule-belt-controls">
                      <button type="button" className="schedule-belt-btn" aria-label={`Move ${ticket.issueKey} earlier`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                        <Icon name="arrow-left" size={12} />
                      </button>
                      <button type="button" className="schedule-belt-btn" aria-label={`Move ${ticket.issueKey} later`} disabled={index === belt.length - 1} onClick={() => move(index, index + 1)}>
                        <Icon name="arrow-right" size={12} />
                      </button>
                      <button type="button" className="schedule-belt-btn" aria-label={`Remove ${ticket.issueKey} from the run`} onClick={() => removeAt(index)}>
                        <Icon name="close" size={12} />
                      </button>
                    </span>
                  </li>
                ))}
                <li className="schedule-belt-slot" data-testid="schedule-belt-slot" aria-hidden={belt.length > 0}>
                  {belt.length === 0 ? 'Add tickets from the left, or drag them here' : 'Drop here'}
                </li>
              </ol>

              <div className="schedule-flow" aria-hidden="true"><span /><span /><span /></div>

              <aside className="schedule-processor" aria-label="Armed run preview" data-testid="schedule-processor" data-armed={canSchedule ? 'true' : 'false'}>
                <svg viewBox="-120 -120 240 240" role="img" aria-label={canSchedule ? 'Run ready to schedule' : 'Run not ready'}>
                  <circle r="100" className="schedule-proc-halo" />
                  <circle r="96" className="schedule-proc-track" />
                  <circle r="96" className="schedule-proc-arc" strokeDasharray={`${Math.min(1, belt.length / 6) * 603} 603`} transform="rotate(-90)" />
                  <circle r="108" className="schedule-proc-dots" />
                  <circle r="82" className="schedule-proc-gear" />
                  <circle r="66" className="schedule-proc-core" />
                  <text y="-14" textAnchor="middle" className="schedule-proc-label">{canSchedule ? 'ARMED FOR' : 'NOT READY'}</text>
                  <text y="14" textAnchor="middle" className="schedule-proc-time">{armedLabel?.time ?? '--:--'}</text>
                  <text y="34" textAnchor="middle" className="schedule-proc-day">{armedLabel?.day ?? ''}</text>
                </svg>
              </aside>
            </div>
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
              <p className="schedule-policy"><strong>Sequential.</strong> One ticket finishes, pauses or is skipped before the next starts.</p>
              <p className="schedule-policy"><strong>Approval gates always pause the run.</strong> Nothing is approved while you are away.</p>
              <p className="schedule-policy">
                <strong>Provider allowance.</strong> At 95% of a provider&rsquo;s allowance the run records its status, commits a
                checkpoint and hands over to the next provider. <span className="schedule-tag">with the runner</span>
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
          {!preview.error && readiness?.ready && belt.length > 0 && (
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
            <strong>{count} ticket{count === 1 ? '' : 's'}</strong> will run one at a time
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
