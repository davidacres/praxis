import { useEffect, useState } from 'react';
import type { ScheduledStageDetail } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { stageTime, shortKey, type BeadState } from './spotlightFormat';

export { entryBeadState, formatHourMinute, formatMoney, formatMs, formatTokens, shortKey, stageTime, stepNumbers } from './spotlightFormat';
export type { BeadState } from './spotlightFormat';

/**
 * Pieces shared by the Spotlight run monitor, the Line composer and the run report
 * (FX-BF-047 / FX-BE-193): the row of beads that stands for every ticket in run
 * order, and a ticket's agent tasks. Presentation only — what each value means is
 * decided in core and main.
 */


export interface Bead {
  key: string;
  issueKey: string;
  title: string;
  step: number;
  state: BeadState;
}

const BEAD_GLYPH: Partial<Record<BeadState, string>> = { done: '✓', failed: '✕', waiting: '!' };
const BEAD_LABEL: Record<BeadState, string> = { queued: 'waiting', running: 'running', waiting: 'needs you', failed: 'failed', done: 'done', skipped: 'skipped' };

/** Steps as runs of beads: one bead per ticket, a gap between steps. */
export function BeadRail({ beads, testId = 'schedule-rail', label = 'Tickets in run order' }: { beads: Bead[]; testId?: string; label?: string }) {
  const steps: Bead[][] = [];
  for (const bead of beads) {
    const last = steps[steps.length - 1];
    if (last && last[0].step === bead.step) last.push(bead);
    else steps.push([bead]);
  }
  const done = beads.filter(bead => bead.state === 'done' || bead.state === 'skipped').length;
  return (
    <ol className="spot-rail" data-testid={testId} aria-label={`${label}: ${done} of ${beads.length} finished`}>
      {steps.map(step => (
        <li key={step[0].key} className="spot-rail-step">
          <span className="spot-rail-step-label">Step {step[0].step}</span>
          <ol className="spot-rail-beads">
            {step.map(bead => (
              <li key={bead.key} className={`spot-bead spot-bead--${bead.state}`} data-issue={bead.issueKey} data-state={bead.state} title={`${bead.issueKey} · ${bead.title} · ${BEAD_LABEL[bead.state]}`}>
                <span className="spot-bead-dot" aria-hidden="true">{BEAD_GLYPH[bead.state] ?? ''}</span>
                <span className="spot-bead-key">{shortKey(bead.issueKey)}</span>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** A clock that ticks, for elapsed times the runner reports as a start instant. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const TASK_STATE_LABEL: Record<ScheduledStageDetail['lane'], string> = {
  idle: 'not started',
  ready: 'up next',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  awaiting: 'waiting for approval',
  paused: 'paused'
};

function taskGlyph(stage: ScheduledStageDetail) {
  if (stage.lane === 'done') return <Icon name="check" size={10} />;
  if (stage.lane === 'failed') return <Icon name="close" size={10} />;
  if (stage.lane === 'awaiting' || stage.lane === 'paused') return <span aria-hidden="true">!</span>;
  return null;
}

/**
 * A ticket's agent tasks in run order. The running one is marked and shows how
 * long it has been going; nothing here is a percentage, because the workflow does
 * not report one.
 */
export function TaskRows({ stages, now, compact = false }: { stages: ScheduledStageDetail[]; now: number; compact?: boolean }) {
  return (
    <ol className={`spot-tasks${compact ? ' spot-tasks--compact' : ''}`} aria-label="Agent tasks">
      {stages.map(stage => {
        const attempts = stage.attemptsThisRevision ?? stage.attempts;
        const again = stage.attempts > 1 ? `×${stage.attempts}` : '';
        return (
          <li
            key={stage.nodeId}
            className={`spot-task spot-task--${stage.lane}`}
            data-testid="schedule-task-row"
            data-node={stage.nodeId}
            data-lane={stage.lane}
            aria-label={`${stage.name}: ${TASK_STATE_LABEL[stage.lane]}${stage.attempts > 1 ? `, ${stage.attempts} attempts` : ''}`}
          >
            <span className={`spot-task-icon spot-task-icon--${stage.type}`} aria-hidden="true">{taskGlyph(stage)}</span>
            <span className="spot-task-name">{stage.name}</span>
            {again && <span className="spot-task-again" title={`${stage.attempts} attempts in all${attempts !== stage.attempts ? `, ${attempts} in this pass` : ''}`}>{again}</span>}
            <span className="spot-task-time">{stageTime(stage, now)}</span>
          </li>
        );
      })}
    </ol>
  );
}
