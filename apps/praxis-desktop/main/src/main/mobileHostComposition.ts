/**
 * Supplies the real `MobileHostServiceDeps` from the running desktop stores and
 * assembles the `MobileHostApplication` that `registerMobileElectronIpc` serves.
 *
 * Wired for real now: project and run reads, the attention inbox, and the
 * workflow commands that do not need an agent session (cancel, retry, approve).
 * Deferred with an explicit error: `sessions.continue`, `permissions.respond`
 * and `workflowRuns.start`. The first two need the permission model reworked
 * from a FIFO session key to request-specific ids (architecture.md, FX-BE-081);
 * starting a run from the phone is FX-BE-082. A deferred op fails the command
 * with a stated reason rather than being silently absent.
 */
import * as os from 'node:os';
import {
  InMemoryMobileCommandLedger,
  WorkflowRunStore,
  applyWorkflowRunCommand,
  approveStage,
  summarizeWorkflowRun,
  type MobileCommand,
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
import { getAiSessionManager } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';

export class MobileHostPendingError extends Error {
  constructor(operation: string, planRef: string) {
    super(`${operation} is not available from the phone yet (${planRef}).`);
    this.name = 'MobileHostPendingError';
  }
}

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

export function createDesktopMobileHostServiceDeps(): MobileHostServiceDeps {
  const hostId = (os.hostname() || 'praxis-desktop').trim();

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
    getSession: async sessionId => {
      const record = [...getAiSessionManager().getAllAgentSessions().values()].find(
        candidate => candidate.sessionId === sessionId || candidate.issueKey === sessionId,
      );
      if (!record) return undefined;
      return {
        sessionId: record.sessionId,
        workId: record.issueKey,
        title: record.title?.trim() || record.issueKey,
        status: record.mode ?? 'idle',
        transcript: [],
      };
    },
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

    startRun: async () => {
      throw new MobileHostPendingError('workflowRuns.start', 'FX-BE-082');
    },
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
        const approval = run.definition.nodes.find(node => node.type === 'approval');
        if (!approval) throw new Error('This workflow has no approval stage.');
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
    continueSession: async () => {
      throw new MobileHostPendingError('sessions.continue', 'FX-BE-081');
    },
    respondToPermission: async () => {
      throw new MobileHostPendingError('permissions.respond', 'FX-BE-081');
    },
  };
}

export function composeDesktopMobileHost(): ReturnType<typeof createDesktopMobileHostApplication> {
  const deps = createDesktopMobileHostServiceDeps();
  return createDesktopMobileHostApplication({
    reads: createMobileHostReads(deps),
    commands: createMobileHostExecutionHandlers(deps),
    ledger: new InMemoryMobileCommandLedger(),
    payloadDigest: (command: unknown) => JSON.stringify((command as MobileCommand).payload ?? null),
  });
}
