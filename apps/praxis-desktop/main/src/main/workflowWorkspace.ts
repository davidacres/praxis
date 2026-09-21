import {
  GitWorktreeManager,
  type GitChangedFile,
  type WorkflowRun,
  type WorkflowWorkspaceProvider
} from '@praxis/core';
import { getCurrentBranch, getGitStatus } from './gitService';
import { getProjectStore } from './projectStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { preserveUncommittedWork, runWorktreeKey } from './runWork';

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
  return runWorktreeKey(run.runId);
}

/** App-owned metadata can be dirty without changing the product snapshot a run builds and tests. */
function isWorkflowMetadataPath(value: string): boolean {
  const filePath = value.replaceAll('\\', '/');
  return filePath === 'project.praxis.md'
    || filePath === 'board.praxis.json'
    || filePath.endsWith('.workspace.praxis.json')
    || filePath.startsWith('.praxis/');
}

export function workflowBaseBlockingPaths(files: readonly Pick<GitChangedFile, 'path'>[]): string[] {
  return files.map(file => file.path).filter(filePath => !isWorkflowMetadataPath(filePath));
}

/**
 * A linked worktree is created from committed HEAD. Refuse to start when that would silently omit
 * product changes which the user can currently see and may already have verified in the main app.
 */
export async function assertWorkflowBaseReady(projectId: string): Promise<void> {
  const project = getProjectStore().get(projectId);
  const folder = project?.workspaceFolder?.trim();
  if (!folder) return;
  const blocking = workflowBaseBlockingPaths((await getGitStatus(folder)).files);
  if (blocking.length === 0) return;
  const examples = blocking.slice(0, 3).join(', ');
  throw new Error(
    `Cannot start a governed workflow while ${blocking.length} uncommitted ` +
      `${blocking.length === 1 ? 'file is' : 'files are'} outside Praxis metadata` +
      `${examples ? ` (${examples}${blocking.length > 3 ? ', …' : ''})` : ''}. ` +
      'The workflow worktree branches from committed HEAD and would test older code. Commit or stash these changes, then start the run again.'
  );
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
        {
          forceClean: false,
          // A Git worktree starts from a commit, not from the files currently visible in the main
          // checkout. Silently dropping those files makes workflow QA test an older product than the
          // one the user just ran. Refuse that ambiguous base and tell them how to make it durable.
          requireCleanBase: true
        }
      );
      return prepared.worktreePath;
    },

    async release(run: WorkflowRun): Promise<void> {
      const project = getProjectStore().get(run.projectId);
      const folder = project?.workspaceFolder?.trim();
      if (!folder || !run.worktreePath) return;
      // Removing a checkout with `--force` throws away anything uncommitted — a stage that failed or
      // was cancelled mid-edit leaves exactly that. Keep it as a commit on the run's branch first; if
      // it cannot be kept this throws, and the orchestrator leaves the worktree in place to retry.
      const kept = await preserveUncommittedWork(
        run.worktreePath,
        `WIP: changes left uncommitted when the run ended (${run.status})`
      );
      if (kept) logger.appendLine(`Kept uncommitted changes from run ${run.runId} as a commit on its branch.`);
      // The branch is where the run's work lives. Only the checkout goes; deleting the branch is a
      // choice the user makes when deleting the run (see `workflows:deleteRun`).
      await manager.removeDeliveryWorktree(
        folder,
        { worktreePath: run.worktreePath, branchName: worktreeKeyFor(run) },
        { keepBranch: true }
      );
    }
  };
}
