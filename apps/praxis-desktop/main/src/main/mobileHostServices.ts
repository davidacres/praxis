/**
 * The desktop's `MobileHostReads` / `MobileExecutionHandlers` — the read and
 * command surface a paired phone drives, expressed as a pure function of a
 * narrow dependency interface so it unit-tests with fakes and never reaches for
 * an Electron global itself. `mobileHostComposition.ts` supplies the real
 * dependencies from the running session, workflow and project stores.
 *
 * These handlers do not re-check capability or protocol version: core's
 * `handleMobileCommand` / `handleMobileRead` already validate the envelope and
 * the caller's capability before dispatching here. What they add is field
 * extraction from the target/payload, a fail-closed error when a required
 * identifier is missing, and — per the architecture note "derive audit actor
 * from verified identity; never accept arbitrary actor text" — an actor taken
 * from the authenticated caller, never from the payload.
 */
import {
  MOBILE_HOST_SURFACE_REVISION,
  MOBILE_PROTOCOL_VERSION,
  type MobileCaller,
  type MobileCommand,
  type MobileCommandOperation,
  type MobileDeviceAccess,
  type MobileExecutionHandlers,
  type MobileHostInfo,
  type MobileHostReads,
  type MobileModelCatalog,
  type MobileProviderCatalog,
  type MobileReadOperation,
  type MobileReadRequest,
  type MobileSessionMode,
  type MobileSessionSnapshot,
  type MobileSessionSummary,
  type MobileSessionUsage,
} from '@praxis/core';

export interface MobileProjectSummary {
  projectId: string;
  name: string;
  workflow?: string;
}

export interface MobileWorkItem {
  workId: string;
  title: string;
  status: string;
  sessionId?: string;
  runId?: string;
}

export interface MobileSessionRuntimeChange {
  mode?: MobileSessionMode;
  /** Same provider, different model. */
  model?: string;
  /** Different provider: the desktop's handover (brief + a new turn). */
  handover?: { provider: string; model?: string };
}

/** What the desktop knows about a paired device, minus what the caller already proves. */
export type MobileDeviceRecord = Omit<MobileDeviceAccess, 'deviceId' | 'capabilities' | 'transport' | 'protocolVersion' | 'surfaceRevision'>;

export interface MobileHostServiceDeps {
  hostId: string;
  hostName(): string;
  hostOnline(): boolean;
  /** Changes when the desktop process restarts (event sequences restart with it). */
  hostEpoch: string;
  latestSequence(): number;

  /** Every provider, stripped of keys/URLs/paths, plus which session modes can start in `projectId`. */
  providerCatalog(projectId?: string): Promise<MobileProviderCatalog>;
  /** Models for an available provider; `status: 'unavailable'` when the list cannot be read. */
  modelCatalog(provider: string, refresh: boolean): Promise<MobileModelCatalog>;
  describeDevice(deviceId: string): Promise<MobileDeviceRecord>;

  listProjects(): Promise<readonly MobileProjectSummary[]>;
  getProject(projectId: string): Promise<MobileProjectSummary | undefined>;
  listWork(projectId: string): Promise<readonly MobileWorkItem[]>;
  listSessions(projectId?: string): Promise<readonly MobileSessionSummary[]>;
  getSession(sessionId: string): Promise<MobileSessionSnapshot | undefined>;
  listWorkflows(projectId: string): Promise<readonly { workflowId: string; name: string; trigger: string }[]>;
  getRun(runId: string): Promise<unknown | undefined>;
  listRunChanges(runId: string): Promise<unknown>;
  listAttention(projectId: string): Promise<readonly unknown[]>;

