import { useEffect, useState } from 'react';
import type { ScheduledRunForecast } from '@praxis/core';
import { BeadRail, formatHourMinute, type Bead } from './scheduleSpotlight';

/**
 * The composer's rehearsal (FX-BE-193 / TASK-508): the schedule's forecast played
 * on the same row of beads the run monitor shows, with one line saying what each
 * step does and when. It is a forecast and says so; with too little history it
 * shows the order alone and why there is no timing. Under reduced motion it does
 * not play, and lists every step instead.
 */
interface RehearsalProps {
  /** Tickets in run order with their step, as the Line holds them. */
  tickets: Array<{ issueKey: string; title: string; step: number }>;
  forecast?: ScheduledRunForecast;
  timezone: string;
}

const PERIOD_MS = 9000;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function ScheduleRehearsal({ tickets, forecast, timezone }: RehearsalProps) {
  const reduced = prefersReducedMotion();
  const [phase, setPhase] = useState(0);
  const timed = !!forecast?.likelyFinishAt && forecast.entries.length > 0;
  useEffect(() => {
    if (reduced || !timed) return;
    const begin = Date.now();
    const timer = window.setInterval(() => setPhase(((Date.now() - begin) % PERIOD_MS) / PERIOD_MS), 120);
    return () => window.clearInterval(timer);
  }, [reduced, timed]);

  const windows = new Map((forecast?.entries ?? []).map(entry => [entry.issueKey, entry] as const));
  const origin = timed ? Math.min(...forecast!.entries.map(entry => Date.parse(entry.startAt))) : 0;
  const finish = timed ? Date.parse(forecast!.likelyFinishAt!) : 0;
  // Play a little past the finish so the last bead is seen done before it starts again.
  const at = origin + Math.min(1, phase * 1.1) * (finish - origin);

  const beads: Bead[] = tickets.map(ticket => {
    const window = windows.get(ticket.issueKey);
    let state: Bead['state'] = 'queued';
    // Under reduced motion nothing plays: the beads stay put and the steps are listed below.
    if (timed && window && !reduced) {
      if (at >= Date.parse(window.endAt)) state = 'done';
      else if (at >= Date.parse(window.startAt)) state = 'running';
    }
    return { key: ticket.issueKey, issueKey: ticket.issueKey, title: ticket.title, step: ticket.step, state };
  });

  const steps = [...new Set(tickets.map(ticket => ticket.step))];
  const describe = (step: number) => {
    const inStep = tickets.filter(ticket => ticket.step === step);
    const spans = inStep.map(ticket => windows.get(ticket.issueKey)).filter((window): window is NonNullable<typeof window> => !!window);
    const keys = inStep.map(ticket => ticket.issueKey).join(inStep.length > 1 ? ' and ' : '');
    const when = spans.length
      ? ` · ${formatHourMinute(new Date(Math.min(...spans.map(span => Date.parse(span.startAt)))).toISOString(), timezone)}–${formatHourMinute(new Date(Math.max(...spans.map(span => Date.parse(span.endAt)))).toISOString(), timezone)}`
      : '';
    return `Step ${step} · ${keys}${inStep.length > 1 ? ' side by side' : ''}${when}`;
  };
  const current = (() => {
    if (!timed) return undefined;
    if (at >= finish) return `All ${tickets.length} done by about ${formatHourMinute(forecast!.likelyFinishAt, timezone)}${forecast!.slowFinishAt ? `; a slow night could run to ${formatHourMinute(forecast!.slowFinishAt, timezone)}` : ''}.`;
    const running = tickets.find(ticket => {
      const window = windows.get(ticket.issueKey);
      return window && at >= Date.parse(window.startAt) && at < Date.parse(window.endAt);
    });
    return running ? describe(running.step) : undefined;
  })();

  return (
    <section className="schedule-panel spot-rehearsal" aria-label="Rehearsal" data-testid="schedule-rehearsal">
      <div className="spot-rehearsal-head">
        <h3 className="schedule-panel-title">Rehearsal <span className="schedule-panel-note">{timed ? `a forecast from ${forecast!.basedOnRuns} earlier runs of this workflow` : 'the order the beads will run in'}</span></h3>
        {timed && !reduced && <span className="spot-rehearsal-clock" aria-hidden="true">{formatHourMinute(new Date(at).toISOString(), timezone)}</span>}
      </div>
      {tickets.length > 0 ? <BeadRail beads={beads} label="Rehearsal of the run" /> : <p className="schedule-hint">Add tickets to rehearse the run.</p>}
      {timed && !reduced && current && <p key={current} className="spot-rehearsal-line" aria-live="off">{current}</p>}
      {timed && reduced && (
        <ol className="spot-rehearsal-steps">{steps.map(step => <li key={step}>{describe(step)}</li>)}</ol>
      )}
      {!timed && forecast?.notEstimable && tickets.length > 0 && <p className="schedule-hint">{forecast.notEstimable}</p>}
    </section>
  );
}
