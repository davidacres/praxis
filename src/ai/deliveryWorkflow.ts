import type { IssueComment, IssueDetails, DeliveryWorkflowSettings } from '../types';
import type { AgentTaskDefinition, AgentWorkflowReference, DeliveryTaskResult } from './agentTypes';

const DELIVERY_RESULT_MARKER = 'DELIVERY_RESULT';

function normalizeLineEnding(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function commentTimestamp(comment: IssueComment): string {
  return comment.updated ?? comment.created ?? '';
}

function sanitizeBranchCandidate(value: string): string | undefined {
  const trimmed = value.trim().replace(/^`+|`+$/g, '');
  if (!trimmed || /\s/.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function extractBranchFromText(text: string | undefined): string | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const normalized = normalizeLineEnding(text);
  const patterns = [
    /^\s*\*\*Branch:\*\*\s*(.+)$/im,
    /^\s*\*\*Base branch:\*\*\s*(.+)$/im,
    /^\s*Branch\s*:\s*(.+)$/im,
    /^\s*Base branch\s*:\s*(.+)$/im
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const branch = sanitizeBranchCandidate(match?.[1] ?? '');
    if (branch) {
      return branch;
    }
  }

  return undefined;
}

export function extractDeliveryBaseBranch(issue: Pick<IssueDetails, 'description' | 'comments'>): string | undefined {
  const comments = [...(issue.comments ?? [])].sort((left, right) =>
    commentTimestamp(right).localeCompare(commentTimestamp(left))
  );

  for (const comment of comments) {
    const branch = extractBranchFromText(comment.body);
    if (branch) {
      return branch;
    }
  }

  return extractBranchFromText(issue.description);
}

export function validateDeliveryWorkflowSettings(settings: DeliveryWorkflowSettings): string[] {
  const errors: string[] = [];
  if (!settings.enabled) {
    errors.push('Delivery workflow is disabled in Ticket Manager settings.');
  }
  if (!settings.publishCommand) {
    errors.push('Set ticketManager.ai.deliveryPublishCommand to the repo-specific MSI publish command.');
  }
  if (!settings.artifactPattern) {
    errors.push('Set ticketManager.ai.deliveryArtifactPattern to the MSI artifact path or glob.');
  }
  return errors;
}

export function buildMissingBaseBranchClarificationComment(): string {
  return [
    'This is an AI-generated message.',
    'Copilot clarification request',
    '',
    'Implementation is blocked because the ticket does not specify the base branch to create the delivery worktree from.',
    '',
    'Questions:',
    '1. Add a line such as Base branch: main or **Branch:** release/1.2 in the Jira description or a comment.'
  ].join('\n');
}

export function buildMissingWorkflowComment(recommendations: string[]): string {
  const suggestionLines = recommendations.length > 0
    ? recommendations.map((recommendation, index) => `${index + 1}. Create a ${recommendation}.`)
    : ['1. Create a workflow pack that matches this ticket\'s implementation area and stack.'];

  return [
    'This is an AI-generated message.',
    'Copilot workflow assignment blocked',
    '',
    'Implementation is blocked because Ticket Manager could not find a relevant workflow pack for this issue.',
    '',
    'Recommended workflow packs to create:',
    ...suggestionLines
  ].join('\n');
}

export function buildDeliveryTaskDefinition(
  issue: Pick<IssueDetails, 'key' | 'summary' | 'description' | 'issueType' | 'status'>,
  options: {
    baseBranch: string;
    branchName: string;
    worktreePath: string;
    publishCommand: string;
    artifactPattern: string;
    workflow?: AgentWorkflowReference;
  }
): AgentTaskDefinition {
  return {
    kind: 'jira-delivery',
    goal: `Implement ${issue.key}: ${issue.summary} from base branch ${options.baseBranch} in the dedicated worktree at ${options.worktreePath}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Create code changes for ${issue.key} on branch ${options.branchName}.`,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `All implementation changes for ${issue.key} are complete and validated.`,
      `The branch ${options.branchName} is committed and pushed.`,
      `The MSI publish command succeeds: ${options.publishCommand}.`,
      `You identify the MSI artifact path(s) matching ${options.artifactPattern}.`
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not post Jira comments or transcripts yourself.',
      'Do not work outside the prepared worktree.',
      'Do not skip commit, push, or MSI publish steps.'
    ],
    completionContract: [
      `When the work is complete, end your final response with ${DELIVERY_RESULT_MARKER} followed by exactly one JSON code block.`,
      'Use this schema:',
      '```json',
      '{',
      '  "status": "success" | "failure",',
      '  "summary": "concise implementation summary",',
      '  "branch": "pushed branch name",',
      '  "commitHash": "git commit hash or empty string",',
      '  "pushedRef": "remote ref or empty string",',
      '  "artifactPaths": ["relative-or-absolute-artifact-path"],',
      '  "failureReason": "required when status is failure"',
      '}',
      '```',
      'Use artifactPaths relative to the worktree root when possible.'
    ].join('\n'),
    timeoutMs: 45 * 60 * 1000,
    maxSteps: 700
  };
}

export function parseDeliveryTaskResult(text: string | undefined): DeliveryTaskResult | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const normalized = normalizeLineEnding(text);
  const markerIndex = normalized.lastIndexOf(DELIVERY_RESULT_MARKER);
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
  const status = candidate.status === 'success' || candidate.status === 'failure'
    ? candidate.status
    : undefined;
  const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
  const branch = sanitizeBranchCandidate(typeof candidate.branch === 'string' ? candidate.branch : '') ?? '';
  const artifactPaths = Array.isArray(candidate.artifactPaths)
    ? candidate.artifactPaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  if (!status || !summary || !branch) {
    return undefined;
  }

  const result: DeliveryTaskResult = {
    status,
    summary,
    branch,
    commitHash: typeof candidate.commitHash === 'string' ? candidate.commitHash.trim() || undefined : undefined,
    pushedRef: typeof candidate.pushedRef === 'string' ? candidate.pushedRef.trim() || undefined : undefined,
    artifactPaths,
    failureReason:
      typeof candidate.failureReason === 'string' ? candidate.failureReason.trim() || undefined : undefined
  };

  if (result.status === 'success' && result.artifactPaths.length === 0) {
    return undefined;
  }
  if (result.status === 'failure' && !result.failureReason) {
    return undefined;
  }

  return result;
}

