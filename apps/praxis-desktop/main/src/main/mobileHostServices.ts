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
import type {
  MobileCaller,
  MobileCommand,
  MobileExecutionHandlers,
  MobileHostReads,
  MobileReadRequest,
  MobileSessionSnapshot,
  MobileSessionSummary,
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

export interface MobileHostServiceDeps {
  hostId: string;
  hostName(): string;
  hostOnline(): boolean;

  listProjects(): Promise<readonly MobileProjectSummary[]>;
  getProject(projectId: string): Promise<MobileProjectSummary | undefined>;
  listWork(projectId: string): Promise<readonly MobileWorkItem[]>;
  listSessions(projectId?: string): Promise<readonly MobileSessionSummary[]>;
  getSession(sessionId: string): Promise<MobileSessionSnapshot | undefined>;
  listWorkflows(projectId: string): Promise<readonly { workflowId: string; name: string; trigger: string }[]>;
  getRun(runId: string): Promise<unknown | undefined>;
  listRunChanges(runId: string): Promise<unknown>;
  listAttention(projectId: string): Promise<readonly unknown[]>;

  createSession(input: { projectId: string; title: string; message: string; provider?: string; model?: string }): Promise<MobileSessionSnapshot>;
  startRun(input: { projectId: string; workflowId: string; task?: string }): Promise<{ runId: string }>;
  cancelRun(runId: string, reason: string | undefined, actor: string): Promise<unknown>;
  retryStage(runId: string, nodeId: string, actor: string): Promise<unknown>;
  approveRun(runId: string, actor: string, note: string | undefined): Promise<unknown>;
  continueSession(sessionId: string, message: string, actor: string): Promise<unknown>;
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

export function createMobileHostReads(deps: MobileHostServiceDeps): MobileHostReads {
  return {
    'hosts.list': async () => [
      { hostId: deps.hostId, hostName: deps.hostName(), online: deps.hostOnline() },
    ],
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
}

export function createMobileHostExecutionHandlers(deps: MobileHostServiceDeps): MobileExecutionHandlers {
  return {
    'sessions.create': async (command: MobileCommand) => {
      const projectId = requireTarget(command, 'projectId');
      const title = String(payloadField(command, 'title') ?? '').trim();
      const message = String(payloadField(command, 'message') ?? '').trim();
      if (!message) throw new Error('sessions.create requires a non-empty payload.message.');
      const provider = payloadField(command, 'provider');
      const model = payloadField(command, 'model');
      return deps.createSession({
        projectId,
        title: title || message.slice(0, 80),
        message,
        ...(typeof provider === 'string' && provider.trim() ? { provider: provider.trim() } : {}),
        ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
      });
    },
    'sessions.continue': async (command: MobileCommand) => {
      const sessionId = requireTarget(command, 'sessionId');
      await requireSessionInProject(deps, sessionId, requireTarget(command, 'projectId'));
      const message = String(payloadField(command, 'message') ?? '').trim();
      if (!message) throw new Error('sessions.continue requires a non-empty payload.message.');
      return deps.continueSession(sessionId, message, mobileActorFor(command.caller));
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
