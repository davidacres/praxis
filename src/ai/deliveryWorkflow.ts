import type { IssueComment, IssueDetails, DeliveryWorkflowSettings } from '../types';
import type { AiProvider } from '../types';
import type { AgentTaskDefinition, AgentWorkflowReference, DeliveryTaskResult } from './agentTypes';
import * as path from 'node:path';

const DELIVERY_ANALYSIS_RESULT_MARKER = 'DELIVERY_ANALYSIS_RESULT';
const DELIVERY_RESULT_MARKER = 'DELIVERY_RESULT';

export const AI_COMMENT_HEADER = '**THIS IS AN AI-GENERATED MESSAGE.**';

export interface DeliveryAnalysisResult {
  status: 'ready' | 'blocked';
  summary: string;
  implementationPlan?: string;
  blockers: string[];
}

function normalizeLineEnding(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === '\'') && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function resolveDeliveryPublishCommand(publishCommand: string, worktreePath: string): string {
  const trimmed = publishCommand.trim();
  if (!trimmed) {
    return trimmed;
  }

  const powershellFileMatch = /^(?<shell>pwsh|powershell(?:\.exe)?)(?<prefix>[\s\S]*?)\s+-File\s+(?<script>"[^"]+"|'[^']+'|[^\s]+)(?<suffix>[\s\S]*)$/i.exec(trimmed);
  if (!powershellFileMatch?.groups) {
    return trimmed;
  }

  const scriptPath = stripMatchingQuotes(powershellFileMatch.groups.script.trim());
  const resolvedScriptPath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(worktreePath, scriptPath);
  const suffix = powershellFileMatch.groups.suffix?.trim();

  return [
    `${powershellFileMatch.groups.shell}${powershellFileMatch.groups.prefix} -Command`,
    `"& { Set-Location -LiteralPath ${toPowerShellLiteral(worktreePath)}; & ${toPowerShellLiteral(resolvedScriptPath)}${suffix ? ` ${suffix}` : ''} }"`
  ].join(' ');
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

type AgentCliProvider = Extract<AiProvider, 'copilot-cli' | 'claude-cli'>;

const AGENT_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: AgentCliProvider }> = [
  { pattern: /\buse\s+claude\s*(?:code)?\b/i, provider: 'claude-cli' },
  { pattern: /\bagent\s*:\s*claude\s*(?:code)?\b/i, provider: 'claude-cli' },
  { pattern: /\bcli\s*:\s*claude\s*(?:code)?\b/i, provider: 'claude-cli' },
  { pattern: /\buse\s+copilot\b/i, provider: 'copilot-cli' },
  { pattern: /\bagent\s*:\s*copilot\b/i, provider: 'copilot-cli' },
  { pattern: /\bcli\s*:\s*copilot\b/i, provider: 'copilot-cli' },
  { pattern: /\buse\s+github\s+copilot\b/i, provider: 'copilot-cli' },
  { pattern: /\bagent\s*:\s*github\s+copilot\b/i, provider: 'copilot-cli' }
];

