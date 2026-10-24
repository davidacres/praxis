import { powerMonitor } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  ScheduledLaunchError,
  ScheduledRunRunner,
  WorkflowRunStore,
  approveStage,
  resolveApprovalTarget,
  type AiProvider,
  type ScheduledRunnerPorts
} from '@praxis/core';
import { handoverThreshold, observeWorkflowRun, readProviderUsage } from './scheduledRunLive';
import { getScheduledRunStore, notifyScheduledRunsChanged } from './scheduledRunInstance';
import { getServiceForConnection } from './serviceRegistry';
import { getSettingsBackend } from './settingsBackendInstance';
import { getWorkflowBackingStore, getWorkflowPolicyStore } from './workflowStoreInstance';
import { getWorkflowOrchestrator, onDidChangeWorkflowRun } from './workflowOrchestratorInstance';
import { startWorkflowRun } from './workflowIpc';
import { stageHandoverGuard } from './stageHandoverGuard';
import { getAiSessionManager, abortActiveTask } from './aiInstance';
import { handoverSession } from './aiIpc';
import { preserveUncommittedWork } from './runWork';

/**
 * Wires the scheduled-run runner (FX-BF-047 / FX-BE-148) to the real app: the
 * schedule store, the workflow engine, provider usage and the clock. The
 * decisions live in core's `ScheduledRunRunner`; this file only supplies ports.
 *
 * Launching goes through `startWorkflowRun`, the same path the phone uses, so
 * trust, validation, preflight, provider checks and the clean-base check all
 * apply. An unattended start never answers a question on the user's behalf: a
 * dirty base or an unapproved workflow pauses the schedule and says why.
 */
const TICK_MS = Number(process.env.PRAXIS_E2E_SCHEDULE_TICK_MS) > 0 ? Number(process.env.PRAXIS_E2E_SCHEDULE_TICK_MS) : 30_000;

let runner: ScheduledRunRunner | undefined;

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

let timer: NodeJS.Timeout | undefined;
let detach: Array<() => void> = [];

function launchReason(message: string): ScheduledLaunchError['reason'] {
  if (/workspace trust/i.test(message)) return 'trust';
  if (/not set up or turned off|No AI provider/i.test(message)) return 'no-provider';
  return 'policy';
}