function applyTemplate(template: string | undefined, values: Record<string, string>): string | undefined {
  const trimmed = template?.trim();
  if (!trimmed) {
    return undefined;
  }
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    trimmed
  );
}

export function buildDeliverySuccessComment(
  result: DeliveryTaskResult,
  options?: { template?: string; attachedArtifactNames?: string[] }
): string {
  const attachedArtifactNames = options?.attachedArtifactNames?.filter(name => name.trim().length > 0) ?? [];
  const template = applyTemplate(options?.template, {
    summary: result.summary,
    branch: result.branch,
    commitHash: result.commitHash ?? '',
    pushedRef: result.pushedRef ?? '',
    artifactNames: attachedArtifactNames.join(', ')
  });
  if (template) {
    return template;
  }

  const lines = ['Implementation summary', '', result.summary, '', `Branch: ${result.branch}`];
  if (result.commitHash) {
    lines.push(`Commit: ${result.commitHash}`);
  }
  if (result.pushedRef) {
    lines.push(`Pushed ref: ${result.pushedRef}`);
  }
  if (attachedArtifactNames.length > 0) {
    lines.push(`Artifact: ${attachedArtifactNames.join(', ')}`);
  }
  return lines.join('\n');
}

export function buildDeliveryStartedComment(options: {
  baseBranch: string;
  branchName: string;
  worktreeName: string;
  workflow?: AgentWorkflowReference;
}): string {
  const lines = [
    'Copilot delivery workflow started',
    '',
    'Implementation is now running for this ticket.',
    `Base branch: ${options.baseBranch}`,
    `Delivery branch: ${options.branchName}`,
    `Worktree: ${options.worktreeName}`
  ];

  if (options.workflow) {
    lines.push(`Workflow: ${options.workflow.name}`);
    if (options.workflow.description) {
      lines.push(`Workflow summary: ${options.workflow.description}`);
    }
    lines.push(`Workflow file: ${options.workflow.instructionsPath}`);
    if (options.workflow.link) {
      lines.push(`Workflow link: ${options.workflow.link}`);
    }
  }

  return lines.join('\n');
}

export function buildDeliveryFailureComment(
  failureReason: string,
  options?: { template?: string; branch?: string; commitHash?: string; pushedRef?: string }
): string {
  const template = applyTemplate(options?.template, {
    failureReason,
    branch: options?.branch ?? '',
    commitHash: options?.commitHash ?? '',
    pushedRef: options?.pushedRef ?? ''
  });
  if (template) {
    return template;
  }

  const lines = ['Delivery workflow failed', '', failureReason];
  if (options?.branch) {
    lines.push('', `Branch: ${options.branch}`);
  }
  if (options?.commitHash) {
    lines.push(`Commit: ${options.commitHash}`);
  }
  if (options?.pushedRef) {
    lines.push(`Pushed ref: ${options.pushedRef}`);
  }
  return lines.join('\n');
}