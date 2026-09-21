import { planApprovalGadgetSync, type WorkflowRun } from '@praxis/core';
import { getGadgetService } from './gadgetInstance';
import { getHostId } from './hostIdentity';

/**
 * Keeps a run's controller session showing exactly the approval gadgets its
 * awaiting-approval nodes call for (TASK-287) — see `planApprovalGadgetSync`
 * for the decision itself; this only carries it out against the live
 * `GadgetService`. Called from `onRunChanged`, so it runs on every state
 * change a run goes through, not just the ones that touch approval.
 *
 * A run with no controller session has nowhere to show a gadget and is a
 * no-op, same as one with nothing awaiting.
 */
export function syncApprovalGadgets(run: WorkflowRun): void {
  const sessionId = run.controllerSessionId;
  if (!sessionId) return;

  const gadgets = getGadgetService();
  const plan = planApprovalGadgetSync(
    run,
    { hostId: getHostId(), sessionId },
    gadgets.getBlocks(sessionId),
    new Date().toISOString()
  );

  for (const gadgetId of plan.revoke) gadgets.revoke(sessionId, gadgetId);
  if (plan.publish.length > 0) gadgets.publish(sessionId, plan.publish);
}
