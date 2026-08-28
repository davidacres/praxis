// The workflow catalog itself lives in @praxis/core so the desktop app
// shares it. What stays here is the one piece that cannot: the VS Code quick-pick
// UI for choosing a workflow pack.
import * as vscode from 'vscode';
import {
  discoverWorkspaceAgentWorkflows,
  matchesWorkflow,
  type AgentWorkflowReference
} from '@praxis/core';

interface WorkflowQuickPickItem extends vscode.QuickPickItem {
  pickType: 'none' | 'workflow';
  workflow?: AgentWorkflowReference;
}

/**
 * Prompts for a workflow pack. Returns the chosen workflow, `undefined` when the
 * user explicitly picks "No workflow pack", or `null` when the prompt is cancelled.
 */
export async function promptForAgentWorkflowSelection(options: {
  workspaceRoot?: string;
  previous?: AgentWorkflowReference;
  title?: string;
  placeHolder?: string;
}): Promise<AgentWorkflowReference | undefined | null> {
  const discovered = await discoverWorkspaceAgentWorkflows(options.workspaceRoot);
  if (options.previous && !discovered.some(workflow => matchesWorkflow(workflow, options.previous))) {
    discovered.unshift(options.previous);
  }

  if (discovered.length === 0) {
    return options.previous;
  }

  const items: WorkflowQuickPickItem[] = [
    {
      label: 'No workflow pack',
      description: 'Run without a workflow pack — delivery will proceed with no workflow directive',
      pickType: 'none'
    },
    ...discovered.map(workflow => ({
      label: workflow.name,
      description: workflow.description,
      detail: workflow.instructionsPath,
      workflow,
      pickType: 'workflow' as const
    }))
  ];

  const picked = await vscode.window.showQuickPick<WorkflowQuickPickItem>(items, {
    title: options.title ?? 'Workflow Pack',
    placeHolder: options.placeHolder ?? 'Select a workflow pack for this task',
    ignoreFocusOut: true
  });

  if (!picked) {
    return null;
  }
  if (picked.pickType === 'none') {
    return undefined;
  }
  return picked.workflow;
}
