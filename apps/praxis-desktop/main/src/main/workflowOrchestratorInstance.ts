import { BrowserWindow } from 'electron';
import {
  WorkflowOrchestrator,
  WorkflowRunStore,
  isCheckNode,
  type StageDispatcher,
  type WorkflowRun
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getWorkflowBackingStore } from './workflowStoreInstance';
import { runWorkflowCheck } from './workflowCheckRunner';
import { canDispatchAgentStage, cancelWorkflowAgentStage, runWorkflowAgentStage } from './workflowAgentStage';
import { createWorkflowWorkspaceProvider } from './workflowWorkspace';

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

function broadcastRunChanged(run: WorkflowRun): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workflows:runChanged', run.runId);
  }
}

const dispatcher: StageDispatcher = {
  canDispatch(node, run) {
    // Everything needs somewhere to run; agent stages additionally need a
    // configured provider. A stage this declines stays `ready` for the monitor
    // rather than being claimed and failed.
    if (!projectFolderFor(run)) return false;
    return isCheckNode(node) || canDispatchAgentStage();
  },
  runCheck(node, context) {
    return runWorkflowCheck(node, context, projectFolderFor(context.run));
  },
  runAgentStage(node, context, onSession) {
    return runWorkflowAgentStage(node, context, onSession);
  },
  async cancelStage(nodeId, context) {
    await cancelWorkflowAgentStage(context.run.runId, nodeId);
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
    orchestrator = new WorkflowOrchestrator({
      runs: new WorkflowRunStore(getWorkflowBackingStore()),
      dispatcher,
      workspace: createWorkflowWorkspaceProvider(),
      onRunChanged: run => {
        broadcastRunChanged(run);
        // A stage may have just gone `running`; make sure the tick is armed.
        if (Object.values(run.nodes).some(state => state.outcome === 'running')) ensureTimeoutTick();
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