function extractProviderFromText(text: string | undefined): AgentCliProvider | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  for (const { pattern, provider } of AGENT_PROVIDER_PATTERNS) {
    if (pattern.test(text)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Scans the issue description and comments (most recent first) for a directive
 * indicating which CLI agent to use. Supports patterns like:
 *   - "use claude code" / "use copilot"
 *   - "Agent: claude code" / "Agent: copilot"
 *   - "CLI: claude" / "CLI: copilot"
 */
export function extractAgentProviderDirective(
  issue: Pick<IssueDetails, 'description' | 'comments'>
): AgentCliProvider | undefined {
  const comments = [...(issue.comments ?? [])].sort((left, right) =>
    commentTimestamp(right).localeCompare(commentTimestamp(left))
  );

  for (const comment of comments) {
    const provider = extractProviderFromText(comment.body);
    if (provider) {
      return provider;
    }
  }

  return extractProviderFromText(issue.description);
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
    AI_COMMENT_HEADER,
    'Copilot clarification request',
    '',
    'Implementation is blocked because the ticket does not specify the base branch to create the delivery worktree from.',
    '',
    'Questions:',
    '1. Add a line such as Base branch: main or **Branch:** release/1.2 in the Jira description or a comment.',
    '',
    'Reply to the bot by starting your comment with `#AIbot` (e.g. `#AIbot base branch: main`). Comments without that prefix are ignored.'
  ].join('\n');
}

export function buildWorktreeConflictClarificationComment(worktreeName: string): string {
  return [
    AI_COMMENT_HEADER,
    'existing worktree/branch conflict',
    '',
    `A worktree and branch named \`${worktreeName}\` already exist from a previous attempt.`,
    '',
    'How would you like to proceed?',
    '- **Delete** the existing worktree/branch and start fresh',
    '- **Reuse** the existing worktree and continue from where it left off',
    '',
    'Reply with `#AIbot delete` to remove the old worktree and start over, or `#AIbot reuse` to continue with the existing branch.'
  ].join('\n');
}

export function buildMissingWorkflowComment(recommendations: string[]): string {
  const suggestionLines = recommendations.length > 0
    ? recommendations.map((recommendation, index) => `${index + 1}. ${recommendation}`)
    : [
        '1. No workflow packs are currently available in this workspace. Add one under .github/skills, then assign it in Ticket Manager or specify it in Jira.'
      ];

  return [
    AI_COMMENT_HEADER,
    'Copilot clarification request',
    '',
    'Workflow assignment required.',
    'Implementation is blocked because no workflow pack is assigned to this issue.',
    'Specify a workflow pack either in the Ticket Manager UI or in a Jira description/comment line such as Workflow pack: add-edit-dotnet-web-api.',
    '',
    'Available workflow packs:',
    ...suggestionLines,
    '',
    'Reply to the bot by starting your comment with `#AIbot` (e.g. `#AIbot Workflow pack: add-edit-dotnet-web-api`). Comments without that prefix are ignored.'
  ].join('\n');
}

export function buildDeliveryAnalysisTaskDefinition(
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
    goal: `Analyze whether ${issue.key}: ${issue.summary} is ready for implementation from base branch ${options.baseBranch} in the dedicated worktree at ${options.worktreePath}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Inspect the repo, ticket, workflow pack, and attachments to decide whether implementation can start safely on branch ${options.branchName}.`,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `You determine whether ${issue.key} is ready for implementation without making risky assumptions.`,
      'You provide a concise readiness summary and implementation plan when ready.',
      'You provide explicit blockers when implementation should not start.'
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not modify files or create commits during the analysis phase.',
      'Do not run mutating git commands, publish commands, or MSI build steps during the analysis phase.',
      'Do not post Jira comments or transcripts yourself.',
      'Do not work outside the prepared worktree.',
      'Do not begin implementation in this analysis session.'
    ],
    completionContract: [
      `When the analysis is complete, end your final response with ${DELIVERY_ANALYSIS_RESULT_MARKER} followed by exactly one JSON code block.`,
      'Use this schema:',
      '```json',
      '{',
      '  "status": "ready" | "blocked",',
      '  "summary": "concise implementation-readiness summary",',
      '  "implementationPlan": "required when status is ready",',
      '  "blockers": ["required when status is blocked"]',
      '}',
      '```',
      'If status is ready, implementationPlan must describe the execution plan for the next fresh implementation session.',
      'If status is blocked, blockers must contain the concrete missing details or technical blockers.'
    ].join('\n'),
    timeoutMs: 2 * 60 * 60 * 1000, // 2 hours — analysis may inspect large repos / attachments
    maxSteps: 250
  };
}

