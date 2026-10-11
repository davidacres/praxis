import type { useDialogs } from '../ui/dialogs';

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
  if (!accepted) throw new Error('Workflow start cancelled; workspace trust was not granted.');
  await window.praxis.workflows.approveProjectTrust(projectId, workflowId, state.fingerprint);
}
