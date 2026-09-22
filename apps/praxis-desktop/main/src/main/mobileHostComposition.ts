/**
 * Supplies the real `MobileHostServiceDeps` from the running desktop stores and
 * assembles the `MobileHostApplication` that `registerMobileElectronIpc` serves.
 *
 * The same services back Electron IPC and the authenticated LAN transport:
 * projects, sessions and streamed transcripts, workflow execution, attention,
 * request-specific permissions, cancellation, retry and approval.
 */
import * as os from 'node:os';
import {
  InMemoryMobileCommandLedger,
  WorkflowRunStore,
  applyWorkflowRunCommand,
  approveStage,
  resolveApprovalTarget,
  summarizeWorkflowRun,
  type MobileCommand,
  type MobileHostApplication,
  type MobileSessionEvent,
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
import { getWorkflowOrchestrator } from './workflowOrchestratorInstance';
import { getAiSessionManager, hasActiveTask, respondToActivePermission } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { cancelMobileInteractiveSession, continueMobileInteractiveSession, createMobileInteractiveSession } from './mobileInteractiveSessions';
import { mobileSessionSnapshot, mobileSessionSummary } from './mobileSessionProjection';
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

function requireRun(runId: string): WorkflowRun {
  const run = runStore().get(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  return run;
}

function projectSummary(project: { id: string; name: string; workflowStages: Array<{ name: string }> }): MobileProjectSummary {
  return { projectId: project.id, name: project.name, workflow: project.workflowStages.map(stage => stage.name).join(' → ') || undefined };
}

export function createDesktopMobileHostServiceDeps(configuredHostId?: string): MobileHostServiceDeps {
  const hostId = configuredHostId?.trim() || (os.hostname() || 'praxis-desktop').trim();

  return {
    hostId,
    hostName: () => getSettingsBackend().read().mobileAccess.hostName.trim() || os.hostname() || 'Praxis desktop',
    hostOnline: () => true,

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
      .filter(record => !projectId || record.projectId === projectId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(mobileSessionSummary),
    getSession: async sessionId => {
      const record = [...getAiSessionManager().getAllAgentSessions().values()].find(
        candidate => candidate.sessionId === sessionId || candidate.issueKey === sessionId,
      );
      if (!record) return undefined;
      return mobileSessionSnapshot(record);
    },
    listWorkflows: async projectId => listWorkflowChoices(projectId),
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
          items.push({ id: `approval:${run.runId}`, kind: 'approval', hostId, projectId, runId: run.runId, createdAt: run.startedAt, resolved: false });
        }
        for (const stage of summary.stages ?? []) {
          if (stage.outcome === 'failed') {
            items.push({ id: `failure:${run.runId}:${stage.nodeId}`, kind: 'failure', hostId, projectId, runId: run.runId, nodeId: stage.nodeId, createdAt: run.startedAt, resolved: false });
          }
        }
      }
      return items;
    },

    createSession: async input => mobileSessionSnapshot(await createMobileInteractiveSession(input)),
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
    continueSession: async (sessionId, message) => mobileSessionSnapshot(await continueMobileInteractiveSession(sessionId, message)),
    cancelSession: async sessionId => mobileSessionSnapshot(await cancelMobileInteractiveSession(sessionId)),
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
  const deps = createDesktopMobileHostServiceDeps(hostId);
  const app = createDesktopMobileHostApplication({
    reads: createMobileHostReads(deps),
    commands: createMobileHostExecutionHandlers(deps),
    ledger: new InMemoryMobileCommandLedger(),
    payloadDigest: (command: unknown) => JSON.stringify((command as MobileCommand).payload ?? null),
  });
  let sequence = 0;
  getAiSessionManager().onDidChangeAgentSession(record => {
    sequence += 1;
    app.ledger.appendEvent<MobileSessionEvent>({
      protocolVersion: 1,
      eventId: `${record.sessionId}:${sequence}`,
      sequence,
      emittedAt: new Date().toISOString(),
      target: {
        hostId: deps.hostId,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        sessionId: record.sessionId,
        ...(record.workflowRunId ? { runId: record.workflowRunId } : {}),
      },
      event: { type: 'session.snapshot', snapshot: mobileSessionSnapshot(record, sequence) },
    });
  });
  return app;
}