  createSession(input: { projectId: string; title: string; message: string; provider: string; model?: string; mode: MobileSessionMode }): Promise<MobileSessionSnapshot>;
  startRun(input: { projectId: string; workflowId: string; task?: string }): Promise<{ runId: string }>;
  cancelRun(runId: string, reason: string | undefined, actor: string): Promise<unknown>;
  retryStage(runId: string, nodeId: string, actor: string): Promise<unknown>;
  approveRun(runId: string, actor: string, note: string | undefined): Promise<unknown>;
  continueSession(sessionId: string, message: string, actor: string): Promise<unknown>;
  /** Applies validated between-turn changes: mode, then model, then (last, as it starts a turn) a provider handover. */
  configureSession(sessionId: string, change: MobileSessionRuntimeChange, actor: string): Promise<MobileSessionSnapshot>;
  cancelSession(sessionId: string, actor: string): Promise<unknown>;
  respondToPermission(requestId: string, decision: 'allow' | 'deny', actor: string, projectId: string): Promise<unknown>;
}

/** The verified caller's identity — a subject when signed in, otherwise the paired device. */
export function mobileActorFor(caller: MobileCaller): string {
  return caller.subject?.trim() || caller.deviceId;
}

function requireTarget(request: MobileReadRequest | MobileCommand, key: 'projectId' | 'runId' | 'sessionId' | 'requestId'): string {
  const value = request.target[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${request.operation} requires target.${key}.`);
  }
  return value;
}

function payloadField(command: MobileCommand, key: string): unknown {
  const payload = command.payload;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

function resourceProject(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { projectId?: unknown }).projectId === 'string'
    ? (value as { projectId: string }).projectId
    : undefined;
}

async function requireSessionInProject(deps: MobileHostServiceDeps, sessionId: string, projectId: string): Promise<MobileSessionSnapshot> {
  const session = await deps.getSession(sessionId);
  if (!session || session.projectId !== projectId) throw new Error(`Session ${sessionId} was not found in project ${projectId}.`);
  return session;
}

async function requireRunInProject(deps: MobileHostServiceDeps, runId: string, projectId: string): Promise<unknown> {
  const run = await deps.getRun(runId);
  if (run === undefined || resourceProject(run) !== projectId) throw new Error(`Run ${runId} was not found in project ${projectId}.`);
  return run;
}

const SESSION_MODES: readonly MobileSessionMode[] = ['chat', 'analysis', 'review'];

/**
 * Checks a phone's provider / model / mode choice against what this desktop
 * can actually launch, with a message a person can act on. The phone only
 * offers available choices, but it may be showing a stale catalog.
 */
export async function resolveMobileSessionLaunch(
  deps: Pick<MobileHostServiceDeps, 'providerCatalog' | 'modelCatalog'>,
  projectId: string,
  requested: { provider?: unknown; model?: unknown; mode?: unknown },
): Promise<{ provider: string; model?: string; mode: MobileSessionMode }> {
  const catalog = await deps.providerCatalog(projectId);
  const provider = typeof requested.provider === 'string' && requested.provider.trim() ? requested.provider.trim() : catalog.defaultProvider;
  const option = catalog.providers.find(candidate => candidate.provider === provider);
  if (!option) throw new Error(`“${provider}” is not an AI provider this desktop knows. Refresh the provider list and choose another.`);
  if (!option.available) throw new Error(option.unavailableMessage ?? `${option.label} is not available on this desktop.`);

  const mode = requested.mode === undefined || requested.mode === '' ? 'chat' : requested.mode;
  if (typeof mode !== 'string' || !SESSION_MODES.includes(mode as MobileSessionMode)) {
    throw new Error(`“${String(mode)}” is not a session mode. Choose Chat, Analysis or Review.`);
  }
  const modeOption = catalog.sessionModes.find(candidate => candidate.mode === mode);
  if (modeOption && !modeOption.available) throw new Error(modeOption.unavailableMessage ?? `${mode} sessions are not available for this project.`);

  const model = typeof requested.model === 'string' ? requested.model.trim() : '';
  if (!model) return { provider, mode: mode as MobileSessionMode };
  const models = await deps.modelCatalog(provider, false);
  if (models.status !== 'ok') {
    throw new Error(`Praxis could not confirm that ${option.label} offers “${model}”${models.message ? ` (${models.message})` : ''}. Choose the provider default instead.`);
  }
  if (!models.models.some(candidate => candidate.modelId === model)) {
    throw new Error(`${option.label} on this desktop does not offer the model “${model}”. Refresh the model list and choose another.`);
  }
  return { provider, model, mode: mode as MobileSessionMode };
}

/**
 * Works out what `sessions.configure` should change on an existing session,
 * refusing anything the desktop could not do right now with a readable reason.
 */
export async function resolveMobileSessionChange(
  deps: Pick<MobileHostServiceDeps, 'providerCatalog' | 'modelCatalog'>,
  session: MobileSessionSnapshot,
  requested: { provider?: unknown; model?: unknown; mode?: unknown },
): Promise<MobileSessionRuntimeChange> {
  if (session.canCancel || session.lifecycle === 'active') {
    throw new Error('Wait for the current turn to finish before changing the provider, model or mode.');
  }
  if (session.archived) throw new Error('This session is archived. Restore it on the desktop first.');
  const catalog = await deps.providerCatalog(session.projectId);
  const current = session.provider ?? catalog.defaultProvider;
  const provider = typeof requested.provider === 'string' && requested.provider.trim() ? requested.provider.trim() : current;
  const model = typeof requested.model === 'string' && requested.model.trim() ? requested.model.trim() : undefined;
  const option = catalog.providers.find(candidate => candidate.provider === provider);
  const change: MobileSessionRuntimeChange = {};

  if (requested.mode !== undefined && requested.mode !== session.mode) {
    if (typeof requested.mode !== 'string' || !SESSION_MODES.includes(requested.mode as MobileSessionMode)) {
      throw new Error(`“${String(requested.mode)}” is not a session mode. Choose Chat, Analysis or Review.`);
    }
    const modeOption = catalog.sessionModes.find(candidate => candidate.mode === requested.mode);
    if (modeOption && !modeOption.available) throw new Error(modeOption.unavailableMessage ?? `${String(requested.mode)} is not available for this project.`);
    change.mode = requested.mode as MobileSessionMode;
  }

  const providerChanged = provider !== current;
  if (providerChanged || (model && model !== session.model)) {
    if (!option) throw new Error(`“${provider}” is not an AI provider this desktop knows. Refresh the provider list and choose another.`);
    if (!option.available) throw new Error(option.unavailableMessage ?? `${option.label} is not available on this desktop.`);
    if (model) {
      const models = await deps.modelCatalog(provider, false);
      if (models.status !== 'ok') {
        throw new Error(`Praxis could not confirm that ${option.label} offers “${model}”${models.message ? ` (${models.message})` : ''}. Choose the provider default instead.`);
      }
      if (!models.models.some(candidate => candidate.modelId === model)) {
        throw new Error(`${option.label} on this desktop does not offer the model “${model}”. Refresh the model list and choose another.`);
      }
    }
    if (providerChanged) change.handover = { provider, ...(model ? { model } : {}) };
    else if (model) change.model = model;
  }
  return change;
}

/** Usage running totals of a session, as recorded on the desktop — never estimated. */
export function mobileSessionUsage(snapshot: MobileSessionSnapshot, providerLabel?: string): MobileSessionUsage {
  return {
    sessionId: snapshot.sessionId,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(snapshot.model ? { model: snapshot.model } : {}),
    lifecycle: snapshot.lifecycle,
    ...(snapshot.tokenUsage ? { tokenUsage: snapshot.tokenUsage } : {}),
    ...(snapshot.contextTokens !== undefined ? { contextTokens: snapshot.contextTokens } : {}),
    ...(snapshot.contextLimit !== undefined ? { contextLimit: snapshot.contextLimit } : {}),
    ...(snapshot.cost ? { cost: snapshot.cost } : {}),
    costStatus: snapshot.cost ? 'reported' : 'not-reported',
    sequence: snapshot.sequence,
  };
}

export function createMobileHostReads(deps: MobileHostServiceDeps, commandOperations: readonly MobileCommandOperation[] = []): MobileHostReads {
  const reads: MobileHostReads = {
    'hosts.list': async () => [
      { hostId: deps.hostId, hostName: deps.hostName(), online: deps.hostOnline() },
    ],
    'host.info': async (): Promise<MobileHostInfo> => ({
      hostId: deps.hostId,
      hostName: deps.hostName(),
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      surfaceRevision: MOBILE_HOST_SURFACE_REVISION,
      readOperations: Object.keys(reads) as MobileReadOperation[],
      commandOperations,
      latestSequence: deps.latestSequence(),
      hostEpoch: deps.hostEpoch,
    }),
    'providers.list': async (request: MobileReadRequest) => deps.providerCatalog(request.target.projectId?.trim() || undefined),
    'models.list': async (request: MobileReadRequest): Promise<MobileModelCatalog> => {
      const catalog = await deps.providerCatalog(request.target.projectId?.trim() || undefined);
      const provider = request.params?.provider?.trim() || catalog.defaultProvider;
      const option = catalog.providers.find(candidate => candidate.provider === provider);
      if (!option) throw new Error(`“${provider}” is not an AI provider this desktop knows.`);
      if (!option.available) {
        return { provider, status: 'provider-unavailable', ...(option.unavailableMessage ? { message: option.unavailableMessage } : {}), models: [] };
      }
      return deps.modelCatalog(provider, request.params?.refresh === true);
    },
    'sessions.usage': async (request: MobileReadRequest) => {
      const snapshot = await requireSessionInProject(deps, requireTarget(request, 'sessionId'), requireTarget(request, 'projectId'));
      const catalog = snapshot.provider ? await deps.providerCatalog(snapshot.projectId) : undefined;
      return mobileSessionUsage(snapshot, catalog?.providers.find(option => option.provider === snapshot.provider)?.label);
    },
    'access.get': async (request: MobileReadRequest): Promise<MobileDeviceAccess> => ({
      deviceId: request.caller.deviceId,
      capabilities: request.caller.capabilities,
      ...(await deps.describeDevice(request.caller.deviceId)),
      transport: 'noise-ik',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      surfaceRevision: MOBILE_HOST_SURFACE_REVISION,
    }),
    'projects.snapshot': async (request: MobileReadRequest) => {
      const projectId = request.target.projectId?.trim();
      if (projectId) {
        const project = await deps.getProject(projectId);
        if (!project) throw new Error(`Project ${projectId} was not found.`);
        return project;
      }
      return { projects: await deps.listProjects() };
    },
    'work.list': async (request: MobileReadRequest) => deps.listWork(requireTarget(request, 'projectId')),
    'sessions.list': async (request: MobileReadRequest) => deps.listSessions(request.target.projectId?.trim() || undefined),
    'sessions.get': async (request: MobileReadRequest) => {
      const sessionId = requireTarget(request, 'sessionId');
      return requireSessionInProject(deps, sessionId, requireTarget(request, 'projectId'));
    },
    'workflows.list': async (request: MobileReadRequest) => deps.listWorkflows(requireTarget(request, 'projectId')),
    'workflowRuns.get': async (request: MobileReadRequest) => {
      const runId = requireTarget(request, 'runId');
      return requireRunInProject(deps, runId, requireTarget(request, 'projectId'));
    },
    'changes.get': async (request: MobileReadRequest) => {
      const runId = requireTarget(request, 'runId');
      await requireRunInProject(deps, runId, requireTarget(request, 'projectId'));
      return deps.listRunChanges(runId);
    },
    'attention.list': async (request: MobileReadRequest) => deps.listAttention(requireTarget(request, 'projectId')),
  };
  return reads;
}

export function createMobileHostExecutionHandlers(deps: MobileHostServiceDeps): MobileExecutionHandlers {
  return {
    'sessions.create': async (command: MobileCommand) => {
      const projectId = requireTarget(command, 'projectId');
      const title = String(payloadField(command, 'title') ?? '').trim();
      const message = String(payloadField(command, 'message') ?? '').trim();
      if (!message) throw new Error('sessions.create requires a non-empty payload.message.');
      const launch = await resolveMobileSessionLaunch(deps, projectId, {
        provider: payloadField(command, 'provider'),
        model: payloadField(command, 'model'),
        mode: payloadField(command, 'mode'),
      });
      return deps.createSession({
        projectId,
        title: title || message.slice(0, 80),
        message,
        provider: launch.provider,
        ...(launch.model ? { model: launch.model } : {}),
        mode: launch.mode,
      });
    },
    'sessions.continue': async (command: MobileCommand) => {
      const sessionId = requireTarget(command, 'sessionId');
      await requireSessionInProject(deps, sessionId, requireTarget(command, 'projectId'));
      const message = String(payloadField(command, 'message') ?? '').trim();
      if (!message) throw new Error('sessions.continue requires a non-empty payload.message.');
      return deps.continueSession(sessionId, message, mobileActorFor(command.caller));
    },
    'sessions.configure': async (command: MobileCommand) => {
      const sessionId = requireTarget(command, 'sessionId');
      const session = await requireSessionInProject(deps, sessionId, requireTarget(command, 'projectId'));
      const change = await resolveMobileSessionChange(deps, session, {
        provider: payloadField(command, 'provider'),
        model: payloadField(command, 'model'),
        mode: payloadField(command, 'mode'),
      });
      if (!change.mode && !change.model && !change.handover) return session;
      return deps.configureSession(sessionId, change, mobileActorFor(command.caller));
    },
    'sessions.cancel': async (command: MobileCommand) => {
      const sessionId = requireTarget(command, 'sessionId');
      await requireSessionInProject(deps, sessionId, requireTarget(command, 'projectId'));
      return deps.cancelSession(sessionId, mobileActorFor(command.caller));
    },
    'workflowRuns.start': async (command: MobileCommand) => {
      const projectId = requireTarget(command, 'projectId');
      const workflowId = String(payloadField(command, 'workflowId') ?? '').trim();
      if (!workflowId) throw new Error('workflowRuns.start requires payload.workflowId.');
      const task = payloadField(command, 'task');
      return deps.startRun({ projectId, workflowId, task: typeof task === 'string' ? task : undefined });
    },
    'workflowRuns.cancel': async (command: MobileCommand) => {
      const runId = requireTarget(command, 'runId');
      await requireRunInProject(deps, runId, requireTarget(command, 'projectId'));
      const reason = payloadField(command, 'reason');
      return deps.cancelRun(runId, typeof reason === 'string' ? reason : undefined, mobileActorFor(command.caller));
    },
    'workflowRuns.retryStage': async (command: MobileCommand) => {
      const runId = requireTarget(command, 'runId');
      await requireRunInProject(deps, runId, requireTarget(command, 'projectId'));
      const nodeId = String(payloadField(command, 'nodeId') ?? '').trim();
      if (!nodeId) throw new Error('workflowRuns.retryStage requires payload.nodeId.');
      return deps.retryStage(runId, nodeId, mobileActorFor(command.caller));
    },
    'permissions.respond': async (command: MobileCommand) => {
      const requestId = requireTarget(command, 'requestId');
      const decision = payloadField(command, 'decision');
      if (decision !== 'allow' && decision !== 'deny') {
        throw new Error("permissions.respond requires payload.decision of 'allow' or 'deny'.");
      }
      return deps.respondToPermission(requestId, decision, mobileActorFor(command.caller), requireTarget(command, 'projectId'));
    },
    'workflowGates.approve': async (command: MobileCommand) => {
      const runId = requireTarget(command, 'runId');
      await requireRunInProject(deps, runId, requireTarget(command, 'projectId'));
      const note = payloadField(command, 'note');
      return deps.approveRun(runId, mobileActorFor(command.caller), typeof note === 'string' ? note : undefined);
    },
  };
}
