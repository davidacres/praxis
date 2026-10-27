import { Fragment, type DragEvent } from 'react';
import type { ScheduledTicketRef } from '@praxis/core';
import { Icon } from '../ui/Icon';
import type { Candidate } from './ScheduleTickets';
import { canMoveEarlier, canMoveLater, flowKey, stepLabel, type FlowSteps, type FlowTarget } from './scheduleFlow';

/**
 * The run order drawn like the Task Designer (FX-BF-047): ticket nodes on a dot
 * grid, linked left to right by arrows in the order they run. A step shared by
 * several tickets splits at a bar, runs each ticket on its own pair of parallel
 * rails, and joins at a second bar before the next arrow.
 *
 * The graph lays itself out from `steps`; there is nothing to position by hand.
 * Every drop target carries `data-flow-gap` (a new step before that index) or
 * `data-flow-join` (into that step), and the composer resolves a pointer to a
 * target from those, so a native drag and a pointer drag land the same way.
 */
interface ScheduleFlowGraphProps {
  steps: FlowSteps;
  candidates?: Candidate[];
  /** Where a drag in progress would land, to draw its placeholder. */
  target?: FlowTarget;
  justAdded?: string;
  start: { time?: string; day?: string; armed: boolean };
  onCardDragStart: (ticket: ScheduledTicketRef, event: DragEvent<HTMLElement>) => void;
  onCardDragEnd: () => void;
  onMoveEarlier: (key: string) => void;
  onMoveLater: (key: string) => void;
  onToggleTogether: (key: string) => void;
  onRemove: (key: string) => void;
}

