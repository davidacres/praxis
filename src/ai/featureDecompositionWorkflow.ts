import type { IssueDetails } from '../types';
import type { AgentTaskDefinition, AgentWorkflowReference } from './agentTypes';

const FEATURE_DECOMPOSITION_RESULT_MARKER = 'FEATURE_DECOMPOSITION_RESULT';

export interface FeatureSubTaskDefinition {
  summary: string;
  description: string;
  issueType: string;
  /** Optional suggested workflow pack id or name. */
  suggestedWorkflow?: string;
  /** Execution order hint — lower numbers first. */
  order: number;
}

export interface FeatureDecompositionResult {
  status: 'decomposed' | 'blocked';
  summary: string;
  featureBranch: string;
  subTasks: FeatureSubTaskDefinition[];
  blockers?: string[];
}

/**
 * Detects whether an issue description signals a "feature request" that
 * should be routed through the decomposition workflow instead of the
 * standard single-task delivery pipeline.
 */
export function isFeatureRequestTicket(
  issue: Pick<IssueDetails, 'description' | 'issueType'>
): boolean {
  const description = issue.description?.trim().toLowerCase() ?? '';
  return description.includes('feature request');
}

/**
 * Builds an `AgentTaskDefinition` for the decomposition agent whose job is
 * to comprehensively analyse a feature request and break it down into
 * small, manageable, independently deliverable sub-tasks.
 */
export function buildFeatureDecompositionTaskDefinition(
  issue: Pick<IssueDetails, 'key' | 'summary' | 'description' | 'issueType' | 'status'>,
  options: {
    baseBranch: string;
    worktreePath: string;
    availableWorkflows: AgentWorkflowReference[];
    workflow?: AgentWorkflowReference;
  }
): AgentTaskDefinition {
  const workflowListText = options.availableWorkflows.length > 0
    ? options.availableWorkflows
        .map(w => `- ${w.name} (${w.id}): ${w.description ?? 'no description'}`)
        .join('\n')
    : '(no workflow packs available)';

  return {
    kind: 'jira-delivery',
    goal: `Comprehensively analyse the feature request ${issue.key}: ${issue.summary} and break it down into small, manageable, independently deliverable sub-tasks.`,
    scope: [
      `Work inside the worktree at ${options.worktreePath}.`,
      `This is a feature request ticket. Your job is to deeply understand the feature, explore the codebase to understand the architecture, and decompose the work into concrete sub-tasks that can each be independently implemented and tested.`,
      `Base branch for the feature: ${options.baseBranch}`,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 6000)}` : undefined,
      `\nAvailable workflow packs that can be assigned to sub-tasks:\n${workflowListText}`,
      `\nEach sub-task should:`,
      `- Be small enough to implement in a single focused session`,
      `- Have a clear, specific summary and detailed description`,
      `- Include acceptance criteria in the description`,
      `- Specify which workflow pack (if any) would be most appropriate`,
      `- Be ordered by dependency (tasks that others depend on should come first)`,
      `\nThe feature branch name should follow the pattern: feature/${issue.key.toLowerCase()}-<short-slug>`
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `You produce a comprehensive breakdown of ${issue.key} into sub-tasks.`,
      'Each sub-task is specific, actionable, and independently implementable.',
      'Sub-tasks are ordered by dependency — prerequisite work comes first.',
      'You suggest a feature branch name for the overall feature.'
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not modify files or create commits.',
      'Do not run build or test commands.',
      'Do not post Jira comments yourself.',
      'Do not begin implementation of any sub-task.'
    ],
    completionContract: [
      `When the decomposition is complete, end your final response with ${FEATURE_DECOMPOSITION_RESULT_MARKER} followed by exactly one JSON code block.`,
      'Use this schema:',
      '```json',
      '{',
      '  "status": "decomposed" | "blocked",',
      '  "summary": "concise summary of the feature decomposition",',
      '  "featureBranch": "feature/ISSUE-KEY-short-slug",',
      '  "subTasks": [',
      '    {',
      '      "summary": "concise sub-task title",',
      '      "description": "detailed description with acceptance criteria",',
      '      "issueType": "Task",',
      '      "suggestedWorkflow": "workflow-pack-id or empty string",',
      '      "order": 1',
      '    }',
      '  ],',
      '  "blockers": ["only when status is blocked"]',
      '}',
      '```',
      'If status is decomposed, subTasks must contain at least one entry.',
      'If status is blocked, blockers must list the concrete issues preventing decomposition.'
    ].join('\n'),
    timeoutMs: 2 * 60 * 60 * 1000,
    maxSteps: 300
  };
}

