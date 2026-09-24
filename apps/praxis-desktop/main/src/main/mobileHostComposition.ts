/**
 * Supplies the real `MobileHostServiceDeps` from the running desktop stores and
 * assembles the `MobileHostApplication` that `registerMobileElectronIpc` serves.
 *
 * The same services back Electron IPC and the authenticated LAN transport:
 * projects, sessions and streamed transcripts, workflow execution, attention,
 * request-specific permissions, cancellation, retry and approval.
 */
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  InMemoryMobileCommandLedger,
  PROVIDER_DESCRIPTORS,
  fingerprintMobileHostKey,
  type AgentSessionRecord,
  type AiProvider,
  type MobileCommandLedger,
  type MobileCommandOperation,
  type MobileModelCatalog,
  type MobileProviderCatalog,
  type MobileProviderOption,
  type MobileSessionModeOption,
  type ModelOptions,
  WorkflowRunStore,
  applyWorkflowRunCommand,
  approveStage,
  resolveApprovalTarget,
  summarizeWorkflowRun,
  type MobileCommand,
  type MobileHostApplication,
  type WorkflowPolicyProfile,
  type WorkflowRun,
} from '@praxis/core';
import { createDesktopMobileHostApplication } from './mobileHostApplication';
import {
  createMobileHostExecutionHandlers,
  createMobileHostReads,
  type MobileHostServiceDeps,
  type MobileProjectSummary,
  type MobileWorkItem,
} from './mobileHostServices';
import { getProjectStore } from './projectStoreInstance';
import { getWorkflowBackingStore, getWorkflowPolicyStore } from './workflowStoreInstance';
import { getWorkflowOrchestrator, onDidChangeWorkflowRun } from './workflowOrchestratorInstance';
import {
  getAiSessionManager,
  hasActiveTask,
  listAiProviderStatuses,
  listApiModelOptions,
  listCliModelOptions,
  respondToActivePermission,
} from './aiInstance';
import { getMobilePairingRegistry } from './mobilePairingInstance';
import { handoverSession, switchSessionMode, updateSessionModel } from './aiIpc';
import { getMobileHostIdentity } from './mobileHostIdentity';
import { getSettingsBackend } from './settingsBackendInstance';
import { cancelMobileInteractiveSession, continueMobileInteractiveSession, createMobileInteractiveSession } from './mobileInteractiveSessions';
import { getDesktopAppearance, onDidChangeDesktopAppearance } from './mobileAppearance';
import { appendMobileAppearanceEvent, appendMobileSessionEvent, mobileSessionSnapshot, mobileSessionSummary } from './mobileSessionProjection';
import { appendMobileRunEvent, mobileRunSnapshot } from './mobileRunProjection';
import { pendingMobilePermissions, respondToMobilePermission } from './mobilePermissions';
import { listWorkflowChoices, startWorkflowRun } from './workflowIpc';

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

function policyFor(projectId: string): WorkflowPolicyProfile | undefined {
  return getWorkflowPolicyStore().effectiveForProject(projectId)?.profile;
}

function summarize(run: WorkflowRun): ReturnType<typeof summarizeWorkflowRun> {
  return summarizeWorkflowRun(run, policyFor(run.projectId));
}

/**
 * A workflow stage's session is started by the run, not from a project, so its record has
 * no `projectId` — and the phone only ever sees sessions in the project it was granted.
 * It belongs to its run's project.
 */
function withRunProject(record: AgentSessionRecord): AgentSessionRecord {
  if (record.projectId || !record.workflowRunId) return record;
  const projectId = runStore().get(record.workflowRunId)?.projectId;
  return projectId ? { ...record, projectId } : record;
}

