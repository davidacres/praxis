import type { ScheduledQueueEntry, ScheduledTicketRef } from '@praxis/core';

/**
 * The composer's run order as steps (FX-BF-047). A step is one ticket, or several
 * that share it: the flow graph draws a shared step as parallel lanes, and core
 * stores every ticket after the first in a step as `withPrevious`. Until bounded
 * parallel lanes (FX-BE-149) land the runner still takes a step's tickets one at
 * a time, so a shared step means "no order between these", not "at once".
 *
 * Everything here is pure: each edit returns a new array and never mutates.
 */
export type FlowSteps = ScheduledTicketRef[][];

/** Where a dragged ticket lands: a new step before `step`, or into step `step`. */
export type FlowTarget = { kind: 'gap'; step: number } | { kind: 'join'; step: number };

export const flowKey = (ticket: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>) => `${ticket.connectionId}\u0000${ticket.issueKey}`;

export function stepsFromEntries(entries: readonly Pick<ScheduledQueueEntry, 'ticket' | 'withPrevious'>[]): FlowSteps {
  const steps: FlowSteps = [];
  for (const entry of entries) {
    if (entry.withPrevious && steps.length) steps[steps.length - 1].push({ ...entry.ticket });
    else steps.push([{ ...entry.ticket }]);
  }
  return steps;
}

/** What `SaveScheduledRunInput` wants: tickets in run order, and the ones that share the step before them. */
export function flattenSteps(steps: FlowSteps): { tickets: ScheduledTicketRef[]; withPrevious: string[] } {
  return {
    tickets: steps.flat(),
    withPrevious: steps.flatMap(step => step.slice(1).map(flowKey))
  };
}

export function locate(steps: FlowSteps, key: string): { step: number; lane: number } | undefined {
  for (let step = 0; step < steps.length; step += 1) {
    const lane = steps[step].findIndex(ticket => flowKey(ticket) === key);
    if (lane >= 0) return { step, lane };
  }
  return undefined;
}

/**
 * Puts tickets at a target, taking them out of wherever they were first. Into a
 * step, they all join it; at a gap, each becomes its own step in order. The
 * target is read against the steps as they were, so moving a ticket out of a
 * step before the target does not shift where it lands.
 */
export function placeTickets(steps: FlowSteps, tickets: readonly ScheduledTicketRef[], target: FlowTarget): FlowSteps {
  const moving = new Set(tickets.map(flowKey));
  const incoming = tickets.filter((ticket, index) => tickets.findIndex(other => flowKey(other) === flowKey(ticket)) === index).map(ticket => ({ ...ticket }));
  const at = Math.max(0, Math.min(steps.length, target.step));
  const next: FlowSteps = [];
  for (let index = 0; index <= steps.length; index += 1) {
    if (target.kind === 'gap' && index === at) incoming.forEach(ticket => next.push([ticket]));
    if (index === steps.length) break;
    const rest = steps[index].filter(ticket => !moving.has(flowKey(ticket)));
    if (target.kind === 'join' && index === at) next.push([...rest, ...incoming]);
    else if (rest.length) next.push(rest);
  }
  if (target.kind === 'join' && at === steps.length) next.push(incoming);
  return next.filter(step => step.length);
}

export function removeTicket(steps: FlowSteps, key: string): FlowSteps {
  return steps.map(step => step.filter(ticket => flowKey(ticket) !== key)).filter(step => step.length);
}

/** One step earlier: a shared ticket first leaves its step and goes just before it. */
export function moveEarlier(steps: FlowSteps, key: string): FlowSteps {
  const found = locate(steps, key);
  if (!found || !canMoveEarlier(steps, key)) return steps;
  const ticket = steps[found.step][found.lane];
  return placeTickets(steps, [ticket], { kind: 'gap', step: steps[found.step].length > 1 ? found.step : found.step - 1 });
}

/** One step later: a shared ticket first leaves its step and goes just after it. */
export function moveLater(steps: FlowSteps, key: string): FlowSteps {
  const found = locate(steps, key);
  if (!found || !canMoveLater(steps, key)) return steps;
  const ticket = steps[found.step][found.lane];
  return placeTickets(steps, [ticket], { kind: 'gap', step: found.step + (steps[found.step].length > 1 ? 1 : 2) });
}

export function canMoveEarlier(steps: FlowSteps, key: string): boolean {
  const found = locate(steps, key);
  return !!found && (found.step > 0 || steps[found.step].length > 1);
}

export function canMoveLater(steps: FlowSteps, key: string): boolean {
  const found = locate(steps, key);
  return !!found && (found.step < steps.length - 1 || steps[found.step].length > 1);
}

/** A ticket on its own joins the step before it; a shared one gets its own step right after. */
export function toggleTogether(steps: FlowSteps, key: string): FlowSteps {
  const found = locate(steps, key);
  if (!found) return steps;
  const ticket = steps[found.step][found.lane];
  if (steps[found.step].length > 1) return placeTickets(steps, [ticket], { kind: 'gap', step: found.step + 1 });
  if (found.step === 0) return steps;
  return placeTickets(steps, [ticket], { kind: 'join', step: found.step - 1 });
}

/** "1", "2a", "2b": the label a ticket's node carries. */
export function stepLabel(step: number, lane: number, size: number): string {
  return size > 1 ? `${step + 1}${String.fromCharCode(97 + Math.min(lane, 25))}` : String(step + 1);
}
