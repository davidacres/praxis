/**
 * Mirrors a run's awaiting approvals into chat as approval gadgets (TASK-287).
 *
 * `scheduleWorkflowRun` already answers "which node is waiting on a person" for
 * the run monitor; this reuses that same answer rather than re-deriving it, so
 * a gadget in chat and the run monitor's Approve button can never disagree
 * about what is actually awaiting a decision.
 *
 * Pure: given a run, its controller session's scope, and the gadgets already
 * published there, decide what should be published or withdrawn. The caller
 * (the desktop host) is the only thing that touches the live `GadgetService`.
 */
import { GADGET_CONTRACT_VERSION, type ApprovalGadgetPayload, type ChatBlock, type RawChatBlockInput } from '../ai/gadgets';
import { isApprovalNode } from './workflowTypes';
import type { WorkflowRun } from './workflowRun';
import { scheduleWorkflowRun } from './workflowScheduler';

/** The gate shown on an approval gadget when its node declares none. */
const UNGATED_APPROVAL = 'workflow.approval';

export interface ApprovalGadgetSessionScope {
  hostId: string;
  sessionId: string;
}

export interface ApprovalGadgetSyncPlan {
  /** Gadget IDs whose node is no longer awaiting a person and should stop offering approval. */
  revoke: string[];
  /** New gadget blocks for nodes that started awaiting approval since `existingBlocks` was captured. */
  publish: RawChatBlockInput[];
}

export function approvalGadgetId(runId: string, nodeId: string): string {
  return `approval-${runId}-${nodeId}`;
}

export function planApprovalGadgetSync(
  run: WorkflowRun,
  scope: ApprovalGadgetSessionScope,
  existingBlocks: readonly ChatBlock[],
  issuedAt: string
): ApprovalGadgetSyncPlan {
  const awaiting = new Set(scheduleWorkflowRun(run).awaitingApproval);
  const publishedNodeIds = new Set<string>();
  const revoke: string[] = [];

  for (const block of existingBlocks) {
    if (block.type !== 'gadget' || block.gadget.kind !== 'approval') continue;
    if (block.gadget.scope.workId !== run.runId) continue;
    const nodeId = block.gadget.payload.nodeId;
    if (!nodeId) continue;
    publishedNodeIds.add(nodeId);
    // Only an untouched gadget is withdrawn here. One already submitted or
    // completed keeps that answer — `resolveGadgetState` gives a recorded
    // decision precedence over everything but an explicit revoke, and
    // revoking it too would relabel a real decision as withdrawn.
    if (!awaiting.has(nodeId) && block.gadget.state === 'active') {
      revoke.push(block.gadget.gadgetId);
    }
  }

  const publish: RawChatBlockInput[] = [];
  for (const nodeId of awaiting) {
    if (publishedNodeIds.has(nodeId)) continue;
    const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
    if (!node || !isApprovalNode(node)) continue;

    const gate = node.requiredGates.join(', ') || UNGATED_APPROVAL;
    const payload: ApprovalGadgetPayload = {
      title: node.name,
      summary: node.prompt,
      gate,
      requestedBy: 'workflow run',
      nodeId
    };

    publish.push({
      type: 'gadget',
      gadget: {
        version: GADGET_CONTRACT_VERSION,
        gadgetId: approvalGadgetId(run.runId, nodeId),
        kind: 'approval',
        scope: { hostId: scope.hostId, sessionId: scope.sessionId, projectId: run.projectId, workId: run.runId },
        issuedAt,
        payload,
        actions: [
          { actionId: 'approve', label: 'Approve', effect: 'approval', gate },
          { actionId: 'reject', label: 'Reject', effect: 'informational' }
        ]
      }
    });
  }

  return { revoke, publish };
}
