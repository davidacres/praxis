import { taskNotificationPolicy, deliverTaskNotice } from './taskNotifications';
import { projectWorkflowTrust } from './workflowProjectTrust';
import { runAsAgent } from './projectActivityInstance';
import { cancelWorkflowMap, runWorkflowMap } from './workflowMapRunner';
import { WorkflowIssueWriteBack } from './workflowIssueWriteBack';
import { broadcastToAllWindows } from './windowBroadcast';
import { resolve as resolvePath } from 'node:path';
import {
  ExclusiveResources,
  WorkflowOrchestrator,
  WorkflowRunStore,
  isCheckNode,
  isMergeNode,
  isRunSettled,
  summarizeWorkflowRun,
  type StageDispatcher,
  type StageRow,
  type WorkflowRun
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getWorkflowBackingStore } from './workflowStoreInstance';
import { runWorkflowCheck } from './workflowCheckRunner';
import { runWorkflowMerge } from './workflowMergeRunner';
import { evidenceStorageRoot } from './workflowEvidenceStorage';
import { canDispatchAgentStage, cancelWorkflowAgentStage, runWorkflowAgentStage } from './workflowAgentStage';
import { createWorkflowWorkspaceProvider } from './workflowWorkspace';
import { getServiceForConnection } from './serviceRegistry';
import { workflowLogSink } from './workflowLogSink';
import { syncApprovalGadgets } from './workflowApprovalGadgetSync';
import { fallbackProviderForStage } from './providerFallback';

/**
 * The desktop app's workflow orchestrator (FX-BE-024).
 *
 * Wires the core loop to real execution: deterministic checks run as child
 * processes in the run's git worktree. Agent stages are declined until
 * FX-BE-025 supplies the session port — a declined stage stays `ready` for the
 * run monitor to advance by hand rather than being claimed and failed.
 */

let orchestrator: WorkflowOrchestrator | undefined;

function projectFolderFor(run: WorkflowRun): string | undefined {
  return getProjectStore().get(run.projectId)?.workspaceFolder?.trim() || undefined;
}

const runChangeListeners = new Set<(runId: string) => void>();

/**
 * Every change to a workflow run — the orchestrator's own, and a delete or archive made
 * outside it — so a surface other than the desktop windows (the paired phone) follows it.
 */
export function onDidChangeWorkflowRun(listener: (runId: string) => void): () => void {
  runChangeListeners.add(listener);
  return () => runChangeListeners.delete(listener);
}

/** Tells the desktop windows and every `onDidChangeWorkflowRun` listener that a run changed. */
export function notifyWorkflowRunChanged(runId: string): void {
  broadcastToAllWindows('workflows:runChanged', runId);
  for (const listener of runChangeListeners) {
    try {
      listener(runId);
    } catch {
      /* a listener's failure never blocks the run */
    }
  }
}

function broadcastRunChanged(run: WorkflowRun): void {
  notifyWorkflowRunChanged(run.runId);
}

const STAGE_ICON: Partial<Record<StageRow['outcome'], string>> = {
  succeeded: '✅',
  failed: '❌',
  skipped: '⏭️',
  cancelled: '⏭️'
};

