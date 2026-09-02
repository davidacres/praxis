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
    // Only checks, and only where there is somewhere to run them.
    return isCheckNode(node) && !!projectFolderFor(run);
  },
  runCheck(node, context) {
    return runWorkflowCheck(node, context, projectFolderFor(context.run));
  },
  async runAgentStage() {
    throw new Error('Agent stages are not yet driven automatically (FX-BE-025).');
  }
};

export function getWorkflowOrchestrator(): WorkflowOrchestrator {
  if (!orchestrator) {
    orchestrator = new WorkflowOrchestrator({
      runs: new WorkflowRunStore(getWorkflowBackingStore()),
      dispatcher,
      workspace: createWorkflowWorkspaceProvider(),
      onRunChanged: broadcastRunChanged
    });
  }
  return orchestrator;
}

export function resetWorkflowOrchestrator(): void {
  orchestrator = undefined;
}
