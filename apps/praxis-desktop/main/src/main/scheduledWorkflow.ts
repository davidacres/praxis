import type { ScheduledWorkflowChoice } from '@praxis/core';

/** Prefer a ticket-owned workflow, otherwise use governed delivery. */
export function defaultScheduleWorkflow(choices: readonly ScheduledWorkflowChoice[]): string | undefined {
  return (choices.find(choice => choice.trigger === 'ticket') ?? choices.find(choice => choice.workflowId === 'governed-delivery'))?.workflowId;
}