export function buildSubTaskAnalysisTaskDefinition(
  issue: Pick<IssueDetails, 'key' | 'summary' | 'description' | 'issueType' | 'status'>,
  options: {
    baseBranch: string;
    branchName: string;
    worktreePath: string;
    workflow?: AgentWorkflowReference;
  }
): AgentTaskDefinition {
  return {
    kind: 'jira-delivery',
    goal: `Analyze whether ${issue.key}: ${issue.summary} is ready for implementation from base branch ${options.baseBranch} in the dedicated worktree at ${options.worktreePath}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Inspect the repo, ticket, and workflow pack to decide whether implementation can start safely on branch ${options.branchName}.`,
      'This is a sub-task of a larger feature. Focus only on the scope described in this ticket.',
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `You determine whether ${issue.key} is ready for implementation without making risky assumptions.`,
      'You provide a concise readiness summary and implementation plan when ready.',
      'You provide explicit blockers when implementation should not start.'
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not modify files or create commits during the analysis phase.',
      'Do not run mutating git commands, publish commands, or MSI build steps during the analysis phase.',
      'Do not post Jira comments or transcripts yourself.',
      'Do not work outside the prepared worktree.',
      'Do not begin implementation in this analysis session.'
    ],
    completionContract: [
      `When the analysis is complete, end your final response with ${DELIVERY_ANALYSIS_RESULT_MARKER} followed by exactly one JSON code block.`,
      'Use this schema:',
      '```json',
      '{',
      '  "status": "ready" | "blocked",',
      '  "summary": "concise implementation-readiness summary",',
      '  "implementationPlan": "required when status is ready",',
      '  "blockers": ["required when status is blocked"]',
      '}',
      '```',
      'If status is ready, implementationPlan must describe the execution plan for the next fresh implementation session.',
      'If status is blocked, blockers must contain the concrete missing details or technical blockers.'
    ].join('\n'),
    timeoutMs: 2 * 60 * 60 * 1000,
    maxSteps: 250
  };
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
    analysis?: DeliveryAnalysisResult;
  }
): AgentTaskDefinition {
  const analysisContext = options.analysis
    ? [
        'Implementation analysis summary:',
        options.analysis.summary,
        '',
        'Implementation plan from the completed analysis session:',
        options.analysis.implementationPlan ?? '(not provided)'
      ].join('\n')
    : undefined;

  return {
    kind: 'jira-delivery',
    goal: `Implement ${issue.key}: ${issue.summary} from base branch ${options.baseBranch} in the dedicated worktree at ${options.worktreePath}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Create code changes for ${issue.key} on branch ${options.branchName}.`,
      'When running build/unit/E2E test gates, only fix failures that your own code changes caused. Treat any other failure (port-in-use, server-startup/URL mismatches, missing browsers or drivers, absent services or databases, flaky harness configuration, pre-existing broken tests on the base branch) as a pre-existing infrastructure issue: record it under failureReason in the completion contract as a BLOCKED result and stop that gate. Do not edit appsettings, launch profiles, test harness code, ServerManager/fixture plumbing, CI scripts, or unrelated projects to chase infra fixes.',
      'Time-box any single diagnostic loop to at most three consecutive investigative actions (read/search/re-run). If after that the root cause still looks like environment or harness, stop and return a failure/blocked completion — do not continue investigating.',
      analysisContext,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `All implementation changes for ${issue.key} are complete and validated.`,
      `The branch ${options.branchName} is committed and pushed.`,
      `The worktree-scoped MSI publish command succeeds: ${options.publishCommand}.`,
      `You identify the MSI artifact path(s) matching ${options.artifactPattern}.`
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not post Jira comments or transcripts yourself.',
      'Do not work outside the prepared worktree.',
      'Do not skip commit, push, or MSI publish steps.',
      'Do not attempt to fix pre-existing test-harness or environment failures (port collisions, server URL or Kestrel config mismatches, missing browsers/drivers, absent services, broken fixtures, tests that already fail on the base branch). Record them as blockers in the completion contract and stop that gate instead of editing harness or infrastructure code.',
      'Do not modify test infrastructure, CI scripts, appsettings, launch profiles, or unrelated projects to work around environment problems.'
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
      '  "buildIdentifier": "required when status is success; use the MSI build suffix such as 01",',
      '  "artifactPaths": ["relative-or-absolute-artifact-path"],',
      '  "failureReason": "required when status is failure"',
      '}',
      '```',
      'Use artifactPaths relative to the worktree root when possible.'
    ].join('\n'),
    timeoutMs: 6 * 60 * 60 * 1000, // 6 hours — implementation can run full E2E suites, MSI builds, and multi-iteration review loops
    maxSteps: 700
  };
}

/**
 * Builds a task definition for a feature-decomposition sub-task.
 * Sub-tasks skip publish/artifact steps — they only implement, test, commit, and push.
 * Publishing and artifact upload happen once at the parent feature level after all
 * sub-task MRs are merged.
 */
export function buildSubTaskDeliveryTaskDefinition(
  issue: Pick<IssueDetails, 'key' | 'summary' | 'description' | 'issueType' | 'status'>,
  options: {
    baseBranch: string;
    branchName: string;
    worktreePath: string;
    workflow?: AgentWorkflowReference;
    analysis?: DeliveryAnalysisResult;
  }
): AgentTaskDefinition {
  const analysisContext = options.analysis
    ? [
        'Implementation analysis summary:',
        options.analysis.summary,
        '',
        'Implementation plan from the completed analysis session:',
        options.analysis.implementationPlan ?? '(not provided)'
      ].join('\n')
    : undefined;

  return {
    kind: 'jira-delivery',
    goal: `Implement ${issue.key}: ${issue.summary} from base branch ${options.baseBranch} in the dedicated worktree at ${options.worktreePath}.`,
    scope: [
      `Work only inside ${options.worktreePath}.`,
      `Create code changes for ${issue.key} on branch ${options.branchName}.`,
      'This is a sub-task of a larger feature. Focus only on the scope described in this ticket.',
      'When running build or unit test gates, only fix failures that your own code changes caused. Treat any other failure as a pre-existing issue: record it under failureReason in the completion contract as a BLOCKED result and stop.',
      'Time-box any single diagnostic loop to at most three consecutive investigative actions (read/search/re-run). If after that the root cause still looks like environment or harness, stop and return a failure/blocked completion.',
      analysisContext,
      issue.description?.trim() ? `Ticket description:\n${issue.description.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
    definitionOfDone: [
      `All implementation changes for ${issue.key} are complete and validated.`,
      `The branch ${options.branchName} is committed and pushed.`,
      'Unit tests pass for the changed code.',
      'Do NOT run publish, MSI build, or artifact generation steps — those will be done at the feature level after all sub-tasks are merged.'
    ].join(' '),
    workflow: options.workflow,
    nonGoals: [
      'Do not post Jira comments or transcripts yourself.',
      'Do not work outside the prepared worktree.',
      'Do not skip commit or push steps.',
      'Do not run publish commands, MSI builds, or artifact generation.',
      'Do not attempt to fix pre-existing test-harness or environment failures.',
      'Do not modify test infrastructure, CI scripts, appsettings, launch profiles, or unrelated projects.'
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
      '  "buildIdentifier": "",',
      '  "artifactPaths": [],',
      '  "failureReason": "required when status is failure"',
      '}',
      '```'
    ].join('\n'),
    timeoutMs: 4 * 60 * 60 * 1000,
    maxSteps: 500
  };
}

