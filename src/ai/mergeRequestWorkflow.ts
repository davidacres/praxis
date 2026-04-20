import type { IssueDetails } from '../types';
import type { AgentTaskDefinition, AgentWorkflowReference } from './agentTypes';

const MERGE_REQUEST_FEEDBACK_RESULT_MARKER = 'MERGE_REQUEST_FEEDBACK_RESULT';

export interface MergeRequestFeedbackResult {
  status: 'success' | 'failure';
  summary: string;
  branch: string;
  replyComment?: string;
  commitHash?: string;
  pushedRef?: string;
  didEditCode: boolean;
  failureReason?: string;
}

function normalizeLineEnding(text: string): string {
  return text.replaceAll('\r\n', '\n');
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

export function buildMergeRequestFeedbackTaskDefinition(
  issue: Pick<IssueDetails, 'key' | 'summary' | 'description' | 'issueType' | 'status'>,
  options: {
    branchName: string;
    worktreePath: string;
    mergeRequestUrl: string;
    sourceBranch: string;
    targetBranch: string;
    notes: Array<{ author: string; body: string; updatedAt: string }>;
    workflow?: AgentWorkflowReference;
  }
): AgentTaskDefinition {
  const noteSummary = options.notes
    .map((note, index) => `${index + 1}. ${note.author} (${note.updatedAt}): ${note.body}`)
    .join('\n\n');

  return {
    kind: 'jira-delivery',
    goal: `Address the latest merge request feedback for ${issue.key}: ${issue.summary} on branch ${options.branchName}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Review merge request feedback on ${options.mergeRequestUrl}.`,
      `The source branch is ${options.sourceBranch} and the target branch is ${options.targetBranch}.`,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined,
      `Latest merge request notes to address:\n${noteSummary}`
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `The latest merge request feedback for ${issue.key} is addressed.`,
      'Any necessary code changes are committed and pushed when applicable.',
      'A concise reply comment is prepared for posting back to the merge request.'
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not post merge request comments yourself.',
      'Do not work outside the prepared worktree.',
      'Do not create a new branch or a new merge request.'
    ],
    completionContract: [
      `When the work is complete, end your final response with ${MERGE_REQUEST_FEEDBACK_RESULT_MARKER} followed by exactly one JSON code block.`,
      'Use this schema:',
      '```json',
      '{',
      '  "status": "success" | "failure",',
      '  "summary": "concise summary of what was addressed",',
      '  "branch": "branch name that now contains the changes",',
      '  "replyComment": "required when status is success; concise merge request reply",',
      '  "commitHash": "git commit hash or empty string",',
      '  "pushedRef": "remote ref or empty string",',
      '  "didEditCode": true | false,',
      '  "failureReason": "required when status is failure"',
      '}',
      '```'
    ].join('\n'),
    timeoutMs: 3 * 60 * 60 * 1000,
    maxSteps: 500
  };
}

export function parseMergeRequestFeedbackResult(text: string | undefined): MergeRequestFeedbackResult | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const normalized = normalizeLineEnding(text);
  const markerIndex = normalized.lastIndexOf(MERGE_REQUEST_FEEDBACK_RESULT_MARKER);
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
  const didEditCode = candidate.didEditCode === true;

  if (!status || !summary || !branch) {
    return undefined;
  }

  const result: MergeRequestFeedbackResult = {
    status,
    summary,
    branch,
    replyComment: typeof candidate.replyComment === 'string' ? candidate.replyComment.trim() || undefined : undefined,
    commitHash: typeof candidate.commitHash === 'string' ? candidate.commitHash.trim() || undefined : undefined,
    pushedRef: typeof candidate.pushedRef === 'string' ? candidate.pushedRef.trim() || undefined : undefined,
    didEditCode,
    failureReason: typeof candidate.failureReason === 'string' ? candidate.failureReason.trim() || undefined : undefined
  };

  if (result.status === 'success' && !result.replyComment) {
    return undefined;
  }
  if (result.status === 'failure' && !result.failureReason) {
    return undefined;
  }

  return result;
}

export function buildMergeRequestReplyComment(result: MergeRequestFeedbackResult): string {
  const lines = [result.replyComment?.trim() ?? result.summary];
  if (result.didEditCode) {
    lines.push('', `Updated branch: ${result.branch}`);
    if (result.commitHash) {
      lines.push(`Commit: ${result.commitHash}`);
    }
    if (result.pushedRef) {
      lines.push(`Pushed ref: ${result.pushedRef}`);
    }
  }
  return lines.join('\n');
}

export function buildMergeRequestFailureReplyComment(failureReason: string): string {
  return [
    'Ticket Manager could not fully process the latest merge request feedback automatically.',
    '',
    failureReason.trim()
  ].join('\n');
}

export function buildMergeRequestCreatedComment(mergeRequestUrl: string): string {
  return [
    'Ticket Manager created a merge request for this completed ticket.',
    '',
    `Merge request: ${mergeRequestUrl}`
  ].join('\n');
}