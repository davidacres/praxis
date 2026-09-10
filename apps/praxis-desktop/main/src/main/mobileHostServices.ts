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

export interface MobileSessionView {
  sessionId: string;
  workId: string;
  title: string;
  status: string;
  transcript: readonly string[];
}

export interface MobileHostServiceDeps {
  hostId: string;
  hostName(): string;
  hostOnline(): boolean;

  listProjects(): Promise<readonly MobileProjectSummary[]>;
  getProject(projectId: string): Promise<MobileProjectSummary | undefined>;
  listWork(projectId: string): Promise<readonly MobileWorkItem[]>;
  getSession(sessionId: string): Promise<MobileSessionView | undefined>;
  getRun(runId: string): Promise<unknown | undefined>;
  listRunChanges(runId: string): Promise<unknown>;
  listAttention(projectId: string): Promise<readonly unknown[]>;

  startRun(input: { projectId: string; workflowId: string; task?: string }): Promise<{ runId: string }>;
  cancelRun(runId: string, reason: string | undefined, actor: string): Promise<unknown>;
  retryStage(runId: string, nodeId: string, actor: string): Promise<unknown>;
  approveRun(runId: string, actor: string, note: string | undefined): Promise<unknown>;
  continueSession(sessionId: string, message: string, actor: string): Promise<unknown>;
  respondToPermission(requestId: string, decision: 'allow' | 'deny', actor: string): Promise<unknown>;
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
    'sessions.get': async (request: MobileReadRequest) => {
      const sessionId = requireTarget(request, 'sessionId');
      const session = await deps.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} was not found.`);
      return session;
    },
    'workflowRuns.get': async (request: MobileReadRequest) => {
      const runId = requireTarget(request, 'runId');
      const run = await deps.getRun(runId);
      if (run === undefined) throw new Error(`Run ${runId} was not found.`);
      return run;
    },
    'changes.get': async (request: MobileReadRequest) => deps.listRunChanges(requireTarget(request, 'runId')),
    'attention.list': async (request: MobileReadRequest) => deps.listAttention(requireTarget(request, 'projectId')),
  };
}

export function createMobileHostExecutionHandlers(deps: MobileHostServiceDeps): MobileExecutionHandlers {
  return {
    'sessions.continue': async (command: MobileCommand) => {
      const sessionId = requireTarget(command, 'sessionId');
      const message = String(payloadField(command, 'message') ?? '').trim();
      if (!message) throw new Error('sessions.continue requires a non-empty payload.message.');
      return deps.continueSession(sessionId, message, mobileActorFor(command.caller));
    },
    'workflowRuns.start': async (command: MobileCommand) => {
      const projectId = requireTarget(command, 'projectId');
      const workflowId = String(payloadField(command, 'workflowId') ?? '').trim();
      if (!workflowId) throw new Error('workflowRuns.start requires payload.workflowId.');
      const task = payloadField(command, 'task');
      return deps.startRun({ projectId, workflowId, task: typeof task === 'string' ? task : undefined });
    },
    'workflowRuns.cancel': async (command: MobileCommand) => {
      const reason = payloadField(command, 'reason');
      return deps.cancelRun(requireTarget(command, 'runId'), typeof reason === 'string' ? reason : undefined, mobileActorFor(command.caller));
    },
    'workflowRuns.retryStage': async (command: MobileCommand) => {
      const nodeId = String(payloadField(command, 'nodeId') ?? '').trim();
      if (!nodeId) throw new Error('workflowRuns.retryStage requires payload.nodeId.');
      return deps.retryStage(requireTarget(command, 'runId'), nodeId, mobileActorFor(command.caller));
    },
    'permissions.respond': async (command: MobileCommand) => {
      const requestId = requireTarget(command, 'requestId');
      const decision = payloadField(command, 'decision');
      if (decision !== 'allow' && decision !== 'deny') {
        throw new Error("permissions.respond requires payload.decision of 'allow' or 'deny'.");
      }
      return deps.respondToPermission(requestId, decision, mobileActorFor(command.caller));
    },
    'workflowGates.approve': async (command: MobileCommand) => {
      const note = payloadField(command, 'note');
      return deps.approveRun(requireTarget(command, 'runId'), mobileActorFor(command.caller), typeof note === 'string' ? note : undefined);
    },
  };
}
