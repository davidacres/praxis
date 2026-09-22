import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import {
  TICKET_REVIEW_APPLY_GATE,
  approveStage,
  isGadgetActionValue,
  parseChatBlocks,
  resolveApprovalTarget,
  WorkflowRunStore,
  type GadgetAction,
  type GadgetExecutionContext,
  type GadgetSubmitRequest,
  type RawChatBlockInput,
  type WorkflowPolicyProfile
} from '@praxis/core';
import { getGadgetService, resolveSessionScope } from './gadgetInstance';
import { getWorkflowBackingStore, getWorkflowPolicyStore } from './workflowStoreInstance';
import { getWorkflowOrchestrator } from './workflowOrchestratorInstance';
import { applyTicketReview } from './ticketReviewApply';

function broadcast(sessionId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('gadgets:changed', sessionId);
  }
}

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

function policyFor(projectId: string): WorkflowPolicyProfile | undefined {
  return getWorkflowPolicyStore().effectiveForProject(projectId)?.profile;
}

/**
 * Approving in chat is the same decision as approving in the run monitor
 * (TASK-287): it goes through the identical `approveStage` the run monitor's
 * own Approve button calls, against whatever the run's current state actually
 * is — a stale gadget answered after the run moved on is refused here exactly
 * as `workflows:approveRun` would refuse it, not applied blind.
 */
async function approveWorkflowFromGadget(runId: string, nodeId: string): Promise<{ outcome: unknown; message: string }> {
  const run = runStore().get(runId);
  if (!run) throw new Error('That workflow run is no longer open on this host.');

  const approval = resolveApprovalTarget(run, nodeId);
  const result = approveStage(run, approval.id, { actor: 'desktop-user', at: new Date().toISOString() }, policyFor(run.projectId));
  if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');

  await getWorkflowOrchestrator().updateRun(runId, () => result.run);
  await getWorkflowOrchestrator().step(runId);
  return { outcome: { confirmed: true, approved: true }, message: `Approved — ${approval.name} will continue.` };
}

/**
 * What the host actually does once an action is authorised.
 *
 * Deliberately narrow. A gadget records a *decision*; it is not a second way to
 * reach the services that carry decisions out. Anything with real side effects
 * (applying a diff, advancing a run, deploying) stays behind the IPC surface
 * that already owns it, with its own gate checks — a gadget action that wanted
 * to do those things would have to call through them like any other caller.
 *
 * The one exception is approving a real workflow run: an `approval`-effect
 * action on an `approval` gadget calls through to the same `approveStage` the
 * run monitor uses, because that *is* the service that owns the gate — routing
 * it anywhere else would make the gadget a second, weaker approval path.
 *
 * The second is applying a ticket review: a `mutating` action on the review's
 * apply form, gated by `TICKET_REVIEW_APPLY_GATE`, writes the text the user
 * just edited and confirmed through the tracker service (`applyTicketReview`,
 * which refuses any session that is not a ticket review). The user's own click
 * on an editable form is the approval; the agent cannot apply anything itself.
 *
 * Everything else still only turns the recorded answer into the user-facing
 * confirmation, and lets the ledger be the durable evidence.
 */
async function executeGadgetAction({ envelope, action, record }: GadgetExecutionContext) {
  const descriptor = envelope.actions.find(candidate => candidate.actionId === action.actionId);
  const label = descriptor?.label ?? action.actionId;

  if (envelope.kind === 'approval' && descriptor?.effect === 'approval' && action.value.kind === 'confirmation') {
    const { nodeId } = envelope.payload;
    const runId = envelope.scope.workId;
    if (action.value.confirmed && runId && nodeId) {
      return approveWorkflowFromGadget(runId, nodeId);
    }
  }

  // The ticket-review apply form: the user has edited and confirmed the text,
  // and `applyTicketReview` writes it through the tracker service, refusing any
  // session that is not a ticket review.
  if (
    envelope.kind === 'form' &&
    descriptor?.effect === 'mutating' &&
    descriptor.gate === TICKET_REVIEW_APPLY_GATE &&
    action.value.kind === 'form'
  ) {
    return applyTicketReview(envelope.scope.sessionId, action.value.fields);
  }

  switch (action.value.kind) {
    case 'choice':
      return { outcome: { selected: action.value.selected }, message: `Recorded: ${label}.` };
    case 'selection':
      return { outcome: { selected: action.value.selected }, message: `Recorded ${action.value.selected.length} selection(s).` };
    case 'confirmation':
      return {
        outcome: { confirmed: action.value.confirmed },
        message: action.value.confirmed ? `Confirmed: ${label}.` : 'Declined — nothing was changed.'
      };
    case 'form':
      return { outcome: { fields: action.value.fields }, message: `Recorded: ${label}.` };
    default:
      return { outcome: { acknowledged: true }, message: `Recorded: ${label}.`, correlationId: record.correlationId };
  }
}

