import type { AssistantProposedAction } from '@praxis/core';

/** The icon and the "what exactly will change" text for an action card's Preview Changes. */
export function describeAction(action: AssistantProposedAction): { icon: 'zap' | 'pencil' | 'plus'; previewTitle: string; preview: string } {
  switch (action.kind) {
    case 'update-ticket':
      return { icon: 'pencil', previewTitle: 'New ticket description', preview: action.description };
    case 'create-subtask':
      return { icon: 'plus', previewTitle: 'New subtask', preview: `${action.title}\n\n${action.description}` };
    case 'delegate-session':
      return { icon: 'zap', previewTitle: 'Task for the coding agent', preview: action.prompt };
    case 'update-workflow': {
      const workflow = action.workflow as { name?: string; nodes?: Array<{ name?: string; type?: string }> };
      const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.map(node => `- ${node.name ?? '(unnamed)'} (${node.type ?? 'node'})`).join('\n') : '';
      return {
        icon: 'pencil',
        previewTitle: 'Proposed workflow',
        preview: `${workflow.name ?? 'Workflow'} — ${workflow.nodes?.length ?? 0} nodes\n${nodes}\n\n${JSON.stringify(action.workflow, null, 2)}`
      };
    }
  }
}
