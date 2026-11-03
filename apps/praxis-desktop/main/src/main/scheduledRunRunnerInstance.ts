import { powerMonitor } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  ScheduledLaunchError,
  ScheduledRunRunner,
  WorkflowRunStore,
  applyWorkflowRunCommand,
  approvalReadiness,
  approveStage,
  exhaustedProviders,
  planStatusToMarkdown,
  pendingLoop,
  providerCanRunStage,
  rejectStage,
  resolveApprovalTarget,
  scheduledTicketTransition,
  skipApproval,
  type AiProvider,
  type ScheduledGateDecisionResult,
  type ScheduledLoopDecisionResult,
  type ScheduledRunnerPorts,
  type WorkflowRun
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
import { stageCapableProvider } from './providerFallback';
import { getProjectStore } from './projectStoreInstance';
import { runAsAgent } from './projectActivityInstance';
import { changedPaths, commitPraxisWrite } from './ticketWriteBackCommit';
import { repositoryRoot } from './runWork';
import { withBaseCheckout } from './baseCheckoutLock';

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
    isEnabled: () => true,
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
          // Nobody is there to answer a permission prompt, so stages auto-approve and run in Autopilot,
          // still bounded by each stage's own tool mode.
          options: { permissionMode: 'auto', providerLimitPolicy: 'switch', ...(provider ? { aiProvider: provider } : {}) }
        });
        return summary.runId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ScheduledLaunchError(message, launchReason(message));
      }
    },
    moveTicket: async ({ run, entry, phase }) => {
      const { connectionId, issueKey } = entry.ticket;
      const service = await getServiceForConnection(connectionId);
      const [issue, transitions] = await Promise.all([service.getIssue(issueKey), service.getTransitions(issueKey)]);
      const project = run.projectId ? getProjectStore().get(run.projectId) : undefined;
      const transition = scheduledTicketTransition(issue.status, transitions, phase, project?.workflowStages);
      if (!transition) return undefined;
      const status = transition.toStatus ?? transition.name;
      // A folder-backed ticket is a file in the repository: commit the new status, or the checkout
      // reads as dirty and the schedule's next ticket refuses to start.
      // Written and committed in one turn on the base checkout, so another lane never branches from it half-done.
      const folder = project?.workspaceFolder?.trim();
      const move = async () => {
        const root = folder ? await repositoryRoot(folder) : undefined;
        const before = root ? await changedPaths(root).catch(() => undefined) : undefined;
        await runAsAgent(() => service.transitionIssue(issueKey, transition.id));
        if (root && before) {
          // A plan file records the status in its own words ("Done" is written "✅ Complete"): match what was written.
          await commitPraxisWrite(root, before, planStatusToMarkdown(status), `Move ${issueKey} to ${status}`).catch(error =>
            console.error(`Moved ${issueKey} to ${status} but could not commit it:`, error)
          );
        }
      };
      await (folder ? withBaseCheckout(folder, move) : move());
      return status;
    },
    cancelWorkflow: async (workflowRunId, reason) => {
      await getWorkflowOrchestrator().cancel(workflowRunId, reason);
    },
    usage: readProviderUsage,
    threshold: handoverThreshold,
    handOver: async ({ entry, workflowRunId, from, to, usedFraction: used }) => {
      const run = runStore().get(workflowRunId);
      if (!run) throw new Error('The workflow run no longer exists.');
      const checkpointMessage = `checkpoint: ${entry.ticket.issueKey} at ${Math.round(used * 100)}% of ${from}`;
      const sessions = getAiSessionManager();
      const active = sessions.listAgentSessionSummaries().filter(session => session.workflowRunId === workflowRunId && session.workflowRole === 'stage' && session.provider === from && !['completed', 'failed', 'aborted'].includes(session.state));
      // Between stages, or with stages running side by side, nothing is cut off: the run's AI changes
      // for every stage not yet started, and each stage launch still checks it can run there.
      const switchForNextStages = async (): Promise<{ checkpointRef?: string; provider: string }> => {
        let checkpointRef: string | undefined;
        if (run.worktreePath && await preserveUncommittedWork(run.worktreePath, checkpointMessage)) checkpointRef = await headOf(run.worktreePath);
        await getWorkflowOrchestrator().updateRun(workflowRunId, current => ({ ...current, aiProvider: to as typeof current.aiProvider }));
        return { ...(checkpointRef ? { checkpointRef } : {}), provider: to };
      };
      if (active.length !== 1) return switchForNextStages();
      const session = active[0];
      // A mid-turn handover moves the live session, so the AI must be able to run this stage (Antigravity
      // can't run a read-only or approval-gated one). If the planner's pick can't, take the next that can.
      const nodeId = session.workflowNodeId ?? '';
      const target = providerCanRunStage(run, nodeId, to)
        ? to
        : await stageCapableProvider(run, nodeId, [from, ...exhaustedProviders(run)], [to]);
      if (!target) return switchForNextStages();
      const worktreePath = session.worktreePath ?? run.worktreePath;
      let checkpointRef: string | undefined;
      await stageHandoverGuard.during(session.issueKey, async () => {
        await abortActiveTask(session.issueKey);
        if (worktreePath) {
          await preserveUncommittedWork(worktreePath, checkpointMessage);
          checkpointRef = await headOf(worktreePath);
          if (!checkpointRef) throw new Error('Could not record the handover checkpoint.');
        }
        if (runStore().get(workflowRunId)?.status !== 'running') throw new Error('The workflow stopped during provider handover.');
        await handoverSession(session.issueKey, {
          provider: target as AiProvider,
          expectedBriefRevision: sessions.getAgentSession(session.issueKey)?.handoverBrief?.revision ?? 0
        });
        if (runStore().get(workflowRunId)?.status !== 'running') {
          await abortActiveTask(session.issueKey);
          throw new Error('The workflow stopped during provider handover.');
        }
        await getWorkflowOrchestrator().updateRun(workflowRunId, current => ({ ...current, aiProvider: target as typeof current.aiProvider }));
      });
      return { ...(checkpointRef ? { checkpointRef } : {}), provider: target };
    },
    onChanged: run => notifyScheduledRunsChanged(run.projectId),
    decideGate: async (workflowRunId, nodeId) => {
      let decisionResult: ScheduledGateDecisionResult | undefined;
      await getWorkflowOrchestrator().updateRun(workflowRunId, (current: WorkflowRun): WorkflowRun => {
        const approval = resolveApprovalTarget(current, nodeId || undefined);
        const policy = getWorkflowPolicyStore().effectiveForProject(current.projectId)?.profile;
        const readiness = approvalReadiness(current, approval.id, policy);
        const at = new Date().toISOString();
        if (readiness.canApprove) {
          const result = approveStage(
            current,
            approval.id,
            { actor: 'Scheduled run (autonomous)', at },
            policy
          );
          if (result.ok) {
            decisionResult = {
              decision: 'approved',
              reason: readiness.gates.length === 0
                ? 'Auto-approved (no required gates).'
                : `Auto-approved: all required gates passed (${readiness.gates.map(g => `${g.gate}: passed`).join(', ')}).`
            };
            return result.run;
          }
        }
        if (approval.optional) {
          const skipResult = skipApproval(current, approval.id, {
            actor: 'Scheduled run (autonomous)',
            at
          });
          if (skipResult.ok) {
            decisionResult = {
              decision: 'skipped',
              reason: `Optional approval stage skipped because gates were unmet (${readiness.blocking.map(g => `${g.gate}: ${g.detail}`).join(', ')}).`
            };
            return skipResult.run;
          }
        }
        const rejectReason = `Gates unmet: ${readiness.blocking.map(g => `${g.gate} ${g.state} — ${g.detail}`).join('; ')}`;
        const rejectedRun = rejectStage(current, approval.id, {
          actor: 'Scheduled run (autonomous)',
          reason: rejectReason,
          at
        });
        decisionResult = {
          decision: 'rejected',
          reason: rejectReason
        };
        return rejectedRun;
      });
      await getWorkflowOrchestrator().step(workflowRunId);
      return decisionResult ?? { decision: 'rejected', reason: 'Unable to evaluate approval stage.' };
    },
    decideLoop: async (workflowRunId, edgeId) => {
      let decisionResult: ScheduledLoopDecisionResult | undefined;
      await getWorkflowOrchestrator().updateRun(workflowRunId, current => {
        const at = new Date().toISOString();
        const pending = pendingLoop(current);
        const targetEdgeId = edgeId || pending?.status.edge.id;
        const edge = current.definition.edges.find(e => e.id === targetEdgeId);
        const keepBest = edge?.loop?.keepBest;
        const reason = keepBest
          ? 'Autonomous decision: loop budget exhausted, accepted best iteration.'
          : 'Autonomous decision: loop budget exhausted, accepted iteration to proceed.';
        const next = applyWorkflowRunCommand(current, {
          kind: 'loop-decided',
          edgeId: edge?.id ?? targetEdgeId ?? '',
          actor: 'Scheduled run (autonomous)',
          decision: 'accept',
          reason,
          at
        });
        decisionResult = { decision: 'accept', reason };
        return next;
      });
      await getWorkflowOrchestrator().step(workflowRunId);
      return decisionResult ?? { decision: 'accept', reason: 'Autonomous decision: accepted loop.' };
    },
    approveGate: async (workflowRunId, nodeId) => {
      await getWorkflowOrchestrator().updateRun(workflowRunId, current => {
        const approval = resolveApprovalTarget(current, nodeId || undefined);
        const result = approveStage(
          current,
          approval.id,
          { actor: 'Scheduled run (autonomous)', at: new Date().toISOString() },
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
