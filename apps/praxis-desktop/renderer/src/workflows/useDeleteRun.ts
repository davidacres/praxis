import { useCallback } from 'react';
import type { WorkflowRunSummary, WorkflowRunWorkInfo } from '@praxis/core';
import { useDialogs } from '../ui/dialogs';

export interface DeleteRunResult {
  deleted: boolean;
  /** Set when the delete was attempted and failed; nothing has been removed. */
  error?: string;
}

/**
 * The one delete-a-run flow, used by the sidebar node and the run panel.
 *
 * Deleting a run record does not have to delete the *work* it produced — the implement stage's
 * edits are commits on the run's own branch. So before asking, it looks at what the run left in
 * the repository and says so; the branch is kept unless the person ticks the option to delete it,
 * which is unchecked every time and names the number of commits that exist nowhere else.
 */
export function useDeleteRun(): (run: Pick<WorkflowRunSummary, 'runId' | 'status' | 'stages'>) => Promise<DeleteRunResult> {
  const { confirmWithOption } = useDialogs();

  return useCallback(
    async run => {
      const live = run.status === 'running' || run.status === 'awaiting-approval';
      const sessionCount = run.stages.filter(row => row.sessionKey).length;

      let work: WorkflowRunWorkInfo | undefined;
      try {
        work = await window.praxis.workflows.inspectRunWork(run.runId);
      } catch {
        // Not knowing is not a reason to block the delete — but it is a reason to keep the branch (below).
      }

      const details: string[] = [];
      if (live) details.push('It is still running and will be cancelled first.');
      if (sessionCount > 0) details.push(`${sessionCount} stage session${sessionCount === 1 ? '' : 's'} will be deleted.`);
      if (work?.branch) {
        details.push(
          work.commitCount > 0
            ? `Its work is on branch ${work.branch}: ${work.commitCount} commit${work.commitCount === 1 ? ' that exists' : 's that exist'} on no other branch.`
            : `Its branch ${work.branch} has no commits that are not already elsewhere.`
        );
        for (const commit of work.commits.slice(0, 3)) details.push(`${commit.sha} — ${commit.subject}`);
      }
      if (work && work.uncommittedFiles > 0) {
        details.push(
          `${work.uncommittedFiles} uncommitted file${work.uncommittedFiles === 1 ? '' : 's'} in its worktree will be saved as a commit on the branch.`
        );
      }

      const { confirmed, checked } = await confirmWithOption({
        title: 'Delete this run?',
        message: work?.hasWork
          ? 'This run produced work in your repository. Deleting the run keeps that work unless you choose to delete it too.'
          : 'The run and its stage sessions will be removed.',
        details,
        ...(work?.branch
          ? {
              option: {
                label: `Also delete branch ${work.branch}`,
                hint:
                  work.commitCount > 0
                    ? `Permanently deletes ${work.commitCount} commit${work.commitCount === 1 ? ' that exists' : 's that exist'} nowhere else. This cannot be undone.`
                    : 'Removes the branch and its worktree.'
              }
            }
          : {}),
        confirmLabel: 'Delete run',
        danger: true
      });
      if (!confirmed) return { deleted: false };

      try {
        await window.praxis.workflows.deleteRun(run.runId, { deleteWork: checked });
        return { deleted: true };
      } catch (cause) {
        return { deleted: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    [confirmWithOption]
  );
}