function normalizeLineEnding(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

/**
 * Parses the structured output from a feature decomposition agent session.
 */
export function parseFeatureDecompositionResult(
  text: string | undefined
): FeatureDecompositionResult | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const normalized = normalizeLineEnding(text);
  const markerIndex = normalized.lastIndexOf(FEATURE_DECOMPOSITION_RESULT_MARKER);
  const searchText = markerIndex >= 0 ? normalized.slice(markerIndex) : normalized;
  const fencedJsonMatch = searchText.match(/```json\s*([\s\S]*?)```/i);
  const jsonText = fencedJsonMatch?.[1]?.trim();
  if (!jsonText) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const status = candidate.status === 'decomposed' || candidate.status === 'blocked'
    ? candidate.status
    : undefined;
  const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
  const featureBranch = typeof candidate.featureBranch === 'string' ? candidate.featureBranch.trim() : '';

  if (!status || !summary) {
    return undefined;
  }

  if (status === 'blocked') {
    const blockers = Array.isArray(candidate.blockers)
      ? candidate.blockers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (blockers.length === 0) {
      return undefined;
    }
    return { status, summary, featureBranch, subTasks: [], blockers };
  }

  // status === 'decomposed'
  if (!featureBranch) {
    return undefined;
  }

  if (!Array.isArray(candidate.subTasks) || candidate.subTasks.length === 0) {
    return undefined;
  }

  const subTasks: FeatureSubTaskDefinition[] = [];
  for (const raw of candidate.subTasks) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const entrySummary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
    const entryDescription = typeof entry.description === 'string' ? entry.description.trim() : '';
    const entryIssueType = typeof entry.issueType === 'string' ? entry.issueType.trim() : 'Task';
    const entrySuggestedWorkflow = typeof entry.suggestedWorkflow === 'string'
      ? entry.suggestedWorkflow.trim() || undefined
      : undefined;
    const entryOrder = typeof entry.order === 'number' ? entry.order : subTasks.length + 1;

    if (!entrySummary) {
      continue;
    }

    subTasks.push({
      summary: entrySummary,
      description: entryDescription,
      issueType: entryIssueType || 'Task',
      suggestedWorkflow: entrySuggestedWorkflow,
      order: entryOrder
    });
  }

  if (subTasks.length === 0) {
    return undefined;
  }

  subTasks.sort((a, b) => a.order - b.order);

  return { status, summary, featureBranch, subTasks };
}

export function buildFeatureDecompositionStartedComment(options: {
  agentLabel?: string;
  baseBranch: string;
  worktreeName: string;
}): string {
  const AI_COMMENT_HEADER = '**THIS IS AN AI-GENERATED MESSAGE.**';
  return [
    AI_COMMENT_HEADER,
    'Feature decomposition workflow started',
    '',
    'The AI agent is analysing this feature request and will break it down into sub-tasks.',
    options.agentLabel ? `Agent: ${options.agentLabel}` : undefined,
    `Base branch: ${options.baseBranch}`,
    `Worktree: ${options.worktreeName}`
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function buildFeatureDecompositionCompleteComment(
  result: FeatureDecompositionResult
): string {
  const AI_COMMENT_HEADER = '**THIS IS AN AI-GENERATED MESSAGE.**';
  const lines = [
    AI_COMMENT_HEADER,
    'Feature decomposition complete',
    '',
    result.summary,
    '',
    `Feature branch: ${result.featureBranch}`,
    `Sub-tasks created: ${result.subTasks.length}`,
    ''
  ];

  for (const [index, subTask] of result.subTasks.entries()) {
    lines.push(`${index + 1}. ${subTask.summary}`);
    if (subTask.suggestedWorkflow) {
      lines.push(`   Workflow: ${subTask.suggestedWorkflow}`);
    }
  }

  return lines.join('\n');
}

export function buildFeatureDecompositionBlockedComment(
  result: FeatureDecompositionResult
): string {
  const AI_COMMENT_HEADER = '**THIS IS AN AI-GENERATED MESSAGE.**';
  const lines = [
    AI_COMMENT_HEADER,
    'Feature decomposition blocked',
    '',
    result.summary
  ];

  if (result.blockers && result.blockers.length > 0) {
    lines.push('', 'Blockers:');
    for (const [index, blocker] of result.blockers.entries()) {
      lines.push(`${index + 1}. ${blocker}`);
    }
  }

  lines.push('', 'Reply with "#AIbot <your clarification>" so the bot sees your response.');

  return lines.join('\n');
}