export function ScheduleFlowGraph({ steps, candidates, target, justAdded, start, onCardDragStart, onCardDragEnd, onMoveEarlier, onMoveLater, onToggleTogether, onRemove }: ScheduleFlowGraphProps) {
  const details = (ticket: ScheduledTicketRef) => candidates?.find(item => item.connectionId === ticket.connectionId && item.key === ticket.issueKey);
  const empty = steps.length === 0;

  const node = (ticket: ScheduledTicketRef, step: number, lane: number, size: number) => {
    const key = flowKey(ticket);
    const info = details(ticket);
    const shared = size > 1;
    return (
      <div
        key={key}
        className={`schedule-belt-card schedule-flow-node${shared ? ' is-together' : ''}${justAdded === ticket.issueKey ? ' is-entering' : ''}`}
        data-testid="schedule-belt-card"
        data-issue={ticket.issueKey}
        data-flow-join={step}
        data-step={step}
        draggable
        onDragStart={event => onCardDragStart(ticket, event)}
        onDragEnd={onCardDragEnd}
      >
        <span className="schedule-flow-handle schedule-flow-handle--in" aria-hidden="true" />
        <span className="schedule-flow-handle schedule-flow-handle--out" aria-hidden="true" />
        <div className="schedule-flow-node-head">
          <span className="schedule-belt-seq" aria-label={`Step ${stepLabel(step, lane, size)}`}>{stepLabel(step, lane, size)}</span>
          <span className="schedule-belt-key">{ticket.issueKey}</span>
          <span className="schedule-belt-controls">
            <button type="button" className="schedule-belt-btn" aria-label={`Move ${ticket.issueKey} earlier`} disabled={!canMoveEarlier(steps, key)} onClick={() => onMoveEarlier(key)}>
              <Icon name="arrow-left" size={12} />
            </button>
            <button type="button" className="schedule-belt-btn" aria-label={`Move ${ticket.issueKey} later`} disabled={!canMoveLater(steps, key)} onClick={() => onMoveLater(key)}>
              <Icon name="arrow-right" size={12} />
            </button>
            <button
              type="button"
              className="schedule-belt-btn"
              aria-label={shared ? `Give ${ticket.issueKey} its own step` : `Put ${ticket.issueKey} in the step before`}
              aria-pressed={shared}
              disabled={!shared && step === 0}
              onClick={() => onToggleTogether(key)}
            >
              <Icon name="split-horizontal" size={12} />
            </button>
            <button type="button" className="schedule-belt-btn" aria-label={`Remove ${ticket.issueKey} from the run`} onClick={() => onRemove(key)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </div>
        <span className="schedule-belt-title" title={ticket.title}>{ticket.title}</span>
        <div className="schedule-flow-node-foot">
          {info && <span className="schedule-flow-type">{info.issueType}</span>}
          {info && <span className="schedule-flow-status">{info.status}</span>}
        </div>
      </div>
    );
  };

  /** The arrow between two steps, and the place to drop a ticket as a new step there. */
  const gap = (index: number) => {
    const active = target?.kind === 'gap' && target.step === index;
    return (
      <li key={`gap-${index}`} className={`schedule-flow-gap${active ? ' is-target' : ''}`} data-flow-gap={index} aria-hidden="true">
        <span className="schedule-flow-arrow" />
        {active && <span className="schedule-flow-placeholder">New step {index + 1}</span>}
        {active && <span className="schedule-flow-arrow" />}
      </li>
    );
  };

  return (
    <>
    <div className="schedule-flow-canvas" data-empty={empty || undefined}>
      <div className="schedule-flow-track">
        <div className="schedule-flow-start" data-testid="schedule-processor" data-armed={start.armed ? 'true' : 'false'} aria-label={start.armed ? `Ready to start ${start.day ?? ''} ${start.time ?? ''}` : 'Run not ready'}>
          <Icon name="clock" size={13} />
          <span className="schedule-flow-start-time">{start.time ?? '--:--'}</span>
          {start.day && <span className="schedule-flow-start-day">{start.day}</span>}
        </div>
        <ol className="schedule-belt schedule-flow" data-testid="schedule-belt" aria-label="Steps in run order">
          {steps.map((step, index) => {
            const joining = target?.kind === 'join' && target.step === index;
            const lanes = step.length;
            return (
              <Fragment key={step.map(flowKey).join('|')}>
                {gap(index)}
                <li className={`schedule-flow-step${lanes > 1 ? ' is-together' : ''}${joining ? ' is-target' : ''}`} data-flow-join={index} data-testid="schedule-flow-step">
                  <span className="schedule-flow-step-label">Step {index + 1}{lanes > 1 ? ' · together' : ''}</span>
                  {lanes > 1 ? (
                    <div className="schedule-flow-lanes">
                      <span className="schedule-flow-bar" aria-hidden="true" />
                      <div className="schedule-flow-lane-list">
                        {step.map((ticket, lane) => (
                          <div key={flowKey(ticket)} className="schedule-flow-lane">
                            <span className="schedule-flow-rails" aria-hidden="true" />
                            {node(ticket, index, lane, step.length)}
                            <span className="schedule-flow-rails" aria-hidden="true" />
                          </div>
                        ))}
                      </div>
                      <span className="schedule-flow-bar" aria-hidden="true" />
                    </div>
                  ) : node(step[0], index, 0, 1)}
                  {joining && (
                    // Floats below the step, so hovering never moves the node under the pointer.
                    <div className="schedule-flow-join-preview" aria-hidden="true">
                      <span className="schedule-flow-rails is-target" />
                      <span className="schedule-flow-placeholder">Share step {index + 1}</span>
                      <span className="schedule-flow-rails is-target" />
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
          <li
            key="end"
            className={`schedule-flow-gap schedule-flow-gap--end${target?.kind === 'gap' && target.step === steps.length ? ' is-target' : ''}`}
            data-flow-gap={steps.length}
          >
            {!empty && <span className="schedule-flow-arrow" aria-hidden="true" />}
            <span className="schedule-belt-slot schedule-flow-placeholder" data-testid="schedule-belt-slot">
              {empty ? 'Drag tickets here, or press Enter on one, to make step 1' : `Drop to add step ${steps.length + 1}`}
            </span>
          </li>
        </ol>
      </div>
    </div>
    <div className="schedule-flow-legend" aria-hidden="true">
      <span><span className="schedule-flow-legend-arrow" />Runs after</span>
      <span><span className="schedule-flow-legend-rails" />Same step</span>
      <span><span className="schedule-flow-legend-bar" />Split · wait for all</span>
    </div>
    </>
  );
}
