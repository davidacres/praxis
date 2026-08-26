import type { ProjectType, ProjectWorkflowStage } from './projectTypes';

export const PROJECT_BRIEF_FIELDS: Record<ProjectType, Array<{ key: string; label: string }>> = {
  software: [
    { key: 'problem', label: 'Problem' }, { key: 'outcome', label: 'Intended outcome' },
    { key: 'stack', label: 'Stack' }, { key: 'integrations', label: 'Integrations' },
    { key: 'constraints', label: 'Constraints' }, { key: 'quality', label: 'Quality expectations' }
  ],
  product: [
    { key: 'users', label: 'Target users' }, { key: 'problem', label: 'Problem' },
    { key: 'outcomes', label: 'Outcomes' }, { key: 'mvp', label: 'MVP' },
    { key: 'nonGoals', label: 'Non-goals' }, { key: 'constraints', label: 'Constraints' }
  ],
  research: [
    { key: 'questions', label: 'Research questions' }, { key: 'scope', label: 'Scope' },
    { key: 'evidence', label: 'Evidence standard' }, { key: 'sources', label: 'Source expectations' },
    { key: 'deliverable', label: 'Deliverable' }
  ],
  experiment: [
    { key: 'hypothesis', label: 'Hypothesis' }, { key: 'method', label: 'Method' },
    { key: 'timebox', label: 'Timebox' }, { key: 'success', label: 'Success criteria' },
    { key: 'stopping', label: 'Stopping criteria' }
  ]
};

const STAGE_NAMES: Record<ProjectType, string[]> = {
  software: ['Backlog', 'Requirements', 'Architecture', 'Implementation', 'Verification', 'Done'],
  product: ['Backlog', 'Discovery', 'Definition', 'Delivery', 'Validation', 'Done'],
  research: ['Backlog', 'Source planning', 'Evidence', 'Synthesis', 'Review', 'Done'],
  experiment: ['Backlog', 'Setup', 'Running', 'Observations', 'Decision', 'Done']
};

const TICKETS: Record<ProjectType, string[]> = {
  software: ['Define requirements', 'Describe architecture', 'Establish the baseline', 'Build the first thin slice', 'Verify the outcome'],
  product: ['Understand users and problem', 'Define desired outcomes', 'Write MVP requirements', 'Identify risks', 'Draft the roadmap'],
  research: ['Refine research questions', 'Create the source plan', 'Collect evidence', 'Synthesize findings', 'Write recommendations'],
  experiment: ['State the hypothesis', 'Set up the experiment', 'Confirm success and stop criteria', 'Record observations', 'Make the decision']
};

export function defaultProjectWorkflow(type: ProjectType): ProjectWorkflowStage[] {
  return STAGE_NAMES[type].map((name, index) => ({ id: `stage-${index + 1}`, name }));
}

export function defaultProjectTickets(type: ProjectType) {
  const status = defaultProjectWorkflow(type)[0].name;
  return TICKETS[type].map(summary => ({ summary, description: '', issueType: 'Task', status }));
}
