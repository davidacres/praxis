import type React from 'react';
import type {
  GadgetActionResult,
  MobileCommand,
  MobileCommandOperation,
  MobileFileDiff,
  MobileHostInfo,
  MobileModelCatalog,
  MobileProviderCatalog,
  MobileReadOperation,
  MobileSessionChanges,
  MobileSessionSnapshot,
  MobileSessionUsage,
} from '@praxis/core';
import { addFollowUp, updateFollowUp, type MobileFollowUp } from '../../renderer/mobileFollowUp';
import { effectiveSelection, selectionPayload, validateSelection, DEFAULT_SESSION_SELECTION } from '../../renderer/mobileSessionOptions';
import { answerNeedsIdentity, gadgetIdempotencyKey } from '../../renderer/mobileGadgets';
import type { MobileShellState } from '../../renderer/mobileShellState';
import { confirmIdentity } from '../confirmIdentity';
import type { NativeMobileConnection } from '../mobileConnection';
import { caller, commandId, readRequest } from './projections';
import type { MobileHostSummary, MobileRunSummary, MobileWorkItem, Remote, Store } from './types';

/** What the actions read and write — the provider's refs and setters, passed in rather than closed over. */
export interface StoreActionContext {
  connectionRef: React.MutableRefObject<NativeMobileConnection | undefined>;
  configRef: React.MutableRefObject<{ hostId: string } | undefined>;
  projectRef: React.MutableRefObject<string | undefined>;
  hostInfoRef: React.MutableRefObject<MobileHostInfo | undefined>;
  phaseRef: React.MutableRefObject<MobileShellState['connection']>;
  commandsRef: React.MutableRefObject<Map<string, { command: MobileCommand; workId: string; draft: boolean }>>;
  host: MobileHostSummary;
  providers: Remote<MobileProviderCatalog>;
  models: Record<string, Remote<MobileModelCatalog>>;
  applySnapshot(snapshot: MobileSessionSnapshot): void;
  setWork: React.Dispatch<React.SetStateAction<MobileWorkItem[]>>;
  setFollowUps: React.Dispatch<React.SetStateAction<MobileFollowUp[]>>;
  setOpenWorkId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRuns: React.Dispatch<React.SetStateAction<Record<string, MobileRunSummary>>>;
  setUsageReads: React.Dispatch<React.SetStateAction<Record<string, MobileSessionUsage>>>;
  setProviders: React.Dispatch<React.SetStateAction<Remote<MobileProviderCatalog>>>;
  setModels: React.Dispatch<React.SetStateAction<Record<string, Remote<MobileModelCatalog>>>>;
  /** Hides an attention item the person just acted on, until the desktop's next word. */
  markResolved(id: string): void;
}

type ActionKeys =
  | 'loadSession' | 'retryStage' | 'refreshUsage' | 'refreshProviders' | 'loadModels' | 'configureSession'
  | 'sendFollowUp' | 'retryFollowUp' | 'cancelSession' | 'respondToPermission' | 'startWorkflow' | 'approve'
  | 'reject' | 'canCommand' | 'loadRun' | 'answerGadget' | 'changesSupported' | 'sessionChanges' | 'fileDiff';

const UPDATE_DESKTOP = 'Update Praxis on the desktop to do this from the phone.';