function ports(): ScheduledRunnerPorts {
  return {
    store: {
      list: () => getScheduledRunStore().list(),
      get: id => getScheduledRunStore().get(id),
      save: run => getScheduledRunStore().save(run)
    },
    now: () => new Date().toISOString(),
    isEnabled: () => getSettingsBackend().read().preview.enableScheduledRuns,
    newToken: () => randomUUID(),
    observe: observeWorkflowRun,
    findByLaunchToken: token => runStore().list().find(run => run.scheduledLaunchToken === token)?.runId,
    checkTicket: async ticket => {
      try {
        const issue = await (await getServiceForConnection(ticket.connectionId)).getIssue(ticket.issueKey);
        return (issue.statusCategory ?? '').toLowerCase() === 'done' ? `${ticket.issueKey} is already finished.` : undefined;
      } catch {
        return `${ticket.issueKey} no longer exists or can no longer be read.`;
      }
    },
    launch: async ({ run, entry, workflowId, token, provider }) => {
      if (!run.projectId) throw new ScheduledLaunchError('This schedule is not tied to a project, so it has nowhere to run the tickets.', 'policy');
      try {
        const summary = await startWorkflowRun({
          projectId: run.projectId,
          workflowId,
          taskTitle: entry.ticket.title,
          issue: { issueKey: entry.ticket.issueKey, connectionId: entry.ticket.connectionId },
          scheduledLaunchToken: token,
          // `uncommittedChanges` is deliberately unset: a dirty base pauses the schedule rather than letting it choose.
          options: { providerLimitPolicy: 'switch', ...(provider ? { aiProvider: provider } : {}) }
        });
        return summary.runId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ScheduledLaunchError(message, launchReason(message));
      }
    },
    cancelWorkflow: async (workflowRunId, reason) => {
      await getWorkflowOrchestrator().cancel(workflowRunId, reason);
    },
    usage: readProviderUsage,
    threshold: handoverThreshold,
    handOver: async ({ entry, workflowRunId, from, to, usedFraction: used }) => {
      const run = runStore().get(workflowRunId);
      if (!run) throw new Error('The workflow run no longer exists.');
      const sessions = getAiSessionManager();
      const active = sessions.listAgentSessionSummaries().filter(session => session.workflowRunId === workflowRunId && session.workflowRole === 'stage' && session.provider === from && !['completed', 'failed', 'aborted'].includes(session.state));
      if (active.length !== 1) throw new Error('Provider handover requires exactly one active workflow stage session.');
      const session = active[0];
      const worktreePath = session.worktreePath ?? run.worktreePath;
      let checkpointRef: string | undefined;
      await stageHandoverGuard.during(session.issueKey, async () => {
        await abortActiveTask(session.issueKey);
        if (worktreePath) {
          const message = `checkpoint: ${entry.ticket.issueKey} at ${Math.round(used * 100)}% of ${from}`;
          await preserveUncommittedWork(worktreePath, message);
          checkpointRef = await headOf(worktreePath);
          if (!checkpointRef) throw new Error('Could not record the handover checkpoint.');
        }
        if (runStore().get(workflowRunId)?.status !== 'running') throw new Error('The workflow stopped during provider handover.');
        await handoverSession(session.issueKey, {
          provider: to as AiProvider,
          expectedBriefRevision: sessions.getAgentSession(session.issueKey)?.handoverBrief?.revision ?? 0
        });
        if (runStore().get(workflowRunId)?.status !== 'running') {
          await abortActiveTask(session.issueKey);
          throw new Error('The workflow stopped during provider handover.');
        }
        await getWorkflowOrchestrator().updateRun(workflowRunId, current => ({ ...current, aiProvider: to as typeof current.aiProvider }));
      });
      return { ...(checkpointRef ? { checkpointRef } : {}) };
    },
    onChanged: run => notifyScheduledRunsChanged(run.projectId),
    approveGate: async (workflowRunId, nodeId) => {
      await getWorkflowOrchestrator().updateRun(workflowRunId, current => {
        const approval = resolveApprovalTarget(current, nodeId || undefined);
        const result = approveStage(
          current,
          approval.id,
          { actor: 'Scheduled run (approved by the user)', at: new Date().toISOString() },
          getWorkflowPolicyStore().effectiveForProject(current.projectId)?.profile
        );
        if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');
        return result.run;
      });
      await getWorkflowOrchestrator().step(workflowRunId);
    },
  };
}

async function headOf(worktreePath: string): Promise<string | undefined> {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreePath }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}

export function getScheduledRunRunner(): ScheduledRunRunner {
  runner ??= new ScheduledRunRunner(ports());
  return runner;
}

/**
 * Starts the runner. Call after missed schedules were reconciled, so a run that
 * was due while Praxis was closed shows as missed instead of starting. The runner
 * checks the preview flag on every tick, so turning it on or off needs no restart.
 */
export async function startScheduledRunRunner(): Promise<void> {
  if (timer) return;
  const active = getScheduledRunRunner();
  await active.recover();
  const tick = () => void active.tick().catch(error => console.error('Scheduled run tick failed:', error));
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  detach = [
    onDidChangeWorkflowRun(id => void active.handleWorkflowChanged(id).catch(error => console.error('Scheduled run update failed:', error)))
  ];
  const onResume = () => tick();
  powerMonitor.on('resume', onResume);
  detach.push(() => powerMonitor.off('resume', onResume));
  tick();
}

export function stopScheduledRunRunner(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const off of detach) off();
  detach = [];
}