export function registerGadgetIpc(): void {
  ipcMain.handle('gadgets:getBlocks', async (_event, sessionId: string) =>
    getGadgetService().getBlocks(sessionId)
  );

  ipcMain.handle('gadgets:publish', async (_event, sessionId: string, blocks: RawChatBlockInput[]) => {
    const published = getGadgetService().publish(sessionId, blocks ?? []);
    broadcast(sessionId);
    return published;
  });

  ipcMain.handle('gadgets:publishFromText', async (_event, sessionId: string, idPrefix: string, text: string) => {
    const scope = resolveSessionScope(sessionId);
    // No live session means no scope to pin a gadget to. Returning the existing
    // blocks keeps a stale transcript readable without minting anything new.
    if (!scope) return getGadgetService().getBlocks(sessionId);

    const parsed = parseChatBlocks(text ?? '', { scope, issuedAt: new Date().toISOString(), idPrefix });
    if (!parsed.containsGadget) return getGadgetService().getBlocks(sessionId);

    const published = getGadgetService().publish(sessionId, parsed.blocks);
    broadcast(sessionId);
    return published;
  });

  ipcMain.handle('gadgets:submit', async (_event, request: GadgetSubmitRequest) => {
    const gadgets = getGadgetService();
    const now = new Date().toISOString();

    // The value crosses a process boundary from a renderer, so it is narrowed
    // before anything downstream is allowed to assume its shape.
    if (!isGadgetActionValue(request?.value)) {
      return {
        version: 1,
        gadgetId: request?.gadgetId ?? '',
        actionId: request?.actionId ?? '',
        correlationId: request?.correlationId ?? randomUUID(),
        idempotencyKey: request?.idempotencyKey ?? randomUUID(),
        status: 'rejected' as const,
        at: now,
        error: { code: 'value-invalid' as const, message: 'That answer was not in a form the host understands.', retryable: false }
      };
    }

    const scope = resolveSessionScope(request.sessionId);
    const envelope = gadgets.findGadget(request.sessionId, request.gadgetId);
    if (!scope || !envelope) {
      return {
        version: 1,
        gadgetId: request.gadgetId,
        actionId: request.actionId,
        correlationId: request.correlationId ?? randomUUID(),
        idempotencyKey: request.idempotencyKey ?? randomUUID(),
        status: 'rejected' as const,
        at: now,
        error: {
          code: (scope ? 'gadget-not-found' : 'scope-mismatch') as 'gadget-not-found' | 'scope-mismatch',
          message: scope ? 'This gadget is no longer available.' : 'That session is no longer open on this host.',
          retryable: false
        }
      };
    }

    // The scope on the action is the envelope's own, not anything the renderer
    // supplied — a client cannot retarget an approval by rewriting its request.
    const action: GadgetAction = {
      version: envelope.version,
      gadgetId: request.gadgetId,
      actionId: request.actionId,
      scope: envelope.scope,
      idempotencyKey: request.idempotencyKey || randomUUID(),
      correlationId: request.correlationId || randomUUID(),
      submittedAt: now,
      value: request.value
    };

    const result = await gadgets.submit(
      action,
      {
        hostId: scope.hostId,
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        workId: scope.workId
      },
      executeGadgetAction
    );
    broadcast(request.sessionId);
    return result;
  });

  ipcMain.handle('gadgets:replay', async (_event, afterSequence: number) =>
    getGadgetService().replay(Number.isFinite(afterSequence) ? afterSequence : 0)
  );

  ipcMain.handle('gadgets:revoke', async (_event, sessionId: string, gadgetId: string) => {
    getGadgetService().revoke(sessionId, gadgetId);
    broadcast(sessionId);
  });

  ipcMain.handle('gadgets:clear', async (_event, sessionId: string) => {
    getGadgetService().clearSession(sessionId);
    broadcast(sessionId);
  });
}
