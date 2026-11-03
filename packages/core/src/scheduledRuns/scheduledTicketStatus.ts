/**
 * Where a scheduled ticket moves on its board as the run works it (FX-BF-047).
 *
 * A ticket the schedule starts goes to the workflow's first in-flight stage, and
 * one it finishes goes to the first done stage, so the board says what the run
 * is doing without anyone moving cards. Stages are told apart by category, not
 * by name, through the project's own workflow — `categoryOfStatus` — so a board
 * whose columns are "Building" and "Shipped" moves the same way as one with
 * "In Progress" and "Done".
 *
 * Pure: the backend's transitions and the ticket's status go in, the transition
 * to apply (or none) comes out.
 */

import type { ProjectWorkflowStage } from '../projects/projectTypes';
import type { WorkflowTransition } from '../types';
import { categoryOfStatus, firstStageOfCategory, workflowCategoryRank } from '../projects/projectWorkflow';

/** The board category a ticket moves to: in flight when it starts, done when it finishes. */
export type ScheduledTicketPhase = 'indeterminate' | 'done';

/**
 * The transition that moves a ticket into `phase`, or `undefined` when it
 * should not move: it is already there or further on (a run never drags a
 * finished ticket back to in progress), or the board has no stage of that kind.
 * A transition whose target cannot be told is never taken.
 */
export function scheduledTicketTransition(
  current: string | undefined,
  transitions: readonly WorkflowTransition[],
  phase: ScheduledTicketPhase,
  workflow?: readonly ProjectWorkflowStage[]
): WorkflowTransition | undefined {
  const now = categoryOfStatus(current, workflow);
  if (now && workflowCategoryRank(now) >= workflowCategoryRank(phase)) return undefined;
  const target = (transition: WorkflowTransition) => transition.toStatus ?? transition.name;
  const candidates = transitions.filter(transition => categoryOfStatus(target(transition), workflow) === phase);
  // The workflow's first stage of the kind ("In Progress" before "Blocked"), when the board offers it.
  const preferred = firstStageOfCategory(workflow, phase)?.name.toLowerCase();
  return candidates.find(transition => target(transition).toLowerCase() === preferred) ?? candidates[0];
}