export function createStoreActions(ctx: StoreActionContext): Pick<Store, ActionKeys> {
  const target = (extra: Record<string, string | undefined> = {}) => ({
    hostId: ctx.configRef.current?.hostId ?? ctx.host.hostId,
    ...(ctx.projectRef.current ? { projectId: ctx.projectRef.current } : {}),
    ...extra,
  });

  const supports = (operation: MobileReadOperation): boolean =>
    ctx.hostInfoRef.current ? ctx.hostInfoRef.current.readOperations.includes(operation) : false;
  const offers = (operation: MobileCommandOperation): boolean =>
    Boolean(ctx.hostInfoRef.current?.commandOperations.includes(operation));

  const requireConnection = (): NativeMobileConnection => {
    const connection = ctx.connectionRef.current;
    if (!connection || ctx.phaseRef.current !== 'ready') {
      throw new Error(ctx.phaseRef.current === 'reconnecting'
        ? 'The desktop connection dropped. Praxis is reconnecting — try again in a moment.'
        : 'Connect to a desktop project first.');
    }
    return connection;
  };

  const command = <T = unknown>(operation: MobileCommandOperation, prefix: string, extraTarget: Record<string, string | undefined>, payload: unknown): Promise<T> =>
    requireConnection().command<T>({
      protocolVersion: 1,
      commandId: commandId(prefix),
      issuedAt: new Date().toISOString(),
      caller,
      target: target(extraTarget),
      operation,
      payload,
    });

  const sendCommand = async (messageId: string): Promise<void> => {
    const entry = ctx.commandsRef.current.get(messageId);
    if (!entry) return;
    try {
      const snapshot = await requireConnection().command<MobileSessionSnapshot>(entry.command);
      ctx.commandsRef.current.delete(messageId);
      ctx.applySnapshot(snapshot);
      ctx.setOpenWorkId(snapshot.sessionKey);
      if (entry.draft) ctx.setWork(previous => previous.filter(item => !item.draft || item.workId !== entry.workId));
      ctx.setFollowUps(list => list.filter(message => message.messageId !== messageId));
    } catch (error) {
      ctx.setFollowUps(list => updateFollowUp(list, messageId, 'failed', error instanceof Error ? error.message : String(error)) as MobileFollowUp[]);
    }
  };

  const catalog = ctx.providers.value;

  return {
    loadSession: async sessionId => {
      const connection = ctx.connectionRef.current;
      if (!connection || ctx.phaseRef.current !== 'ready') return;
      ctx.applySnapshot(await connection.read<MobileSessionSnapshot>(readRequest('sessions.get', target({ sessionId }))));
    },
    retryStage: async (runId, nodeId) => {
      await command('workflowRuns.retryStage', 'retry', { runId }, { nodeId });
    },
    refreshUsage: async sessionId => {
      const connection = ctx.connectionRef.current;
      if (!connection || ctx.phaseRef.current !== 'ready' || !supports('sessions.usage')) return;
      const usage = await connection.read<MobileSessionUsage>(readRequest('sessions.usage', target({ sessionId })));
      ctx.setUsageReads(previous => ({ ...previous, [sessionId]: usage }));
    },
    refreshProviders: async () => {
      const connection = ctx.connectionRef.current;
      if (!connection || ctx.phaseRef.current !== 'ready' || !supports('providers.list')) return;
      ctx.setProviders(previous => ({ ...previous, status: 'loading' }));
      try {
        ctx.setProviders({ status: 'ready', value: await connection.read<MobileProviderCatalog>(readRequest('providers.list', target())) });
      } catch (error) {
        ctx.setProviders(previous => ({ ...previous, status: 'error', message: error instanceof Error ? error.message : String(error) }));
      }
    },
    loadModels: async (provider, refresh = false) => {
      const connection = ctx.connectionRef.current;
      if (!connection || ctx.phaseRef.current !== 'ready' || !supports('models.list')) return;
      ctx.setModels(previous => ({ ...previous, [provider]: { ...previous[provider], status: 'loading' } }));
      try {
        const catalogForProvider = await connection.read<MobileModelCatalog>(readRequest('models.list', target(), { provider, ...(refresh ? { refresh: true } : {}) }));
        ctx.setModels(previous => ({ ...previous, [provider]: { status: 'ready', value: catalogForProvider } }));
      } catch (error) {
        ctx.setModels(previous => ({ ...previous, [provider]: { status: 'error', message: error instanceof Error ? error.message : String(error) } }));
      }
    },
    configureSession: async (item, change) => {
      ctx.applySnapshot(await command<MobileSessionSnapshot>('sessions.configure', 'configure', { sessionId: item.sessionId }, change));
    },
    sendFollowUp: async (item, text) => {
      const projectId = ctx.projectRef.current;
      if (!projectId) throw new Error('Connect to a desktop project before sending a message.');
      const messageId = commandId('message');
      const base = { protocolVersion: 1 as const, commandId: messageId, issuedAt: new Date().toISOString(), caller };
      let next: MobileCommand;
      if (item.draft) {
        const selection = effectiveSelection(catalog, item.selection ?? DEFAULT_SESSION_SELECTION, ctx.models[item.selection?.provider ?? '']?.value);
        const verdict = validateSelection(catalog, selection, selection.provider ? ctx.models[selection.provider]?.value : undefined);
        if (!verdict.ok) throw new Error(verdict.message);
        next = { ...base, operation: 'sessions.create', target: target(), payload: { title: text.slice(0, 80), message: text, ...selectionPayload(selection) } };
      } else {
        next = { ...base, operation: 'sessions.continue', target: target({ sessionId: item.sessionId }), payload: { message: text } };
      }
      ctx.commandsRef.current.set(messageId, { command: next, workId: item.workId, draft: Boolean(item.draft) });
      ctx.setFollowUps(list => addFollowUp(list, {
        messageId,
        hostId: ctx.host.hostId,
        projectId,
        sessionId: item.sessionId,
        workId: item.workId,
        text,
        state: 'pending',
        createdAt: new Date().toISOString(),
      }) as MobileFollowUp[]);
      await sendCommand(messageId);
    },
    retryFollowUp: async messageId => {
      // Same command id: if the desktop already ran it, it answers with the recorded outcome.
      ctx.setFollowUps(list => updateFollowUp(list, messageId, 'pending') as MobileFollowUp[]);
      await sendCommand(messageId);
    },
    cancelSession: async sessionId => {
      ctx.applySnapshot(await command<MobileSessionSnapshot>('sessions.cancel', 'cancel', { sessionId }, {}));
    },
    respondToPermission: async (requestId, decision) => {
      // Denying is always safe; allowing lets an agent act on the desktop.
      if (decision === 'allow' && !(await confirmIdentity('Allow the agent to do this on your desktop'))) return false;
      await command('permissions.respond', 'permission', { requestId }, { decision });
      ctx.markResolved(`permission:${requestId}`);
      return true;
    },
    startWorkflow: async (workflowId, task) => {
      await command('workflowRuns.start', 'workflow', {}, { workflowId, task });
    },
    approve: async runId => {
      if (!(await confirmIdentity('Approve this workflow run'))) return false;
      await command('workflowGates.approve', 'approve', { runId }, {});
      ctx.markResolved(`approval:${runId}`);
      return true;
    },
    reject: async (runId, reason) => {
      if (!offers('workflowGates.reject')) throw new Error(UPDATE_DESKTOP);
      if (!reason.trim()) throw new Error('Say why you are rejecting — the reason is recorded on the run.');
      if (!(await confirmIdentity('Reject this workflow run'))) return false;
      await command('workflowGates.reject', 'reject', { runId }, { reason: reason.trim() });
      ctx.markResolved(`approval:${runId}`);
      return true;
    },
    canCommand: operation => ctx.phaseRef.current === 'ready' && offers(operation),
    loadRun: async runId => {
      const connection = ctx.connectionRef.current;
      if (!connection || ctx.phaseRef.current !== 'ready') return;
      const summary = await connection.read<MobileRunSummary>(readRequest('workflowRuns.get', target({ runId })));
      ctx.setRuns(previous => ({ ...previous, [runId]: summary }));
    },
    answerGadget: async (sessionId, gadget, action, value) => {
      if (!offers('gadgets.submit')) throw new Error(UPDATE_DESKTOP);
      if (answerNeedsIdentity(action) && !(await confirmIdentity(action.label))) throw new Error('Not sent — the phone could not confirm it was you.');
      const result = await requireConnection().command<GadgetActionResult>({
        protocolVersion: 1,
        commandId: commandId('gadget'),
        issuedAt: new Date().toISOString(),
        caller,
        target: target({ sessionId }),
        operation: 'gadgets.submit',
        payload: { gadgetId: gadget.gadgetId, actionId: action.actionId, value, idempotencyKey: gadgetIdempotencyKey(gadget.gadgetId, action.actionId, value) },
      });
      if (result.status === 'rejected' || result.status === 'failed') throw new Error(result.error?.message ?? result.message ?? 'The desktop did not accept this answer.');
    },
    changesSupported: Boolean(ctx.hostInfoRef.current && ctx.hostInfoRef.current.surfaceRevision >= 5 && supports('changes.get')),
    sessionChanges: async sessionId => {
      if (!(ctx.hostInfoRef.current && ctx.hostInfoRef.current.surfaceRevision >= 5)) throw new Error(UPDATE_DESKTOP);
      return requireConnection().read<MobileSessionChanges>(readRequest('changes.get', target({ sessionId })));
    },
    fileDiff: async (sessionId, path) => requireConnection().read<MobileFileDiff>(readRequest('changes.get', target({ sessionId }), { path })),
  };
}
