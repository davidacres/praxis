import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import {
  isGadgetActionValue,
  parseChatBlocks,
  type GadgetAction,
  type GadgetExecutionContext,
  type GadgetSubmitRequest,
  type RawChatBlockInput
} from '@praxis/core';
import { getGadgetService, resolveSessionScope } from './gadgetInstance';

function broadcast(sessionId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('gadgets:changed', sessionId);
  }
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
 * So the executor's job is to turn the recorded answer into the user-facing
 * confirmation, and let the ledger be the durable evidence.
 */
async function executeGadgetAction({ envelope, action, record }: GadgetExecutionContext) {
  const descriptor = envelope.actions.find(candidate => candidate.actionId === action.actionId);
  const label = descriptor?.label ?? action.actionId;

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