function requireRun(runId: string): WorkflowRun {
  const run = runStore().get(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  return run;
}

function projectSummary(project: { id: string; name: string; workflowStages: Array<{ name: string }> }): MobileProjectSummary {
  return { projectId: project.id, name: project.name, workflow: project.workflowStages.map(stage => stage.name).join(' → ') || undefined };
}

/**
 * The provider list as a phone may see it: availability and a readable reason,
 * never keys, key sources, base URLs or CLI paths.
 */
async function providerCatalog(projectId?: string): Promise<MobileProviderCatalog> {
  const settings = getSettingsBackend().read();
  const statuses = await listAiProviderStatuses();
  const providers = statuses.map((status): MobileProviderOption => {
    const descriptor = PROVIDER_DESCRIPTORS[status.provider];
    const configuredDefault = status.defaultModel?.trim();
    const defaultModel = configuredDefault || (descriptor.kind === 'api' ? descriptor.defaultModel : undefined);
    const base = {
      provider: status.provider,
      label: descriptor.label,
      kind: descriptor.kind === 'cli-agent' ? 'cli-agent' as const : 'api' as const,
      ...(defaultModel ? { defaultModel } : {}),
    };
    if (!status.enabled) {
      return { ...base, available: false, unavailableReason: 'disabled', unavailableMessage: `${descriptor.label} is turned off on the desktop (Settings → AI Provider).` };
    }
    if (!status.configured) {
      return descriptor.kind === 'cli-agent'
        ? { ...base, available: false, unavailableReason: 'cli-unavailable', unavailableMessage: `${descriptor.label} is not installed on the desktop, or Praxis cannot find it.` }
        : { ...base, available: false, unavailableReason: 'not-configured', unavailableMessage: `${descriptor.label} has no API key on the desktop. Add one in Settings → AI Provider.` };
    }
    return { ...base, available: true };
  });
  const project = projectId ? getProjectStore().get(projectId) : undefined;
  const chatTools = project?.defaultAiToolMode ?? 'full';
  const hasFolder = Boolean(project?.workspaceFolder?.trim() || settings.ai.workingDirectory.trim());
  const sessionModes: MobileSessionModeOption[] = [
    chatTools === 'full' && !hasFolder
      ? { mode: 'chat', available: false, toolAccess: 'full', unavailableMessage: 'This project needs a working folder on the desktop before a full-tools chat can start.' }
      : { mode: 'chat', available: true, toolAccess: chatTools === 'read-only' ? 'read-only' : 'full' },
    settings.ai.analysisPrompt.trim()
      ? { mode: 'analysis', available: true, toolAccess: 'read-only' }
      : { mode: 'analysis', available: false, toolAccess: 'read-only', unavailableMessage: 'Set an analysis system prompt under Settings → AI Provider on the desktop first.' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
  ];
  const defaultProvider = settings.ai.activeProvider;
  const defaultModel = providers.find(option => option.provider === defaultProvider)?.defaultModel;
  return { defaultProvider, ...(defaultModel ? { defaultModel } : {}), providers, sessionModes };
}

/** ACP model lists spawn the agent CLI, so they are cached briefly; API catalogs cache themselves. */
const cliModelCache = new Map<string, { at: number; options: ModelOptions | undefined }>();
const CLI_MODEL_TTL_MS = 5 * 60 * 1000;

async function modelCatalog(provider: string, refresh: boolean): Promise<MobileModelCatalog> {
  if (!(provider in PROVIDER_DESCRIPTORS)) throw new Error(`“${provider}” is not an AI provider this desktop knows.`);
  const id = provider as AiProvider;
  const descriptor = PROVIDER_DESCRIPTORS[id];
  let options: ModelOptions | undefined;
  try {
    if (descriptor.kind === 'api') {
      options = await listApiModelOptions(id, refresh);
      if (!options) {
        return { provider, status: 'unavailable', message: `The desktop could not load ${descriptor.label}’s model list. Check its API key and network on the desktop.`, models: [] };
      }
    } else {
      const cached = cliModelCache.get(provider);
      if (!refresh && cached && Date.now() - cached.at < CLI_MODEL_TTL_MS) {
        options = cached.options;
      } else {
        options = await listCliModelOptions(id);
        cliModelCache.set(provider, { at: Date.now(), options });
      }
      // No selector: the agent always uses its own default model.
      if (!options) return { provider, status: 'ok', message: `${descriptor.label} uses its own default model.`, models: [] };
    }
  } catch (error) {
    return { provider, status: 'unavailable', message: error instanceof Error ? error.message : String(error), models: [] };
  }
  return {
    provider,
    status: 'ok',
    ...(options.currentValue ? { defaultModel: options.currentValue } : {}),
    models: options.options.map(option => ({
      modelId: option.value,
      name: option.name,
      ...(option.contextLength ? { contextLength: option.contextLength } : {}),
    })),
  };
}

export function createDesktopMobileHostServiceDeps(
  configuredHostId?: string,
  ledger: Pick<MobileCommandLedger, 'latestSequence'> = { latestSequence: () => 0 },
): MobileHostServiceDeps {
  const hostId = configuredHostId?.trim() || (os.hostname() || 'praxis-desktop').trim();
  const hostName = (): string => getSettingsBackend().read().mobileAccess.hostName.trim() || os.hostname() || 'Praxis desktop';

  return {
    hostId,
    hostName,
    hostOnline: () => true,
    hostEpoch: randomUUID(),
    latestSequence: () => ledger.latestSequence(),
    appearance: getDesktopAppearance,
    providerCatalog,
    modelCatalog,
    describeDevice: async deviceId => {
      const settings = getSettingsBackend().read().mobileAccess;
      const device = getMobilePairingRegistry().listDevices().find(candidate => candidate.deviceId === deviceId && !candidate.revokedAt);
      const identity = await getMobileHostIdentity().catch(() => undefined);
      const projects = (device?.projectIds ?? []).map(projectId => ({ projectId, name: getProjectStore().get(projectId)?.name ?? projectId }));
      return {
        ...(device?.label ? { label: device.label } : {}),
        projects,
        ...(device?.pairedAt ? { pairedAt: device.pairedAt } : {}),
        ...(device?.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        hostName: hostName(),
        ...(identity ? { hostKeyFingerprint: fingerprintMobileHostKey(Buffer.from(identity.publicKey).toString('hex')) } : {}),
        accessMode: settings.mode,
      };
    },

    listProjects: async () => getProjectStore().list().map(projectSummary),
    getProject: async projectId => {
      const project = getProjectStore().get(projectId);
      return project ? projectSummary(project) : undefined;
    },
    listWork: async projectId => {
      const project = getProjectStore().get(projectId);
      if (!project) return [];
      const runsByWork = new Map<string, string>();
      for (const run of runStore().forProject(projectId)) {
        if (run.issueKey) runsByWork.set(run.issueKey, run.runId);
      }
      return project.workItems.map((item): MobileWorkItem => ({
        workId: item.key,
        title: item.summary,
        status: item.status,
        ...(runsByWork.has(item.key) ? { runId: runsByWork.get(item.key) } : {}),
      }));
    },
    listSessions: async projectId => [...getAiSessionManager().getAllAgentSessions().values()]
      .map(withRunProject)
      .filter(record => !projectId || record.projectId === projectId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(mobileSessionSummary),
    getSession: async sessionId => {
      const record = [...getAiSessionManager().getAllAgentSessions().values()].find(
        candidate => candidate.sessionId === sessionId || candidate.issueKey === sessionId,
      );
      if (!record) return undefined;
      return mobileSessionSnapshot(withRunProject(record), ledger.latestSequence());
    },
    listWorkflows: async projectId => listWorkflowChoices(projectId),
    listRuns: async projectId => runStore()
      .forProject(projectId)
      .filter(run => !run.archived)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(run => mobileRunSnapshot(summarize(run), ledger.latestSequence())),
    getRun: async runId => {
      const run = runStore().get(runId);
      return run ? summarize(run) : undefined;
    },
    listRunChanges: async runId => {
      const summary = summarize(requireRun(runId));
      return { runId, stages: summary.stages ?? [] };
    },
    listAttention: async projectId => {
      const items: Array<Record<string, unknown>> = [];
      for (const request of pendingMobilePermissions(getAiSessionManager().getAllAgentSessions().values())) {
        if (request.projectId === projectId) {
          items.push({
            id: `permission:${request.requestId}`,
            kind: 'permission',
            hostId,
            projectId,
            sessionId: request.sessionId,
            requestId: request.requestId,
            summary: request.summary,
            detail: request.detail,
            createdAt: request.createdAt,
            resolved: false,
          });
        }
      }
      for (const run of runStore().forProject(projectId)) {
        const summary = summarize(run);
        if (summary.status === 'awaiting-approval') {
          items.push({ id: `approval:${run.runId}`, kind: 'approval', hostId, projectId, runId: run.runId, summary: summary.workflowName, createdAt: run.startedAt, resolved: false });
        }
        for (const stage of summary.stages ?? []) {
          if (stage.outcome === 'failed') {
            items.push({ id: `failure:${run.runId}:${stage.nodeId}`, kind: 'failure', hostId, projectId, runId: run.runId, nodeId: stage.nodeId, summary: `${summary.workflowName} — ${stage.name}`, createdAt: run.startedAt, resolved: false });
          }
        }
      }
      return items;
    },

    createSession: async input => {
      const record = await createMobileInteractiveSession(input);
      return mobileSessionSnapshot(record, ledger.latestSequence());
    },
    startRun: async input => startWorkflowRun({
      projectId: input.projectId,
      workflowId: input.workflowId,
      taskTitle: input.task?.trim() || 'Started from Praxis mobile',
    }),
    cancelRun: async (runId, reason) => {
      await getWorkflowOrchestrator().cancel(runId, reason);
      return summarize(requireRun(runId));
    },
    retryStage: async (runId, nodeId) => {
      await getWorkflowOrchestrator().updateRun(runId, run =>
        applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId, at: new Date().toISOString() }),
      );
      await getWorkflowOrchestrator().step(runId);
      return summarize(requireRun(runId));
    },
    approveRun: async (runId, actor, note) => {
      await getWorkflowOrchestrator().updateRun(runId, run => {
        const approval = resolveApprovalTarget(run);
        const result = approveStage(
          run,
          approval.id,
          { actor, at: new Date().toISOString(), ...(note ? { note } : {}) },
          policyFor(run.projectId),
        );
        if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');
        return result.run;
      });
      await getWorkflowOrchestrator().step(runId);
      return summarize(requireRun(runId));
    },
    continueSession: async (sessionId, message) => mobileSessionSnapshot(await continueMobileInteractiveSession(sessionId, message), ledger.latestSequence()),
    configureSession: async (sessionId, change) => {
      const record = [...getAiSessionManager().getAllAgentSessions().values()].find(candidate => candidate.sessionId === sessionId);
      if (!record) throw new Error(`No agent session found for ${sessionId}.`);
      if (change.mode) switchSessionMode(record.issueKey, change.mode);
      if (change.model) await updateSessionModel(record.issueKey, change.model);
      if (change.handover) {
        await handoverSession(record.issueKey, {
          provider: change.handover.provider as AiProvider,
          ...(change.handover.model ? { model: change.handover.model } : {}),
          expectedBriefRevision: getAiSessionManager().getAgentSession(record.issueKey)?.handoverBrief?.revision ?? 0,
        });
      }
      return mobileSessionSnapshot(getAiSessionManager().getAgentSession(record.issueKey)!, ledger.latestSequence());
    },
    cancelSession: async sessionId => mobileSessionSnapshot(await cancelMobileInteractiveSession(sessionId), ledger.latestSequence()),
    respondToPermission: async (requestId, decision, _actor, projectId) => respondToMobilePermission({
      records: getAiSessionManager().getAllAgentSessions().values(),
      requestId,
      projectId,
      decision,
      hasActiveTask,
      respond: respondToActivePermission,
    }),
  };
}

export function composeDesktopMobileHost(hostId?: string): MobileHostApplication {
  const ledger = new InMemoryMobileCommandLedger();
  const deps = createDesktopMobileHostServiceDeps(hostId, ledger);
  const commands = createMobileHostExecutionHandlers(deps);
  const app = createDesktopMobileHostApplication({
    reads: createMobileHostReads(deps, Object.keys(commands) as MobileCommandOperation[]),
    commands,
    ledger,
    payloadDigest: (command: unknown) => JSON.stringify((command as MobileCommand).payload ?? null),
  });
  getAiSessionManager().onDidChangeAgentSession(record => appendMobileSessionEvent(ledger, deps.hostId, withRunProject(record)));
  // A deleted run is gone from the store by the time it is announced, so remember each
  // run's project to scope its removal to the phones that could see it.
  const runProjects = new Map<string, string>();
  onDidChangeWorkflowRun(runId => {
    const run = runStore().get(runId);
    if (!run || run.archived) {
      const projectId = run?.projectId ?? runProjects.get(runId);
      runProjects.delete(runId);
      if (projectId) appendMobileRunEvent(ledger, deps.hostId, { removed: { runId, projectId } });
      return;
    }
    runProjects.set(runId, run.projectId);
    appendMobileRunEvent(ledger, deps.hostId, { summary: summarize(run) });
  });
  onDidChangeDesktopAppearance(appearance => appendMobileAppearanceEvent(ledger, deps.hostId, appearance));
  return app;
}