function formatRunDuration(startedAt: string, endedAt: string): string | undefined {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const STATUS_LABEL: Record<'succeeded' | 'failed' | 'cancelled', string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

/** The comment body a settled, ticket-linked run writes back — see `writeBackToIssue`. */
function buildWriteBackComment(run: WorkflowRun): string {
  const status = run.status as 'succeeded' | 'failed' | 'cancelled';
  const summary = summarizeWorkflowRun(run);
  const duration = run.endedAt ? formatRunDuration(run.startedAt, run.endedAt) : undefined;
  const stageLines = summary.stages
    .filter(stage => stage.type === 'agent-task' || stage.type === 'check')
    .map(stage => `- ${STAGE_ICON[stage.outcome] ?? '⏳'} ${stage.name}: ${stage.outcome}`);

  return [
    `**Workflow run ${STATUS_LABEL[status].toLowerCase()}: ${summary.workflowName}**`,
    '',
    `Status: ${STATUS_LABEL[status]}${duration ? ` · Duration: ${duration}` : ''}`,
    ...(stageLines.length > 0 ? ['', ...stageLines] : []),
    ...(run.endedReason ? ['', run.endedReason] : [])
  ].join('\n');
}

/**
 * Writes a settled run's outcome back to the ticket it was started from, once,
 * as a comment. Praxis has no target-status mapping for a tracker's own
 * workflow, so this deliberately never transitions the ticket — a comment is
 * the one write-back every backend supports the same way.
 *
 * Best-effort: a failure here (network, permissions, a deleted ticket) is
 * logged and never re-thrown — the run itself already succeeded or failed on
 * its own terms, and that must not be clouded by a write-back problem.
 */
const issueWriteBack = new WorkflowIssueWriteBack({
  get: runId => new WorkflowRunStore(getWorkflowBackingStore()).get(runId),
  send: async run => {
    const service = await getServiceForConnection(run.issueConnectionId);
    await runAsAgent(() => service.addComment(run.issueKey!, buildWriteBackComment(run)));
  },
  mark: (runId, at) => getWorkflowOrchestrator().updateRun(runId, current => ({ ...current, issueWriteBackAt: at }))
});

export async function writeBackToIssue(run: WorkflowRun): Promise<void> {
  try {
    await issueWriteBack.write(run.runId);
  } catch (error) {
    workflowLogSink.appendLine(
      `Could not write the outcome of run ${run.runId} back to ${run.issueKey}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runTrustError(run: WorkflowRun): Promise<string | undefined> {
  const trust = await projectWorkflowTrust(getWorkflowBackingStore(), projectFolderFor(run), run.workflowId, run.definition, true);
  if (!trust.trusted) return 'This project workflow needs local workspace trust. Start a reviewed run on the desktop.';
  return undefined;
}

/** Merges into one base checkout never overlap, whichever runs (or parallel schedule lanes) start them. */
const baseCheckouts = new ExclusiveResources();
const MERGE_HOLD_MS = Number(process.env.PRAXIS_E2E_MERGE_HOLD_MS) > 0 ? Number(process.env.PRAXIS_E2E_MERGE_HOLD_MS) : 0;

const dispatcher: StageDispatcher = {
  canDispatch(node, run) {
    // Everything needs somewhere to run; agent stages additionally need a
    // configured provider. A stage this declines stays `ready` for the monitor
    // rather than being claimed and failed.
    if (!projectFolderFor(run)) return false;
    return isCheckNode(node) || isMergeNode(node) || canDispatchAgentStage();
  },
  async runMap(node, context) {
    const error = await runTrustError(context.run);
    if (error) return { status: 'failed' as const, error };
    return runWorkflowMap(node, context);
  },
  async runCheck(node, context) {
    const error = await runTrustError(context.run);
    if (error) return { status: 'failed' as const, error };
    return runWorkflowCheck(node, context, projectFolderFor(context.run), evidenceStorageRoot());
  },
  async runMerge(node, context) {
    const error = await runTrustError(context.run);
    if (error) return { status: 'failed' as const, error };
    const folder = projectFolderFor(context.run);
    // The base checkout is the one thing parallel runs share (FX-BE-149): merges into it take turns.
    const merge = async () => {
      const outcome = await runWorkflowMerge(node, context, folder, evidenceStorageRoot());
      // E2E only: hold the checkout a little longer, so a spec can tell turns from overlap.
      if (MERGE_HOLD_MS > 0) await new Promise(resolve => setTimeout(resolve, MERGE_HOLD_MS));
      return outcome;
    };
    return folder ? baseCheckouts.with(resolvePath(folder), merge) : merge();
  },
  async runAgentStage(node, context, onSession) {
    const error = await runTrustError(context.run);
    if (error) return { status: 'failed' as const, error };
    return runWorkflowAgentStage(node, context, onSession);
  },
  async cancelStage(nodeId, context) {
    await cancelWorkflowAgentStage(context.run.runId, nodeId);
    await cancelWorkflowMap(context.run.runId, nodeId);
  }
};

const TIMEOUT_TICK_MS = 15_000;
let timeoutTimer: NodeJS.Timeout | undefined;

/**
 * While any run has a stage in flight, poll each for a stage that has outrun
 * its `timeoutMs` (TASK-118). The orchestrator holds no timers of its own, so
 * this survives a restart for free — recovery re-enters the loop, which starts
 * the tick again on the next check.
 */
function ensureTimeoutTick(): void {
  if (timeoutTimer) return;
  timeoutTimer = setInterval(() => {
    const runs = new WorkflowRunStore(getWorkflowBackingStore());
    const live = runs
      .list()
      .filter(run => Object.values(run.nodes).some(state => state.outcome === 'running'));
    if (live.length === 0) {
      clearInterval(timeoutTimer);
      timeoutTimer = undefined;
      return;
    }
    for (const run of live) void getWorkflowOrchestrator().enforceTimeouts(run.runId);
  }, TIMEOUT_TICK_MS);
  timeoutTimer.unref?.();
}

export function getWorkflowOrchestrator(): WorkflowOrchestrator {
  if (!orchestrator) {
    for (const run of new WorkflowRunStore(getWorkflowBackingStore()).list()) taskNotificationPolicy.run(run, true);
    orchestrator = new WorkflowOrchestrator({
      runs: new WorkflowRunStore(getWorkflowBackingStore()),
      dispatcher,
      workspace: createWorkflowWorkspaceProvider(),
      chooseFallbackProvider: fallbackProviderForStage,
      onRunChanged: run => {
        deliverTaskNotice(taskNotificationPolicy.run(run));
        broadcastRunChanged(run);
        // A stage may have just gone `running`; make sure the tick is armed.
        if (Object.values(run.nodes).some(state => state.outcome === 'running')) ensureTimeoutTick();
        if (isRunSettled(run)) void writeBackToIssue(run);
        syncApprovalGadgets(run);
      }
    });
  }
  return orchestrator;
}

export function resetWorkflowOrchestrator(): void {
  if (timeoutTimer) clearInterval(timeoutTimer);
  timeoutTimer = undefined;
  orchestrator = undefined;
}
