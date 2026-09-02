import { GitWorktreeManager, type WorkflowRun, type WorkflowWorkspaceProvider } from '@praxis/core';
import { getCurrentBranch } from './gitService';
import { getProjectStore } from './projectStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';

/**
 * Per-run git worktree (FX-BE-024 / TASK-113).
 *
 * One worktree per run, branched off the project's current branch. Mutating
 * stages are already serialised by the scheduler so they share it and build on
 * each other; verification stages read it at the snapshot the implementer froze.
 *
 * A run records its `worktreePath`, so a restart re-attaches to the same tree
 * rather than branching a second one beside it — `prepareDeliveryWorktree`
 * reuses an existing directory for the same name.
 */

const logger = { appendLine: (message: string): void => console.log(`[workflow] ${message}`) };

/** Stable per-run name, so re-attaching after a restart lands on the same tree. */
function worktreeKeyFor(run: WorkflowRun): string {
  return `WF-${run.runId.slice(0, 8).toUpperCase()}`;
}

export function createWorkflowWorkspaceProvider(): WorkflowWorkspaceProvider {
  const manager = new GitWorktreeManager(logger);

  return {
    async acquire(run: WorkflowRun): Promise<string> {
      const project = getProjectStore().get(run.projectId);
      const folder = project?.workspaceFolder?.trim();
      if (!folder) {
        throw new Error(
          `Project ${project?.name ?? run.projectId} has no workspace folder. Attach one before running a workflow.`
        );
      }

      const baseBranch =
        (await getCurrentBranch(folder)) ?? getSettingsBackend().read().delivery.defaultBaseBranch.trim();
      if (!baseBranch) {
        throw new Error('Could not determine a base branch for this run (detached HEAD?).');
      }

      const prepared = await manager.prepareDeliveryWorktree(
        { key: worktreeKeyFor(run), summary: run.definition.name } as Parameters<
          GitWorktreeManager['prepareDeliveryWorktree']
        >[0],
        baseBranch,
        folder,
        { forceClean: false }
      );
      return prepared.worktreePath;
    },

    async release(run: WorkflowRun): Promise<void> {
      const project = getProjectStore().get(run.projectId);
      const folder = project?.workspaceFolder?.trim();
      if (!folder || !run.worktreePath) return;
      await manager.removeDeliveryWorktree(folder, {
        worktreePath: run.worktreePath,
        branchName: worktreeKeyFor(run)
      });
    }
  };
}
