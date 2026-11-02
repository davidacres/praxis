import type { useDialogs } from '../ui/dialogs';

/** The message `confirmProjectWorkflowTrust` rejects with when the person cancels the review. */
export const TRUST_CANCELLED = 'Workflow start cancelled; workspace trust was not granted.';

/** True for the rejection a cancelled review produces, which callers should not show as an error. */
export function isTrustCancelled(reason: unknown): boolean {
  return reason instanceof Error && reason.message === TRUST_CANCELLED;
}

/** Show the exact commands before granting persistent trust to a committed workflow. */
export async function confirmProjectWorkflowTrust(projectId: string, workflowId: string, confirm: ReturnType<typeof useDialogs>['confirm']): Promise<void> {
  const state = await window.praxis.workflows.projectTrust(projectId, workflowId);
  if (state.trusted) return;
  const accepted = await confirm({
    title: 'Trust this project workflow?',
    message: 'This repository defines commands and agents that can run on your computer. Review them before allowing this workflow. Changes to the workflow will require a new review.',
    details: state.commands.length ? state.commands : ['This workflow has no shell check commands.'],
    confirmLabel: 'Trust workflow',
    cancelLabel: 'Cancel'
  });
  if (!accepted) throw new Error(TRUST_CANCELLED);
  await window.praxis.workflows.approveProjectTrust(projectId, workflowId, state.fingerprint);
}