export function parseDeliveryAnalysisResult(text: string | undefined): DeliveryAnalysisResult | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const normalized = normalizeLineEnding(text);
  const markerIndex = normalized.lastIndexOf(DELIVERY_ANALYSIS_RESULT_MARKER);
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
  const status = candidate.status === 'ready' || candidate.status === 'blocked'
    ? candidate.status
    : undefined;
  const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
  const implementationPlan = typeof candidate.implementationPlan === 'string'
    ? candidate.implementationPlan.trim() || undefined
    : undefined;
  const blockers = Array.isArray(candidate.blockers)
    ? candidate.blockers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  if (!status || !summary) {
    return undefined;
  }
  if (status === 'ready' && !implementationPlan) {
    return undefined;
  }
  if (status === 'blocked' && blockers.length === 0) {
    return undefined;
  }

  return {
    status,
    summary,
    implementationPlan,
    blockers
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
  const buildIdentifier =
    typeof candidate.buildIdentifier === 'string' ? candidate.buildIdentifier.trim() || undefined : undefined;
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
    buildIdentifier,
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
  options?: {
    template?: string;
    attachedArtifactNames?: string[];
    reporterMention?: string;
    reporterName?: string;
  }
): string {
  const attachedArtifactNames = options?.attachedArtifactNames?.filter(name => name.trim().length > 0) ?? [];
  const reporterMention = options?.reporterMention?.trim();
  const reporterName = options?.reporterName?.trim();
  let reporterPrefix = '';
  if (reporterMention) {
    reporterPrefix = `${reporterMention} `;
  } else if (reporterName) {
    reporterPrefix = `@${reporterName} `;
  }
  const template = applyTemplate(options?.template, {
    summary: result.summary,
    branch: result.branch,
    commitHash: result.commitHash ?? '',
    pushedRef: result.pushedRef ?? '',
    artifactNames: attachedArtifactNames.join(', '),
    reporterMention: reporterMention ?? '',
    reporterName: reporterName ?? ''
  });
  if (template) {
    const prefixed = reporterPrefix
      ? `${AI_COMMENT_HEADER}\n${reporterPrefix}${template}`
      : `${AI_COMMENT_HEADER}\n${template}`;
    return prefixed;
  }

  const lines = [
    AI_COMMENT_HEADER,
    `${reporterPrefix}Implementation summary`.trimEnd(),
    '',
    result.summary,
    '',
    `Branch: ${result.branch}`
  ];
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
  agentLabel?: string;
  baseBranch: string;
  branchName: string;
  worktreeName: string;
  workflow?: AgentWorkflowReference;
}): string {
  const lines = [
    AI_COMMENT_HEADER,
    'AI delivery workflow started',
    '',
    'Implementation is now running for this ticket.',
    options.agentLabel ? `Agent: ${options.agentLabel}` : undefined,
    `Base branch: ${options.baseBranch}`,
    `Delivery branch: ${options.branchName}`,
    `Worktree: ${options.worktreeName}`
  ].filter((line): line is string => Boolean(line));

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

export function buildPollingAnalysisReadyComment(): string {
  return [
    AI_COMMENT_HEADER,
    'AI readiness analysis passed',
    '',
    'Analysis result: READY',
    'The ticket is specific enough to implement without making risky assumptions.',
    'Ticket Manager is now preparing the delivery workflow.'
  ].join('\n');
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
    return `${AI_COMMENT_HEADER}\n${template}`;
  }

  const lines = [AI_COMMENT_HEADER, 'Delivery workflow failed', '', failureReason];
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

export function buildDeliveryAnalysisBlockedComment(result: DeliveryAnalysisResult): string {
  const lines = [AI_COMMENT_HEADER, 'Delivery implementation blocked', '', result.summary];
  if (result.blockers.length > 0) {
    lines.push('', 'Blockers:');
    for (const [index, blocker] of result.blockers.entries()) {
      lines.push(`${index + 1}. ${blocker}`);
    }
  }
  return lines.join('\n');
}