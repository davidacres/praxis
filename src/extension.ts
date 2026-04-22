import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { AiSessionManager } from './ai/aiSessionManager';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerCommands } from './commands/registerCommands';
import { AppConfigStore } from './config/jiraConfig';
import { createPlanTemplate } from './file/planTemplate';
import { prepareArtifactForJiraUpload } from './file/jiraArtifactArchive';
import { BoardColumnStore } from './state/boardColumnStore';
import { BoardStore } from './state/boardStore';
import { FilterStore, shouldAdoptJiraApiEpicIssueScope } from './state/filterStore';
import { StartupPollingController } from './jira/startupPollingController';
import type {
  AiProvider,
  BackendMode,
  Board,
  IssueComment,
  IssueDetails,
  IssueSummary,
  UpdateIssueInput,
  WorkflowTransition
} from './types';
import {
  assessCopilotImplementationReadiness,
  respondToCopilotComment,
  reviewTicketWithClaude,
  reviewTicketWithCopilot,
  reviewTicketWithOpenAi,
  runLocalPeerReview
} from './ai/aiReviewService';
import { ClaudeAgentService, ClaudeAgentLogger } from './ai/claudeAgentService';
import {
  AI_PROVIDER_LABELS,
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider,
  sortAiOptionsByDefaultProvider
} from './ai/aiProviderSetup';
import { resolveBackendModeContextState } from './ui/backendModeContext';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { BoardsSidebarViewProvider } from './views/boardsSidebarViewProvider';
import { BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { EpicsSidebarViewProvider } from './views/epicsSidebarViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { LocalPeerReviewPanel } from './views/localPeerReviewPanel';
import { NewProjectWizardPanel } from './views/newProjectWizardPanel';
import { SetupWizardPanel } from './views/setupWizardPanel';
import { IssueDetailsSidebarViewProvider } from './views/issueDetailsSidebarViewProvider';
import { IssuesSidebarViewProvider } from './views/issuesSidebarViewProvider';
import { IssuesTreeProvider } from './views/issuesTreeProvider';
import { SetupSidebarViewProvider } from './views/setupSidebarViewProvider';
import { TicketManagerStatusBar } from './views/ticketManagerStatusBar';
import { CopilotAgentService, type CopilotAgentLogger } from './ai/copilotAgentService';
import { CopilotSessionPanelManager, type AgentSessionController } from './views/copilotSessionPanel';
import { ActiveSessionsSidebarViewProvider } from './views/activeSessionsSidebarViewProvider';
import type { AgentSessionRecord, AgentTaskDefinition, AgentWorkflowReference } from './ai/agentTypes';
import { resolveCopilotCliOverride } from './ai/copilotSdkRuntime';
import { getParentRule } from './issues/issueHierarchy';
import {
  AI_COMMENT_HEADER,
  buildDeliveryAnalysisBlockedComment,
  buildDeliveryAnalysisTaskDefinition,
  buildDeliveryStartedComment,
  buildDeliveryFailureComment,
  buildPollingAnalysisReadyComment,
  resolveDeliveryPublishCommand,
  buildDeliverySuccessComment,
  buildDeliveryTaskDefinition,
  buildSubTaskAnalysisTaskDefinition,
  buildSubTaskDeliveryTaskDefinition,
  buildMissingBaseBranchClarificationComment,
  buildMissingWorkflowComment,
  buildWorktreeConflictClarificationComment,
  extractAgentProviderDirective,
  extractDeliveryBaseBranch,
  parseDeliveryAnalysisResult,
  parseDeliveryTaskResult,
  validateDeliveryWorkflowSettings
} from './ai/deliveryWorkflow';
import {
  isFeatureRequestTicket,
  buildFeatureDecompositionTaskDefinition,
  buildFeatureDecompositionStartedComment,
  buildFeatureDecompositionCompleteComment,
  buildFeatureDecompositionBlockedComment,
  parseFeatureDecompositionResult,
  type FeatureDecompositionResult
} from './ai/featureDecompositionWorkflow';
import type { FeatureSubTaskRecord } from './ai/agentTypes';
import {
  buildMergeRequestCreatedComment,
  buildMergeRequestFailureReplyComment,
  buildMergeRequestFeedbackTaskDefinition,
  buildMergeRequestReplyComment,
  parseMergeRequestFeedbackResult
} from './ai/mergeRequestWorkflow';
import { GitWorktreeManager, WorktreeConflictError } from './git/gitWorktreeManager';
import {
  discoverWorkspaceAgentWorkflows,
  promptForAgentWorkflowSelection,
  resolveWorkflowReference
} from './ai/agentWorkflowCatalog';
import { stageIssueAttachments } from './ai/issueAttachmentContext';
import {
  createGitLabHandledNoteState,
  diffGitLabDiscussionNotes,
  GitLabApiService,
  inferGitLabProjectFromRepo,
  isTicketManagerManagedMergeRequestNote,
  mergeRequestMatchesIssueKey,
  shouldCreateMergeRequestForStatusChange,
  wrapTicketManagerManagedMergeRequestNote,
  type GitLabDiscussionNote,
  type GitLabMergeRequest
} from './gitlab/gitLabApiService';

export interface TicketManagerExtensionApi {
  refresh(): Promise<void>;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  boardColumnStore: BoardColumnStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  configStore: AppConfigStore;
  aiSessionManager: AiSessionManager;
  outputChannel: vscode.OutputChannel;
}

interface AiOptionPick {
  provider: AiProvider;
  label: string;
  description: string;
  agentName?: string;
  credential?: string;
}

interface AiAssignmentMenuOption {
  provider: AiProvider;
  label: string;
}

function logError(output: vscode.OutputChannel, error: unknown, scope?: string): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  output.appendLine(scope ? `[${scope}] ${message}` : message);
}

function extractCopilotRequest(body: string, extraMentionName?: string): string | undefined {
  const names = ['copilot'];
  if (extraMentionName) {
    names.push(extraMentionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const pattern = new RegExp(`(?:^|\\s)@(?:${names.join('|')})\\b[:,]?\\s*`, 'i');
  const mentionMatch = body.match(pattern);
  if (!mentionMatch) {
    return undefined;
  }

  const start = mentionMatch.index!;
  const cleaned = `${body.slice(0, start)}${body.slice(start + mentionMatch[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Please help with this ticket.';
}

let deactivateHandler: (() => Promise<void>) | undefined;

const COPILOT_CLARIFICATION_COMMENT_MARKER = 'Copilot clarification request';
const COPILOT_REPLY_COMMENT_MARKER = '@copilot reply';
const COPILOT_ANALYSIS_START_COMMENT = `${AI_COMMENT_HEADER}\nAnalysis starting`;
const COPILOT_ANALYSIS_READY_COMMENT_MARKER = 'AI readiness analysis passed';
const COPILOT_AGENT_INPUT_REQUEST_MARKER = 'Agent input requested';
const WORKTREE_CONFLICT_COMMENT_MARKER = 'existing worktree/branch conflict';
const DELIVERY_FORWARD_STATUS_PREFERENCES = [
  'ready for qa',
  'qa ready',
  'ready for test',
  'ready for testing',
  'testing',
  'in review',
  'review',
  'ready for validation',
  'resolved',
  'closed',
  'done'
] as const;
const DELIVERY_NON_PROGRESS_PATTERNS = [
  /block/i,
  /backlog/i,
  /^to do$/i,
  /^todo$/i,
  /selected for development/i,
  /^open$/i,
  /^new$/i,
  /cancel/i,
  /reject/i,
  /resume/i,
  /reopen/i,
  /hold/i
] as const;

interface PollingIssueSnapshot {
  key: string;
  fields?: {
    summary?: string;
    updated?: string;
    status?: {
      name?: string;
      statusCategory?: {
        name?: string;
      };
    };
  };
}

interface PollingSyncEvent {
  issues: PollingIssueSnapshot[];
  newKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  eligibleIssueKeys: string[];
}

interface ResolvedGitLabAutomation {
  client: GitLabApiService;
  baseUrl: string;
  projectPath: string;
}

function formatStatusSnapshot(status: string | undefined, statusCategory: string | undefined): string {
  return JSON.stringify({
    status: status?.trim() ?? '',
    statusCategory: statusCategory?.trim() ?? ''
  });
}

function parseStatusSnapshot(snapshot: string | undefined): { status?: string; statusCategory?: string } {
  if (!snapshot?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(snapshot) as { status?: unknown; statusCategory?: unknown };
    return {
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      statusCategory: typeof parsed.statusCategory === 'string' ? parsed.statusCategory : undefined
    };
  } catch {
    return {
      status: snapshot
    };
  }
}

function buildMergeRequestDescription(
  issue: IssueDetails,
  record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
): string {
  const lines = [
    `Jira ticket: ${issue.key}`,
    `Summary: ${issue.summary}`,
    `Base branch: ${record.delivery.baseBranch}`,
    `Delivery branch: ${record.delivery.createdBranch}`
  ];
  if (issue.description?.trim()) {
    lines.push('', issue.description.trim().slice(0, 4000));
  }
  return lines.join('\n');
}

function filterGitLabNotesForAutomation(notes: GitLabDiscussionNote[]): GitLabDiscussionNote[] {
  return notes.filter(note =>
    !note.system &&
    note.body.trim().length > 0 &&
    !isTicketManagerManagedMergeRequestNote(note.body)
  );
}

function normalizeTransitionLabel(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function isNonProgressTransitionLabel(value: string): boolean {
  return DELIVERY_NON_PROGRESS_PATTERNS.some(pattern => pattern.test(value));
}

export function selectNextDeliveryTransition(
  issue: Pick<IssueDetails, 'status' | 'statusCategory' | 'transitions'>
): WorkflowTransition | undefined {
  if (issue.statusCategory?.trim().toLowerCase() === 'done') {
    return undefined;
  }

  const currentStatus = normalizeTransitionLabel(issue.status);
  const candidates = (issue.transitions ?? [])
    .map((transition, index) => ({
      transition,
      index,
      targetStatus: normalizeTransitionLabel(transition.toStatus || transition.name),
      transitionName: normalizeTransitionLabel(transition.name)
    }))
    .filter(candidate => candidate.targetStatus.length > 0 && candidate.targetStatus !== currentStatus)
    .map(candidate => {
      const preferredIndex = DELIVERY_FORWARD_STATUS_PREFERENCES.indexOf(
        candidate.targetStatus as (typeof DELIVERY_FORWARD_STATUS_PREFERENCES)[number]
      );
      const isNonProgress =
        isNonProgressTransitionLabel(candidate.targetStatus) ||
        isNonProgressTransitionLabel(candidate.transitionName);
      const score = preferredIndex >= 0
        ? 100 - preferredIndex
        : isNonProgress
          ? -10
          : 50;

      return {
        ...candidate,
        score
      };
    })
    .filter(candidate => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  return candidates[0]?.transition;
}

function getCommentActivityTimestamp(comment: IssueComment): string {
  return comment.updated ?? comment.created ?? '';
}

function sortCommentsChronologically(comments: IssueComment[]): IssueComment[] {
  return [...comments].sort((left, right) => {
    const timestampComparison = getCommentActivityTimestamp(left).localeCompare(
      getCommentActivityTimestamp(right)
    );
    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    return (left.id ?? '').localeCompare(right.id ?? '');
  });
}

function isCopilotGeneratedComment(comment: IssueComment): boolean {
  return (
    comment.body.includes(AI_COMMENT_HEADER) ||
    comment.body.includes(COPILOT_CLARIFICATION_COMMENT_MARKER) ||
    comment.body.includes(COPILOT_REPLY_COMMENT_MARKER)
  );
}

function formatPollingClarificationComment(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.includes(COPILOT_CLARIFICATION_COMMENT_MARKER)) {
    return trimmed;
  }

  return [
    AI_COMMENT_HEADER,
    COPILOT_CLARIFICATION_COMMENT_MARKER,
    '',
    trimmed
  ].join('\n');
}

function isAnalysisLifecycleComment(comment: IssueComment): boolean {
  const normalizedBody = comment.body.trim();
  return (
    isCopilotGeneratedComment(comment)
    || normalizedBody.includes(COPILOT_ANALYSIS_READY_COMMENT_MARKER)
  );
}

function getCopilotCommentSignature(comment: IssueComment): string {
  return `${comment.id ?? ''}|${getCommentActivityTimestamp(comment)}|${comment.body}`;
}

function getLatestCopilotCommentSignature(issue: IssueDetails): string | undefined {
  const comments = sortCommentsChronologically(issue.comments ?? []);
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (isCopilotGeneratedComment(comments[index])) {
      return getCopilotCommentSignature(comments[index]);
    }
  }
  return undefined;
}

export function extractPendingCopilotReplyRequest(issue: IssueDetails): string | undefined {
  const comments = sortCommentsChronologically(issue.comments ?? []);
  let lastCopilotCommentIndex = -1;

  for (let index = 0; index < comments.length; index += 1) {
    if (isCopilotGeneratedComment(comments[index])) {
      lastCopilotCommentIndex = index;
    }
  }

  if (lastCopilotCommentIndex < 0) {
    return undefined;
  }

  const pendingReplies = comments
    .slice(lastCopilotCommentIndex + 1)
    .filter(comment => !isCopilotGeneratedComment(comment) && comment.body.trim().length > 0)
    .map(comment => {
      const stripped = stripAiBotPrefix(comment.body);
      return stripped === undefined ? undefined : { comment, body: stripped };
    })
    .filter((entry): entry is { comment: IssueComment; body: string } => entry !== undefined);

  if (pendingReplies.length === 0) {
    return undefined;
  }

  return pendingReplies
    .map(({ comment, body }) => `${comment.author?.trim() || 'User'}: ${body}`)
    .join('\n\n');
}

/**
 * Jira polling only treats a comment as a reply to the Copilot agent when the
 * comment starts with the literal trigger `#AIbot`. Everything else is ignored
 * so the bot never responds to unrelated discussion on a ticket.
 *
 * Returns the comment body with the prefix removed when the trigger is present,
 * or `undefined` when the comment should be ignored.
 */
export function stripAiBotPrefix(body: string): string | undefined {
  const trimmed = body.trim();
  const match = /^#aibot\b[\s:,-]*/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const remainder = trimmed.slice(match[0].length).trim();
  return remainder.length > 0 ? remainder : undefined;
}

/**
 * Returns true when the ticket already has at least one Copilot analysis
 * lifecycle comment (analysis start, readiness-ready marker, or any other
 * Copilot-generated comment). Used to detect "the bot has spoken once — do
 * not re-engage unless the user explicitly pings with #AIbot".
 */
export function hasAnyAnalysisLifecycleComment(issue: Pick<IssueDetails, 'comments'>): boolean {
  return (issue.comments ?? []).some(comment => isAnalysisLifecycleComment(comment));
}

/**
 * Returns true when there is at least one user comment starting with the
 * `#AIbot` trigger that was posted AFTER the most recent analysis lifecycle
 * comment. This is the only condition under which polling is allowed to
 * re-run analysis / delivery after the bot has already weighed in once.
 */
export function hasPendingAiBotTrigger(issue: Pick<IssueDetails, 'comments'>): boolean {
  const comments = sortCommentsChronologically(issue.comments ?? []);
  let lastLifecycleIndex = -1;
  for (let index = 0; index < comments.length; index += 1) {
    if (isAnalysisLifecycleComment(comments[index])) {
      lastLifecycleIndex = index;
    }
  }
  if (lastLifecycleIndex < 0) {
    return false;
  }
  for (let index = lastLifecycleIndex + 1; index < comments.length; index += 1) {
    const comment = comments[index];
    if (isAnalysisLifecycleComment(comment)) {
      continue;
    }
    if (stripAiBotPrefix(comment.body) !== undefined) {
      return true;
    }
  }
  return false;
}

export function buildPollingAnalysisSignature(issue: Pick<
  IssueDetails,
  'key' | 'summary' | 'description' | 'status' | 'issueType' | 'priority' | 'parentIssue' | 'comments'
>): string {
  // Only #AIbot-prefixed comments should be able to invalidate the analysis
  // signature. Random user chatter on the ticket must never re-trigger
  // analysis or delivery — the bot only reacts when explicitly addressed.
  const relevantComments = sortCommentsChronologically(issue.comments ?? [])
    .filter(comment => !isAnalysisLifecycleComment(comment))
    .map(comment => {
      const triggered = stripAiBotPrefix(comment.body);
      if (triggered === undefined) {
        return undefined;
      }
      return {
        id: comment.id ?? '',
        author: comment.author ?? '',
        body: triggered,
        timestamp: getCommentActivityTimestamp(comment)
      };
    })
    .filter((entry): entry is { id: string; author: string; body: string; timestamp: string } => entry !== undefined);

  return createHash('sha1')
    .update(
      JSON.stringify({
        key: issue.key,
        summary: issue.summary,
        description: issue.description ?? '',
        status: issue.status,
        issueType: issue.issueType,
        priority: issue.priority ?? '',
        parentKey: issue.parentIssue?.key ?? '',
        comments: relevantComments
      })
    )
    .digest('hex');
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<TicketManagerExtensionApi> {
  const handledPollingReplyStateKey = 'ticketManager.handledPollingReplyThreads';
  const handledPollingAnalysisStateKey = 'ticketManager.handledPollingAnalysis';
  const pollingStatusSnapshotStateKey = 'ticketManager.pollingStatusSnapshots';
  const handledPollingReplies: Record<string, string> =
    context.workspaceState.get<Record<string, string>>(handledPollingReplyStateKey) ?? {};
  const handledPollingAnalyses: Record<string, string> =
    context.workspaceState.get<Record<string, string>>(handledPollingAnalysisStateKey) ?? {};
  const pollingStatusSnapshots: Record<string, string> =
    context.workspaceState.get<Record<string, string>>(pollingStatusSnapshotStateKey) ?? {};
  const outputChannel = vscode.window.createOutputChannel('Ticket Manager');
  const configStore = new AppConfigStore();
  const aiSessionManager = new AiSessionManager(context.workspaceState);
  const startupPollingController = new StartupPollingController(
    context,
    configStore,
    outputChannel,
    async event => {
      await processPollingClarificationRequests(event);
      await processPollingClarificationReplies(event);
      await processPollingAgentInputReplies(event);
      await processPollingMergeRequestAutomation(event);

      if (
        event.newKeys.length === 0 &&
        event.removedKeys.length === 0 &&
        event.changedKeys.length === 0
      ) {
        return;
      }

      await refreshAndRestoreSelection();
    }
  );
  const copilotAgentLogger: CopilotAgentLogger = {
    appendLine(message: string): void {
      outputChannel.appendLine(message);
    }
  };
  const copilotAgentService = new CopilotAgentService(aiSessionManager, copilotAgentLogger);
  const claudeAgentLogger: ClaudeAgentLogger = new ClaudeAgentLogger(outputChannel);
  const claudeAgentService = new ClaudeAgentService(aiSessionManager, claudeAgentLogger);
  const agentSessionController: AgentSessionController = {
    onDidChangeActiveTask(listener) {
      const disposeCopilot = copilotAgentService.onDidChangeActiveTask(listener);
      const disposeClaude = claudeAgentService.onDidChangeActiveTask(listener);
      return () => {
        disposeCopilot();
        disposeClaude();
      };
    },
    respondToInput(issueKey, response) {
      if (claudeAgentService.hasActiveTask(issueKey)) {
        claudeAgentService.respondToInput(issueKey, response);
        return;
      }
      copilotAgentService.respondToInput(issueKey, response);
    },
    respondToPermission(issueKey, decision) {
      if (claudeAgentService.hasActiveTask(issueKey)) {
        claudeAgentService.respondToPermission(issueKey, decision);
        return;
      }
      copilotAgentService.respondToPermission(issueKey, decision);
    },
    hasActiveTask(issueKey) {
      return copilotAgentService.hasActiveTask(issueKey) || claudeAgentService.hasActiveTask(issueKey);
    },
    getPendingPermissionDescriptions(issueKey) {
      return claudeAgentService.hasActiveTask(issueKey)
        ? claudeAgentService.getPendingPermissionDescriptions(issueKey)
        : copilotAgentService.getPendingPermissionDescriptions(issueKey);
    },
    getPendingPermissions(issueKey) {
      return claudeAgentService.hasActiveTask(issueKey)
        ? claudeAgentService.getPendingPermissions(issueKey)
        : copilotAgentService.getPendingPermissions(issueKey);
    }
  };
  const copilotSessionPanelManager = new CopilotSessionPanelManager(
    aiSessionManager,
    agentSessionController,
    async issueKey => {
      await abandonAiSession(issueKey);
    },
    async issueKey => {
      await resumeCopilotSession(issueKey);
    },
    async issueKey => {
      await startNewCopilotSession(issueKey);
    }
  );
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const boardColumnStore = new BoardColumnStore(context);
  const boardColumnConfigPanel = new BoardColumnConfigPanel(boardColumnStore);
  const newProjectWizardPanel = new NewProjectWizardPanel();
  const setupWizardPanel = new SetupWizardPanel();
  const setupSidebarViewProvider = new SetupSidebarViewProvider();
  const backendService = new BackendRouter(context, configStore, outputChannel);
  const ticketManagerStatusBar = new TicketManagerStatusBar(
    configStore,
    backendService,
    aiSessionManager
  );
  const workingDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const gitWorktreeManager = workingDirectory ? new GitWorktreeManager(outputChannel) : undefined;
  let suppressCloseWarning = false;
  let lastCloseWarningSignature: string | undefined;
  const permissionPromptSignatures = new Map<string, string>();
  const permissionPromptInFlight = new Set<string>();
  const pollingClarificationInFlight = new Set<string>();
  const pollingReplyInFlight = new Set<string>();
  const pollingAgentInputReplyInFlight = new Set<string>();
  const deliveryFinalizationInFlight = new Set<string>();
  const mergeRequestAutomationInFlight = new Set<string>();
  let cachedGitLabAutomationKey: string | undefined;
  let cachedGitLabAutomation: ResolvedGitLabAutomation | undefined;
  let lastGitLabAutomationSkipReason: string | undefined;

  async function setHandledPollingReply(issueKey: string, signature: string | undefined): Promise<void> {
    if (signature) {
      handledPollingReplies[issueKey] = signature;
    } else {
      delete handledPollingReplies[issueKey];
    }
    await context.workspaceState.update(handledPollingReplyStateKey, handledPollingReplies);
  }

  async function setHandledPollingAnalysis(issueKey: string, signature: string | undefined): Promise<void> {
    if (signature) {
      handledPollingAnalyses[issueKey] = signature;
    } else {
      delete handledPollingAnalyses[issueKey];
    }
    await context.workspaceState.update(handledPollingAnalysisStateKey, handledPollingAnalyses);
  }

  async function persistPollingStatusSnapshots(nextSnapshots: Record<string, string>): Promise<void> {
    const keysToRemove = Object.keys(pollingStatusSnapshots).filter(key => !(key in nextSnapshots));
    for (const key of keysToRemove) {
      delete pollingStatusSnapshots[key];
    }
    for (const [issueKey, snapshot] of Object.entries(nextSnapshots)) {
      pollingStatusSnapshots[issueKey] = snapshot;
    }
    await context.workspaceState.update(pollingStatusSnapshotStateKey, pollingStatusSnapshots);
  }

  function reportError(error: unknown, scope?: string): void {
    logError(outputChannel, error, scope);
    ticketManagerStatusBar.recordError(error);
  }

  function isCopilotSdkConfigured(): boolean {
    const providers = configStore.getConfiguredAiProviders();
    // Default to Copilot SDK when no agent provider is explicitly configured.
    if (!providers.includes('copilot-cli') && !providers.includes('claude-cli')) {
      return true;
    }
    return providers.includes('copilot-cli');
  }

  function isClaudeSdkConfigured(): boolean {
    return configStore.getConfiguredAiProviders().includes('claude-cli');
  }

  function buildCommentPlaceholder(): string {
    const custom = configStore.getAiMentionName().trim();
    if (custom) {
      return `Write a comment (mention @copilot or @${custom} for a reply)`;
    }
    return 'Write a comment (mention @copilot for a reply)';
  }

  function updateCommentPlaceholders(): void {
    const placeholder = buildCommentPlaceholder();
    issueDetailPanelManager.setCommentPlaceholder(placeholder);
    issueDetailsSidebarViewProvider?.setCommentPlaceholder(placeholder);
  }

  function hasCopilotClarificationComment(issue: IssueDetails): boolean {
    return issue.comments?.some(comment => comment.body.includes(COPILOT_CLARIFICATION_COMMENT_MARKER)) ?? false;
  }

  function hasCopilotAnalysisStartComment(issue: IssueDetails): boolean {
    return issue.comments?.some(comment => comment.body.includes('Analysis starting')) ?? false;
  }

  async function postCopilotReply(issueKey: string, request: string): Promise<void> {
    const cliPath = getCopilotCliPathOverride();
    const issue = await backendService.getIssue(issueKey);
    const response = await respondToCopilotComment(issue, cliPath, request, workingDirectory);
    await backendService.addComment(issueKey, response);
  }

  async function handlePollingAnalysisReady(
    issue: IssueDetails,
    options?: {
      analysisSignature?: string;
      replySignature?: string;
      forceCleanWorktree?: boolean;
    }
  ): Promise<void> {
    // Route feature requests to the decomposition workflow
    let started: boolean;
    try {
    if (isFeatureRequestTicket(issue)) {
      outputChannel.appendLine(
        `[Jira Polling] Detected feature request on ${issue.key}; routing to decomposition workflow.`
      );
      started = await startFeatureDecompositionWorkflow(issue, { forceCleanWorktree: options?.forceCleanWorktree });
      if (started) {
        outputChannel.appendLine(
          `[Jira Polling] Feature decomposition workflow started for ${issue.key}.`
        );
      }
    } else {
      started = await startPollingDeliveryWorkflow(issue, { forceCleanWorktree: options?.forceCleanWorktree });
      if (started) {
        outputChannel.appendLine(
          `[Jira Polling] Readiness analysis passed on ${issue.key}; delivery workflow started.`
        );
      }
    }
    } catch (error) {
      if (error instanceof WorktreeConflictError) {
        outputChannel.appendLine(
          `[Jira Polling] Worktree conflict for ${issue.key}: ${error.worktreeName} already exists. Posting clarification comment.`
        );
        await backendService.addComment(
          issue.key,
          buildWorktreeConflictClarificationComment(error.worktreeName)
        );
        return;
      }
      throw error;
    }

    if (options?.analysisSignature !== undefined) {
      await setHandledPollingAnalysis(issue.key, options.analysisSignature);
    }
    if (options?.replySignature !== undefined) {
      await setHandledPollingReply(issue.key, options.replySignature);
    }
  }

  function ensureWorkflowAssignedFromAnalysis(
    issueKey: string,
    workflowReference: string | undefined,
    availableWorkflows: AgentWorkflowReference[]
  ): void {
    if (aiSessionManager.getIssueWorkflowAssignment(issueKey)) {
      return;
    }

    const resolvedWorkflow = resolveWorkflowReference(workflowReference, availableWorkflows);

    // Workflow packs are optional. When analysis reports "ready" we always
    // record an assignment so the delivery flow sees a decision, even when
    // the ticket did not name a pack (assignment.workflow === undefined
    // represents an explicit "no workflow pack" choice).
    let reason: string;
    if (resolvedWorkflow) {
      reason = workflowReference?.trim()
        ? `Extracted from Jira during analysis: ${workflowReference.trim()}`
        : 'Extracted from Jira during analysis.';
    } else {
      reason = 'Analysis determined no workflow pack is needed.';
    }

    aiSessionManager.setIssueWorkflowAssignment(issueKey, resolvedWorkflow, {
      source: 'analysis',
      reason
    });
  }

  function isDeliveryTask(
    record: AgentSessionRecord | undefined
  ): record is AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> } {
    return record?.taskDefinition.kind === 'jira-delivery' && Boolean(record.delivery);
  }

  function getLatestAgentFailureSummary(record: AgentSessionRecord): string | undefined {
    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      if (event.type === 'error' && event.summary.trim().length > 0) {
        return event.summary.trim();
      }
    }
    return undefined;
  }

  async function advanceDeliveredIssueToNextStatus(issueKey: string): Promise<string | undefined> {
    const currentIssue = await backendService.getIssue(issueKey);
    const transitions = currentIssue.transitions?.length
      ? currentIssue.transitions
      : await backendService.getTransitions(issueKey);
    const selectedTransition = selectNextDeliveryTransition({
      status: currentIssue.status,
      statusCategory: currentIssue.statusCategory,
      transitions
    });
    if (!selectedTransition) {
      return undefined;
    }

    await backendService.transitionIssue(issueKey, selectedTransition.id);
    await syncIssueAfterMutation(issueKey);
    return selectedTransition.toStatus?.trim() || selectedTransition.name.trim() || undefined;
  }

  async function startFreshDeliveryImplementationSession(
    issue: IssueDetails,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    analysisResult: NonNullable<ReturnType<typeof parseDeliveryAnalysisResult>>
  ): Promise<void> {
    const isSubTask = Boolean(record.delivery.parentFeatureIssueKey);
    const implementationTaskDefinition = isSubTask
      ? buildSubTaskDeliveryTaskDefinition(issue, {
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreePath: record.delivery.worktreePath,
          workflow: record.taskDefinition.workflow,
          analysis: analysisResult
        })
      : buildDeliveryTaskDefinition(issue, {
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreePath: record.delivery.worktreePath,
          publishCommand: record.delivery.publishCommand,
          artifactPattern: record.delivery.artifactPattern,
          workflow: record.taskDefinition.workflow,
          analysis: analysisResult
        });
    const taskDefinitionWithAttachments = record.taskDefinition.attachments?.length
      ? { ...implementationTaskDefinition, attachments: record.taskDefinition.attachments }
      : implementationTaskDefinition;

    const provider = await startAgentTask(
      {
        ...issue,
        branch: record.delivery.createdBranch
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(issue.key, record, issue),
        workingDirectory: record.delivery.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        ...record.delivery,
        phase: 'implementation',
        analysisSummary: analysisResult.summary,
        analysisPlan: analysisResult.implementationPlan,
        finalizationState: 'pending',
        finalizationMessage: 'Fresh implementation session started after delivery analysis.'
      },
      { replace: true }
    );

    try {
      await backendService.addComment(
        issue.key,
        buildDeliveryStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreeName: record.delivery.worktreeName,
          workflow: taskDefinitionWithAttachments.workflow
        })
      );
    } catch (error) {
      reportError(error, `deliveryStartComment:${issue.key}`);
    }
  }

  /**
   * Recover in-flight delivery sessions after an extension restart.
   * Scans all persisted agent sessions and processes any that were interrupted:
   * 0. Sessions that were paused by deactivation while actively running → auto-resume
   * 1. Sessions with finalizationState='pending' that completed/failed → finalize them
   * 2. Sub-task deliveries that finalized but never created an MR → create MR
   * 3. Sub-task MRs that were merged but next sub-task wasn't started → advance
   */
  async function recoverPendingDeliverySessions(): Promise<void> {
    const allSessions = aiSessionManager.getAllAgentSessions();
    let recoveredCount = 0;

    // First pass: auto-resume paused delivery sessions
    for (const [issueKey, record] of allSessions) {
      if (!isDeliveryTask(record)) {
        continue;
      }

      if (
        record.state === 'paused' &&
        record.delivery.source === 'jira-polling' &&
        record.delivery.finalizationState === 'pending'
      ) {
        outputChannel.appendLine(
          `[Recovery] Found paused delivery session for ${issueKey} (phase: ${record.delivery.phase}). Auto-resuming.`
        );
        try {
          await resumeAgentTask(issueKey, record);
          outputChannel.appendLine(`[Recovery] Successfully resumed session for ${issueKey}.`);
          recoveredCount++;
        } catch (error) {
          outputChannel.appendLine(
            `[Recovery] Failed to resume session for ${issueKey}: ${error instanceof Error ? error.message : String(error)}. Will attempt restart.`
          );
          // If resume fails (e.g. SDK session expired), restart the delivery
          // from the current phase with a fresh agent task.
          try {
            await restartPausedDeliverySession(issueKey, record);
            recoveredCount++;
          } catch (restartError) {
            reportError(restartError, `recovery:restart:${issueKey}`);
          }
        }
        continue;
      }
    }

    // Second pass: handle completed/failed sessions that need finalization or advancement
    for (const [issueKey, record] of allSessions) {
      if (!isDeliveryTask(record)) {
        continue;
      }
      const delivery = record.delivery;

      // Skip sessions we just resumed above
      if (record.state === 'paused') {
        continue;
      }

      // Case 1: Session completed/failed but finalization never ran (e.g. restart mid-flight)
      if (
        delivery.finalizationState === 'pending' &&
        (record.state === 'completed' || record.state === 'failed')
      ) {
        outputChannel.appendLine(
          `[Recovery] Found pending finalization for ${issueKey} (state: ${record.state}, phase: ${delivery.phase}). Re-triggering finalization.`
        );
        void finalizeDeliverySession(record);
        recoveredCount++;
        continue;
      }

      // Case 2: Sub-task delivery finalized but wasn't properly completed
      // under the new flow (transition to Done + MR creation). This handles
      // sub-tasks that completed under older code or where the finalization
      // was interrupted between steps.
      if (
        delivery.parentFeatureIssueKey &&
        delivery.finalizationState === 'completed'
      ) {
        try {
          // Ensure the parent's sub-task tracking reflects completion
          updateParentSubTaskState(delivery.parentFeatureIssueKey, issueKey, 'completed');

          // Ensure the sub-task is transitioned to Done in Jira
          const subTaskIssue = await backendService.getIssue(issueKey);
          if (subTaskIssue.status !== 'Done') {
            const doneTransitionId = await findTransitionIdForStatus(issueKey, 'Done');
            if (doneTransitionId) {
              await backendService.transitionIssue(issueKey, doneTransitionId);
              outputChannel.appendLine(
                `[Recovery] Transitioned sub-task ${issueKey} to Done.`
              );
            }
          }

          // Ensure the MR exists
          if (!delivery.mergeRequest?.iid) {
            outputChannel.appendLine(
              `[Recovery] Sub-task ${issueKey} completed but has no merge request. Creating MR.`
            );
            await ensureMergeRequestForDoneIssue(issueKey);
          }
          recoveredCount++;
        } catch (error) {
          reportError(error, `recovery:subTaskComplete:${issueKey}`);
        }
        continue;
      }

      // Case 3: Sub-task MR was merged but next sub-task was never started
      if (
        delivery.parentFeatureIssueKey &&
        delivery.mergeRequest?.state === 'merged'
      ) {
        const parentRecord = aiSessionManager.getAgentSession(delivery.parentFeatureIssueKey);
        const featureDecomp = parentRecord?.delivery?.featureDecomposition;
        if (featureDecomp) {
          const hasNextPending = featureDecomp.subTasks
            .sort((a, b) => a.order - b.order)
            .some(st => st.deliveryState === 'pending');
          const hasInProgress = featureDecomp.subTasks
            .some(st => st.deliveryState === 'in-progress');
          // Only advance if there's a pending sub-task but none currently in-progress
          if (hasNextPending && !hasInProgress) {
            outputChannel.appendLine(
              `[Recovery] Sub-task ${issueKey} MR merged but next sub-task not started. Advancing.`
            );
            try {
              await advanceToNextSubTask(delivery.parentFeatureIssueKey);
              recoveredCount++;
            } catch (error) {
              reportError(error, `recovery:advanceSubTask:${issueKey}`);
            }
          }
        }
      }
    }

    if (recoveredCount > 0) {
      outputChannel.appendLine(
        `[Recovery] Recovered ${recoveredCount} delivery session(s) from previous run.`
      );
    }
  }

  /**
   * When a paused delivery session cannot be resumed (e.g. SDK session expired),
   * restart the delivery from scratch using the persisted metadata. The existing
   * worktree and branch are reused — only the agent task is recreated.
   */
  async function restartPausedDeliverySession(
    issueKey: string,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const delivery = record.delivery;
    const issue = await backendService.getIssue(issueKey);

    // Determine whether this is a sub-task delivery
    const isSubTask = Boolean(delivery.parentFeatureIssueKey);

    // Rebuild the task definition based on the delivery phase
    let taskDefinition: AgentTaskDefinition;
    if (delivery.phase === 'analysis') {
      taskDefinition = isSubTask
        ? buildSubTaskAnalysisTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            workflow: record.taskDefinition.workflow
          })
        : buildDeliveryAnalysisTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            publishCommand: delivery.publishCommand,
            artifactPattern: delivery.artifactPattern,
            workflow: record.taskDefinition.workflow
          });
    } else if (delivery.phase === 'implementation') {
      const analysis = delivery.analysisSummary
        ? { status: 'ready' as const, summary: delivery.analysisSummary, implementationPlan: delivery.analysisPlan, blockers: [] }
        : undefined;
      taskDefinition = isSubTask
        ? buildSubTaskDeliveryTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            workflow: record.taskDefinition.workflow,
            analysis
          })
        : buildDeliveryTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            publishCommand: delivery.publishCommand,
            artifactPattern: delivery.artifactPattern,
            workflow: record.taskDefinition.workflow,
            analysis
          });
    } else {
      outputChannel.appendLine(
        `[Recovery] Cannot restart ${issueKey}: unsupported phase '${delivery.phase}'.`
      );
      return;
    }

    // Carry over any attachments from the original task
    if (record.taskDefinition.attachments?.length) {
      taskDefinition.attachments = record.taskDefinition.attachments;
    }

    const provider = await startAgentTask(
      { ...issue, branch: delivery.createdBranch },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(issueKey, record, issue),
        workingDirectory: delivery.worktreePath
      }
    );

    // Preserve the existing delivery metadata (worktree, branches, parent reference, etc.)
    aiSessionManager.updateAgentDelivery(issueKey, {
      ...delivery,
      finalizationState: 'pending',
      finalizationMessage: `Session restarted after VS Code restart (phase: ${delivery.phase}).`
    }, { replace: true });

    outputChannel.appendLine(
      `[Recovery] Restarted delivery for ${issueKey} in ${delivery.phase} phase using ${getAgentDisplayName(provider)}.`
    );
  }

  async function finalizeDeliverySession(record: AgentSessionRecord): Promise<void> {
    if (!isDeliveryTask(record) || record.delivery.finalizationState !== 'pending') {
      return;
    }
    const delivery = record.delivery;
    if (deliveryFinalizationInFlight.has(record.issueKey)) {
      return;
    }

    deliveryFinalizationInFlight.add(record.issueKey);
    try {
      if (record.state === 'completed') {
          if (delivery.phase === 'merge-request-feedback') {
            const mergeRequest = delivery.mergeRequest;
          if (!mergeRequest) {
              throw new Error('The AI agent completed a merge request feedback task but no merge request metadata is attached to the delivery session.');
          }

          const feedbackResult = parseMergeRequestFeedbackResult(record.responseText);
          if (!feedbackResult) {
            throw new Error(
                'The AI agent completed the merge request feedback task but did not return a valid MERGE_REQUEST_FEEDBACK_RESULT payload.'
            );
          }

          const gitLabAutomation = await resolveGitLabAutomation();
          if (!gitLabAutomation) {
            throw new Error('GitLab MR automation is not configured, so the feedback reply could not be posted.');
          }

          const replyBody = wrapTicketManagerManagedMergeRequestNote(buildMergeRequestReplyComment(feedbackResult));
          const triggeringDiscussionIds = [
            ...new Set(
              (mergeRequest.pendingFeedback?.notes ?? [])
                .map(note => note.discussionId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
            )
          ];
          if (triggeringDiscussionIds.length === 1) {
            try {
              await gitLabAutomation.client.replyToMergeRequestDiscussion(
                mergeRequest.iid,
                triggeringDiscussionIds[0],
                replyBody
              );
            } catch {
              await gitLabAutomation.client.addMergeRequestNote(mergeRequest.iid, replyBody);
            }
          } else {
            await gitLabAutomation.client.addMergeRequestNote(mergeRequest.iid, replyBody);
          }
          aiSessionManager.updateAgentDelivery(record.issueKey, {
            ...delivery,
            phase: 'implementation',
            finalizationState: 'completed',
            finalizationMessage: 'Posted a merge request reply after processing review feedback.',
            mergeRequest: {
              ...mergeRequest,
              pendingFeedback: undefined,
              buildRequiredOnMerge: mergeRequest.buildRequiredOnMerge || feedbackResult.didEditCode
            }
          }, { replace: true });
          outputChannel.appendLine(`[GitLab MR] Posted automated merge request reply for ${record.issueKey}.`);
          return;
        }

        if (delivery.phase === 'analysis') {
          const analysisResult = parseDeliveryAnalysisResult(record.responseText);
          if (!analysisResult) {
            throw new Error(
              'The AI agent completed the delivery analysis session but did not return a valid DELIVERY_ANALYSIS_RESULT payload.'
            );
          }

          if (analysisResult.status === 'blocked') {
            await backendService.addComment(
              record.issueKey,
              buildDeliveryAnalysisBlockedComment(analysisResult)
            );
            aiSessionManager.updateAgentDelivery(record.issueKey, {
              finalizationState: 'failed',
              finalizationMessage: analysisResult.summary,
              analysisSummary: analysisResult.summary,
              analysisPlan: undefined
            });
            outputChannel.appendLine(`[Delivery] Delivery analysis blocked ${record.issueKey}.`);
            return;
          }

          await backendService.addComment(
            record.issueKey,
            buildPollingAnalysisReadyComment()
          );
          const refreshedIssue = await backendService.getIssue(record.issueKey);
          await startFreshDeliveryImplementationSession(refreshedIssue, record, analysisResult);
          outputChannel.appendLine(
            `[Delivery] Started fresh implementation session for ${record.issueKey} after delivery analysis.`
          );
          return;
        }

        if (delivery.phase === 'feature-decomposition') {
          await finalizeFeatureDecomposition(record);
          return;
        }

        const result = parseDeliveryTaskResult(record.responseText);
        if (!result) {
          throw new Error(
            'The AI agent completed the delivery task but did not return a valid DELIVERY_RESULT payload.'
          );
        }

        // Sub-task deliveries: skip publish/artifact upload, transition to Done.
        // Either auto-merge into feature branch or create MR, depending on config.
        if (delivery.parentFeatureIssueKey) {
          const currentIssue = await backendService.getIssue(record.issueKey);
          const autoMerge = configStore.isAutoMergeSubTasksEnabled();

          await backendService.addComment(
            record.issueKey,
            buildDeliverySuccessComment(result, {
              template: delivery.summaryTemplate,
              attachedArtifactNames: [],
              reporterMention: currentIssue.reporterMention,
              reporterName: currentIssue.reporter
            })
          );

          // Transition sub-task to Done
          let advancedStatus: string | undefined;
          try {
            const doneTransitionId = await findTransitionIdForStatus(record.issueKey, 'Done');
            if (doneTransitionId) {
              await backendService.transitionIssue(record.issueKey, doneTransitionId);
              advancedStatus = 'Done';
              outputChannel.appendLine(
                `[Feature Sub-task] Transitioned ${record.issueKey} to Done.`
              );
            } else {
              advancedStatus = await advanceDeliveredIssueToNextStatus(record.issueKey);
            }
          } catch (transitionError) {
            reportError(transitionError, `subTaskDeliveryAdvance:${record.issueKey}`);
          }

          updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'completed');

          if (autoMerge) {
            // Auto-merge: merge sub-task branch into the feature branch directly
            try {
              // Build git auth args from GITLAB_TOKEN if available
              const gitExtraArgs: string[] = [];
              const gitlabToken = process.env.GITLAB_TOKEN;
              if (gitlabToken) {
                const auth = Buffer.from(`oauth2:${gitlabToken}`).toString('base64');
                gitExtraArgs.push('-c', `http.extraHeader=Authorization: Basic ${auth}`);
              }

              const mergeResult = await gitWorktreeManager!.mergeSubTaskBranch(
                workingDirectory!,
                delivery.createdBranch,
                delivery.baseBranch,
                delivery.worktreePath,
                { gitExtraArgs }
              );
              outputChannel.appendLine(
                `[Feature Sub-task] Auto-merged ${record.issueKey} into ${delivery.baseBranch} (commit: ${mergeResult.mergeCommit.slice(0, 8)}).`
              );

              aiSessionManager.updateAgentDelivery(record.issueKey, {
                finalizationState: 'completed',
                finalizationMessage: advancedStatus
                  ? `Posted summary, moved to ${advancedStatus}, and auto-merged into ${delivery.baseBranch}.`
                  : `Posted summary and auto-merged into ${delivery.baseBranch}.`,
                result
              });

              // Immediately advance to the next sub-task
              await advanceToNextSubTask(delivery.parentFeatureIssueKey);
            } catch (mergeError) {
              reportError(mergeError, `subTaskAutoMerge:${record.issueKey}`);
              outputChannel.appendLine(
                `[Feature Sub-task] Auto-merge failed for ${record.issueKey}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}. Falling back to MR.`
              );
              // Fallback: create MR if auto-merge fails (e.g. merge conflict)
              try {
                await ensureMergeRequestForDoneIssue(record.issueKey);
              } catch (mrError) {
                reportError(mrError, `subTaskMergeRequestFallback:${record.issueKey}`);
              }
              aiSessionManager.updateAgentDelivery(record.issueKey, {
                finalizationState: 'completed',
                finalizationMessage: `Auto-merge failed. Created merge request instead. Next sub-task starts after MR merge.`,
                result
              });
            }
          } else {
            // MR mode: create MR targeting the feature branch, wait for merge
            try {
              await ensureMergeRequestForDoneIssue(record.issueKey);
              outputChannel.appendLine(
                `[Feature Sub-task] Created/ensured MR for sub-task ${record.issueKey}. Next sub-task will start when this MR is merged.`
              );
            } catch (mrError) {
              reportError(mrError, `subTaskMergeRequest:${record.issueKey}`);
            }

            aiSessionManager.updateAgentDelivery(record.issueKey, {
              finalizationState: 'completed',
              finalizationMessage: advancedStatus
                ? `Posted summary, moved to ${advancedStatus}, and created merge request. Next sub-task starts after MR merge.`
                : 'Posted summary and created merge request. Next sub-task starts after MR merge.',
              result
            });
          }

          outputChannel.appendLine(`[Feature Sub-task] Finalized sub-task delivery for ${record.issueKey}.`);
          return;
        }

        const attachedArtifactNames: string[] = [];
        const seenArtifactPaths = new Set<string>();
        for (const [artifactIndex, artifactPath] of result.artifactPaths.entries()) {
          const resolvedArtifactPath = path.isAbsolute(artifactPath)
            ? artifactPath
            : path.resolve(delivery.worktreePath, artifactPath);
          const normalizedArtifactPath = path.normalize(resolvedArtifactPath).toLowerCase();
          if (seenArtifactPaths.has(normalizedArtifactPath)) {
            outputChannel.appendLine(
              `[Delivery] Skipping duplicate artifact path for ${record.issueKey}: ${artifactPath}`
            );
            continue;
          }
          seenArtifactPaths.add(normalizedArtifactPath);
          const preparedUpload = await prepareArtifactForJiraUpload(resolvedArtifactPath, {
            issueKey: record.issueKey,
            buildIdentifier: result.buildIdentifier,
            artifactIndex
          });
          try {
            await backendService.attachFile(
              record.issueKey,
              preparedUpload.uploadPath,
              preparedUpload.attachmentName
            );
            attachedArtifactNames.push(preparedUpload.attachmentName);
          } finally {
            await preparedUpload.cleanup?.();
          }
        }

        const currentIssue = await backendService.getIssue(record.issueKey);

        await backendService.addComment(
          record.issueKey,
          buildDeliverySuccessComment(result, {
            template: delivery.summaryTemplate,
            attachedArtifactNames,
            reporterMention: currentIssue.reporterMention,
            reporterName: currentIssue.reporter
          })
        );

        let advancedStatus: string | undefined;
        try {
          advancedStatus = await advanceDeliveredIssueToNextStatus(record.issueKey);
          if (advancedStatus) {
            outputChannel.appendLine(
              `[Delivery] Advanced ${record.issueKey} to ${advancedStatus} after successful delivery finalization.`
            );
          }
        } catch (transitionError) {
          reportError(transitionError, `deliveryAdvance:${record.issueKey}`);
        }

        aiSessionManager.updateAgentDelivery(record.issueKey, {
          finalizationState: 'completed',
          finalizationMessage: advancedStatus
            ? `Attached delivery artifacts, posted summary comment, and moved the ticket to ${advancedStatus}.`
            : 'Attached delivery artifacts and posted summary comment.',
          result
        });
        outputChannel.appendLine(`[Delivery] Finalized Jira delivery workflow for ${record.issueKey}.`);
        return;
      }

      const failureReason =
        getLatestAgentFailureSummary(record) ??
        (delivery.phase === 'analysis'
          ? 'The AI delivery analysis stopped before it determined whether implementation could start.'
          : delivery.phase === 'merge-request-feedback'
            ? 'The AI agent stopped before it could process the latest merge request feedback.'
          : 'The AI delivery workflow stopped before it completed the implementation work.');
      if (delivery.phase === 'merge-request-feedback' && delivery.mergeRequest) {
        const gitLabAutomation = await resolveGitLabAutomation();
        if (gitLabAutomation) {
          await gitLabAutomation.client.addMergeRequestNote(
            delivery.mergeRequest.iid,
            wrapTicketManagerManagedMergeRequestNote(buildMergeRequestFailureReplyComment(failureReason))
          );
        }
      }
      await backendService.addComment(
        record.issueKey,
        buildDeliveryFailureComment(failureReason, {
          template: delivery.failureTemplate,
          branch: delivery.createdBranch,
          commitHash: delivery.result?.commitHash,
          pushedRef: delivery.result?.pushedRef
        })
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: failureReason
      });
      outputChannel.appendLine(`[Delivery] Posted Jira failure summary for ${record.issueKey}.`);

      // If this is a sub-task delivery, update parent state (do not advance — the
      // next sub-task only starts after MR merge, and failures halt the chain).
      if (delivery.parentFeatureIssueKey) {
        updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'failed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: message
      });
      if (delivery.phase === 'merge-request-feedback' && delivery.mergeRequest) {
        try {
          const gitLabAutomation = await resolveGitLabAutomation();
          if (gitLabAutomation) {
            await gitLabAutomation.client.addMergeRequestNote(
              delivery.mergeRequest.iid,
              wrapTicketManagerManagedMergeRequestNote(buildMergeRequestFailureReplyComment(message))
            );
          }
        } catch (mergeRequestCommentError) {
          reportError(mergeRequestCommentError, `gitlabMergeRequestReply:${record.issueKey}`);
        }
      }
      try {
        await backendService.addComment(
          record.issueKey,
          buildDeliveryFailureComment(message, {
            template: delivery.failureTemplate,
            branch: delivery.createdBranch,
            commitHash: delivery.result?.commitHash,
            pushedRef: delivery.result?.pushedRef
          })
        );
      } catch (commentError) {
        reportError(commentError, `deliveryFinalizeComment:${record.issueKey}`);
      }
      reportError(error, `deliveryFinalize:${record.issueKey}`);

      // If this is a sub-task delivery, update parent state.
      if (delivery.parentFeatureIssueKey) {
        updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'failed');
      }
    } finally {
      deliveryFinalizationInFlight.delete(record.issueKey);
    }
  }

  async function startPollingDeliveryWorkflow(
    issue: IssueDetails,
    options?: {
      preTransitionComment?: string;
      forceCleanWorktree?: boolean;
    }
  ): Promise<boolean> {
    const currentIssue = await backendService.getIssue(issue.key);
    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    const settingsErrors = validateDeliveryWorkflowSettings(deliverySettings);
    if (!workingDirectory || !gitWorktreeManager) {
      settingsErrors.push('Open the repository workspace before starting automatic delivery.');
    }
    if (settingsErrors.length > 0) {
      await backendService.addComment(
        issue.key,
        buildDeliveryFailureComment(
          `Implementation is ready, but the delivery workflow is not configured: ${settingsErrors.join(' ')}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }
    const deliveryWorkingDirectory = workingDirectory!;
    const deliveryWorktreeManager = gitWorktreeManager!;
    const issueWorkflowAssignment = aiSessionManager.getIssueWorkflowAssignment(currentIssue.key);
    const discoveredWorkflows = await discoverWorkspaceAgentWorkflows(deliveryWorkingDirectory);
    const assignedWorkflow = issueWorkflowAssignment?.workflow;
    if (!issueWorkflowAssignment) {
      // No choice has been recorded yet — ask the user. An assignment with
      // `workflow === undefined` is treated as an explicit "no workflow pack"
      // decision and allowed to proceed.
      await backendService.addComment(
        currentIssue.key,
        buildMissingWorkflowComment(
          discoveredWorkflows.map(workflow => `${workflow.name} (${workflow.id}) — ${workflow.instructionsPath}`)
        )
      );
      return false;
    }

    const baseBranch = extractDeliveryBaseBranch(currentIssue) ?? configStore.getDeliveryDefaultBaseBranch();
    if (!baseBranch) {
      await backendService.addComment(currentIssue.key, buildMissingBaseBranchClarificationComment());
      return false;
    }

    let issueAttachments;
    try {
      issueAttachments = await stageIssueAttachments({
        issue: currentIssue,
        backendService,
        logger: outputChannel
      });
    } catch (error) {
      await backendService.addComment(
        currentIssue.key,
        buildDeliveryFailureComment(
          `Implementation is blocked because issue attachments could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }

    const worktree = await deliveryWorktreeManager.prepareDeliveryWorktree(
      currentIssue,
      baseBranch,
      deliveryWorkingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );
    const scopedPublishCommand = resolveDeliveryPublishCommand(
      deliverySettings.publishCommand,
      worktree.worktreePath
    );

    if (options?.preTransitionComment?.trim()) {
      await backendService.addComment(currentIssue.key, options.preTransitionComment.trim());
    }

    const transitionId = await findTransitionIdForStatus(currentIssue.key, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(currentIssue.key, transitionId);
    }

    const taskDefinition = buildDeliveryAnalysisTaskDefinition(currentIssue, {
      baseBranch,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      publishCommand: scopedPublishCommand,
      artifactPattern: deliverySettings.artifactPattern,
      workflow: assignedWorkflow
    });
    const taskDefinitionWithAttachments = issueAttachments.length > 0
      ? { ...taskDefinition, attachments: issueAttachments }
      : taskDefinition;

    const provider = await startAgentTask(
      {
        ...currentIssue,
        branch: worktree.branchName
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(currentIssue.key, undefined, currentIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        source: 'jira-polling',
        phase: 'analysis',
        baseBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: scopedPublishCommand,
        artifactPattern: deliverySettings.artifactPattern,
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending'
      },
      { replace: true }
    );
    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Delivery] Started Jira delivery workflow for ${currentIssue.key} from base branch ${baseBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  /**
   * Start the feature decomposition workflow for a feature request ticket.
   * Creates a worktree, runs the decomposition agent, creates sub-tasks in Jira,
   * and sets up the feature branch structure.
   */
  async function startFeatureDecompositionWorkflow(
    issue: IssueDetails,
    options?: { forceCleanWorktree?: boolean }
  ): Promise<boolean> {
    const currentIssue = await backendService.getIssue(issue.key);
    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    const settingsErrors = validateDeliveryWorkflowSettings(deliverySettings);
    if (!workingDirectory || !gitWorktreeManager) {
      settingsErrors.push('Open the repository workspace before starting feature decomposition.');
    }
    if (settingsErrors.length > 0) {
      await backendService.addComment(
        issue.key,
        buildDeliveryFailureComment(
          `Feature decomposition is blocked: ${settingsErrors.join(' ')}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }
    const deliveryWorkingDirectory = workingDirectory!;
    const deliveryWorktreeManager = gitWorktreeManager!;

    const baseBranch = extractDeliveryBaseBranch(currentIssue) ?? configStore.getDeliveryDefaultBaseBranch();
    if (!baseBranch) {
      await backendService.addComment(currentIssue.key, buildMissingBaseBranchClarificationComment());
      return false;
    }

    let issueAttachments: Awaited<ReturnType<typeof stageIssueAttachments>> | undefined;
    try {
      issueAttachments = await stageIssueAttachments({
        issue: currentIssue,
        backendService,
        logger: outputChannel
      });
    } catch (error) {
      outputChannel.appendLine(
        `[Feature Decomposition] Warning: could not stage attachments for ${currentIssue.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const worktree = await deliveryWorktreeManager.prepareDeliveryWorktree(
      currentIssue,
      baseBranch,
      deliveryWorkingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );

    const availableWorkflows = await discoverWorkspaceAgentWorkflows(deliveryWorkingDirectory);
    const assignedWorkflow = aiSessionManager.getIssueWorkflowAssignment(currentIssue.key)?.workflow;

    const scopedPublishCommand = resolveDeliveryPublishCommand(
      deliverySettings.publishCommand,
      worktree.worktreePath
    );

    const taskDefinition = buildFeatureDecompositionTaskDefinition(currentIssue, {
      baseBranch,
      worktreePath: worktree.worktreePath,
      availableWorkflows,
      workflow: assignedWorkflow
    });
    const taskDefinitionWithAttachments = issueAttachments?.length
      ? { ...taskDefinition, attachments: issueAttachments }
      : taskDefinition;

    const transitionId = await findTransitionIdForStatus(currentIssue.key, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(currentIssue.key, transitionId);
    }

    const provider = await startAgentTask(
      {
        ...currentIssue,
        branch: worktree.branchName
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(currentIssue.key, undefined, currentIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        source: 'jira-polling',
        phase: 'feature-decomposition',
        baseBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: scopedPublishCommand,
        artifactPattern: deliverySettings.artifactPattern,
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending'
      },
      { replace: true }
    );

    try {
      await backendService.addComment(
        issue.key,
        buildFeatureDecompositionStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch,
          worktreeName: worktree.worktreeName
        })
      );
    } catch (error) {
      reportError(error, `featureDecompositionStartComment:${issue.key}`);
    }

    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Feature Decomposition] Started decomposition workflow for ${currentIssue.key} from base branch ${baseBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  /**
   * Finalize a feature decomposition session: parse the result, create sub-tasks
   * in Jira, and set up the feature branch.
   */
  async function finalizeFeatureDecomposition(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const decompositionResult = parseFeatureDecompositionResult(record.responseText);
    if (!decompositionResult) {
      throw new Error(
        'The AI agent completed the feature decomposition session but did not return a valid FEATURE_DECOMPOSITION_RESULT payload.'
      );
    }

    if (decompositionResult.status === 'blocked') {
      await backendService.addComment(
        record.issueKey,
        buildFeatureDecompositionBlockedComment(decompositionResult)
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: decompositionResult.summary
      });
      outputChannel.appendLine(`[Feature Decomposition] Decomposition blocked for ${record.issueKey}.`);
      return;
    }

    // Create feature branch from base branch
    const featureBranch = decompositionResult.featureBranch;
    if (workingDirectory) {
      try {
        const { execFile: execFileCb } = require('node:child_process');
        const { promisify } = require('node:util');
        const execFileAsync = promisify(execFileCb);
        // Create the feature branch from the base branch
        await execFileAsync('git', ['branch', featureBranch, record.delivery.baseBranch], {
          cwd: workingDirectory,
          windowsHide: true
        });
        // Push the feature branch to origin
        const auth = process.env.GITLAB_TOKEN
          ? Buffer.from(`oauth2:${process.env.GITLAB_TOKEN}`).toString('base64')
          : undefined;
        const pushArgs = auth
          ? ['-c', `http.extraHeader=Authorization: Basic ${auth}`, 'push', '-u', 'origin', featureBranch]
          : ['push', '-u', 'origin', featureBranch];
        await execFileAsync('git', pushArgs, {
          cwd: workingDirectory,
          windowsHide: true
        });
        outputChannel.appendLine(`[Feature Decomposition] Created and pushed feature branch ${featureBranch} from ${record.delivery.baseBranch}.`);
      } catch (error) {
        outputChannel.appendLine(
          `[Feature Decomposition] Warning: could not create feature branch ${featureBranch}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Create sub-tasks in Jira
    const issue = await backendService.getIssue(record.issueKey);
    const subTaskRecords: FeatureSubTaskRecord[] = [];

    if (backendService.createSubTasks) {
      const createdKeys = await backendService.createSubTasks(
        record.issueKey,
        issue.projectKey,
        decompositionResult.subTasks.map(st => ({
          summary: st.summary,
          description: st.description,
          issueType: st.issueType
        }))
      );

      const availableWorkflows = await discoverWorkspaceAgentWorkflows(workingDirectory);

      for (const [index, key] of createdKeys.entries()) {
        const subTaskDef = decompositionResult.subTasks[index];
        const subTaskRecord: FeatureSubTaskRecord = {
          issueKey: key,
          summary: subTaskDef.summary,
          order: subTaskDef.order,
          deliveryState: 'pending'
        };

        // Auto-assign workflow if suggested
        if (subTaskDef.suggestedWorkflow) {
          const resolvedWorkflow = resolveWorkflowReference(subTaskDef.suggestedWorkflow, availableWorkflows);
          if (resolvedWorkflow) {
            aiSessionManager.setIssueWorkflowAssignment(key, resolvedWorkflow, {
              source: 'analysis',
              reason: `Suggested by feature decomposition of ${record.issueKey}.`
            });
            subTaskRecord.workflow = resolvedWorkflow;
          }
        }

        subTaskRecords.push(subTaskRecord);
      }
    }

    // Update delivery metadata with feature decomposition info
    aiSessionManager.updateAgentDelivery(record.issueKey, {
      finalizationState: 'completed',
      finalizationMessage: `Feature decomposed into ${subTaskRecords.length} sub-tasks on branch ${featureBranch}.`,
      featureDecomposition: {
        parentIssueKey: record.issueKey,
        featureBranch,
        baseBranch: record.delivery.baseBranch,
        subTasks: subTaskRecords,
        decompositionSummary: decompositionResult.summary
      }
    });

    // Add base branch info to each sub-task description in Jira
    for (const subTaskRecord of subTaskRecords) {
      try {
        await backendService.addComment(
          subTaskRecord.issueKey,
          `**Base branch:** ${featureBranch}\n\nThis sub-task is part of feature ${record.issueKey}. Changes should be merged into the feature branch \`${featureBranch}\`.`
        );
      } catch (error) {
        reportError(error, `featureSubTaskComment:${subTaskRecord.issueKey}`);
      }
    }

    await backendService.addComment(
      record.issueKey,
      buildFeatureDecompositionCompleteComment(decompositionResult)
    );

    outputChannel.appendLine(
      `[Feature Decomposition] Created ${subTaskRecords.length} sub-tasks for ${record.issueKey} on feature branch ${featureBranch}.`
    );

    // Automatically start the first sub-task
    await advanceToNextSubTask(record.issueKey);
  }

  /**
   * Update a sub-task's deliveryState in the parent's feature decomposition metadata.
   */
  function updateParentSubTaskState(
    parentIssueKey: string,
    subTaskKey: string,
    state: 'pending' | 'in-progress' | 'completed' | 'failed'
  ): void {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      return;
    }
    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const updatedSubTasks = featureDecomp.subTasks.map(st =>
      st.issueKey === subTaskKey ? { ...st, deliveryState: state } : st
    );
    aiSessionManager.updateAgentDelivery(parentIssueKey, {
      featureDecomposition: { ...featureDecomp, subTasks: updatedSubTasks }
    });
  }

  /**
   * Find and start the next pending sub-task in a feature decomposition.
   * Called after the decomposition finishes and after each sub-task delivery
   * completes (success or failure) to automatically chain execution.
   */
  async function advanceToNextSubTask(parentIssueKey: string): Promise<void> {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      return;
    }

    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const nextPending = featureDecomp.subTasks
      .sort((a, b) => a.order - b.order)
      .find(st => st.deliveryState === 'pending');

    if (!nextPending) {
      const allCompleted = featureDecomp.subTasks.every(st => st.deliveryState === 'completed');
      if (allCompleted) {
        outputChannel.appendLine(
          `[Feature Decomposition] All sub-tasks for ${parentIssueKey} have been completed.`
        );

        // Create MR from feature branch to base branch
        let mrUrl: string | undefined;
        try {
          const gitLabAutomation = await resolveGitLabAutomation();
          if (gitLabAutomation) {
            const parentIssue = await backendService.getIssue(parentIssueKey);
            const existingMRs = await gitLabAutomation.client.listMergeRequestsForSourceBranch(featureDecomp.featureBranch);
            let featureMR = existingMRs.find(mr => mr.sourceBranch === featureDecomp.featureBranch && mr.state === 'opened');
            if (!featureMR) {
              featureMR = await gitLabAutomation.client.createMergeRequest({
                sourceBranch: featureDecomp.featureBranch,
                targetBranch: featureDecomp.baseBranch,
                title: `${parentIssueKey}: ${parentIssue.summary}`,
                description: [
                  `Implements ${parentIssueKey}: ${parentIssue.summary}`,
                  '',
                  `This feature was decomposed into ${featureDecomp.subTasks.length} sub-tasks:`,
                  ...featureDecomp.subTasks.map(st => `- ${st.issueKey}: ${st.summary}`),
                  '',
                  `Feature branch: \`${featureDecomp.featureBranch}\``,
                  `Target branch: \`${featureDecomp.baseBranch}\``
                ].join('\n'),
                removeSourceBranch: true
              });
              outputChannel.appendLine(
                `[Feature Decomposition] Created MR !${featureMR.iid} from ${featureDecomp.featureBranch} to ${featureDecomp.baseBranch}.`
              );
            }
            mrUrl = featureMR.webUrl;

            // Store MR metadata on the parent delivery record
            aiSessionManager.updateAgentDelivery(parentIssueKey, {
              mergeRequest: {
                iid: featureMR.iid,
                webUrl: featureMR.webUrl,
                title: featureMR.title,
                sourceBranch: featureMR.sourceBranch,
                targetBranch: featureMR.targetBranch,
                state: featureMR.state
              }
            });
          }
        } catch (error) {
          reportError(error, `featureBranchMR:${parentIssueKey}`);
        }

        try {
          const mrLine = mrUrl ? `\n\nMerge request: ${mrUrl}` : '';
          await backendService.addComment(
            parentIssueKey,
            `All ${featureDecomp.subTasks.length} sub-tasks have been completed. The feature branch \`${featureDecomp.featureBranch}\` is ready for final review and merge into \`${featureDecomp.baseBranch}\`.${mrLine}`
          );
        } catch (error) {
          reportError(error, `featureAllSubTasksComplete:${parentIssueKey}`);
        }
      } else {
        const summary = featureDecomp.subTasks.reduce(
          (acc, st) => { acc[st.deliveryState ?? 'pending'] = (acc[st.deliveryState ?? 'pending'] ?? 0) + 1; return acc; },
          {} as Record<string, number>
        );
        outputChannel.appendLine(
          `[Feature Decomposition] No more pending sub-tasks for ${parentIssueKey}. Status: ${JSON.stringify(summary)}`
        );
      }
      return;
    }

    outputChannel.appendLine(
      `[Feature Decomposition] Advancing to next sub-task ${nextPending.issueKey} (order: ${nextPending.order}) for ${parentIssueKey}.`
    );

    try {
      await startSubTaskDelivery(parentIssueKey, nextPending.issueKey);
    } catch (error) {
      if (error instanceof WorktreeConflictError) {
        outputChannel.appendLine(
          `[Feature Decomposition] Worktree conflict for sub-task ${nextPending.issueKey}: ${error.worktreeName} already exists. Posting clarification comment.`
        );
        await backendService.addComment(
          parentIssueKey,
          buildWorktreeConflictClarificationComment(error.worktreeName)
        );
        return;
      }
      reportError(error, `advanceSubTask:${nextPending.issueKey}`);
      outputChannel.appendLine(
        `[Feature Decomposition] Failed to start sub-task ${nextPending.issueKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Start the delivery workflow for a specific sub-task of a feature request.
   * The sub-task worktree branches off the feature branch, and the MR targets
   * the feature branch.
   */
  async function startSubTaskDelivery(
    parentIssueKey: string,
    subTaskKey: string,
    options?: { forceCleanWorktree?: boolean }
  ): Promise<boolean> {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      throw new Error(`No feature decomposition found for ${parentIssueKey}.`);
    }

    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const subTaskRecord = featureDecomp.subTasks.find(st => st.issueKey === subTaskKey);
    if (!subTaskRecord) {
      throw new Error(`Sub-task ${subTaskKey} not found in feature decomposition of ${parentIssueKey}.`);
    }

    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    if (!workingDirectory || !gitWorktreeManager) {
      throw new Error('Open the repository workspace before starting sub-task delivery.');
    }

    const subTaskIssue = await backendService.getIssue(subTaskKey);

    // The sub-task branches off the feature branch, not the base branch
    const featureBranch = featureDecomp.featureBranch;
    const worktree = await gitWorktreeManager.prepareDeliveryWorktree(
      subTaskIssue,
      featureBranch,
      workingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );

    const workflow = aiSessionManager.getIssueWorkflowAssignment(subTaskKey)?.workflow ?? subTaskRecord.workflow;
    const taskDefinition = buildSubTaskAnalysisTaskDefinition(subTaskIssue, {
      baseBranch: featureBranch,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      workflow
    });

    // Transition sub-task to In Progress
    const transitionId = await findTransitionIdForStatus(subTaskKey, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(subTaskKey, transitionId);
    }

    const provider = await startAgentTask(
      {
        ...subTaskIssue,
        branch: worktree.branchName
      },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(subTaskKey, undefined, subTaskIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      subTaskKey,
      {
        source: 'jira-polling',
        phase: 'analysis',
        baseBranch: featureBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: '',
        artifactPattern: '',
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending',
        parentFeatureIssueKey: parentIssueKey
      },
      { replace: true }
    );

    // Update the parent's feature decomposition record
    const updatedSubTasks = featureDecomp.subTasks.map(st =>
      st.issueKey === subTaskKey
        ? { ...st, deliveryState: 'in-progress' as const, worktreeBranch: worktree.branchName }
        : st
    );
    aiSessionManager.updateAgentDelivery(parentIssueKey, {
      featureDecomposition: {
        ...featureDecomp,
        subTasks: updatedSubTasks
      }
    });

    try {
      await backendService.addComment(
        subTaskKey,
        buildDeliveryStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch: featureBranch,
          branchName: worktree.branchName,
          worktreeName: worktree.worktreeName,
          workflow
        })
      );
    } catch (error) {
      reportError(error, `subTaskDeliveryStartComment:${subTaskKey}`);
    }

    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Feature Sub-task] Started delivery workflow for sub-task ${subTaskKey} (parent: ${parentIssueKey}) from feature branch ${featureBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  async function processPollingClarificationRequests(event: {
    newKeys: string[];
    changedKeys: string[];
    eligibleIssueKeys: string[];
  }): Promise<void> {
    const candidateKeys = [...new Set([...event.newKeys, ...event.changedKeys])].filter(issueKey =>
      event.eligibleIssueKeys.includes(issueKey)
    );

    if (candidateKeys.length === 0) {
      return;
    }

    if (!isCopilotSdkConfigured() && !isClaudeSdkConfigured()) {
      outputChannel.appendLine(
        '[Jira Polling] Clarification comments skipped because neither GitHub Copilot SDK nor Claude Code CLI is configured.'
      );
      return;
    }

    const clarificationEnabled = configStore.isJiraPollingClarificationAnalysisEnabled();
    const cliPath = getCopilotCliPathOverride();
    const availableWorkflows = await discoverWorkspaceAgentWorkflows(workingDirectory);

    for (const issueKey of candidateKeys) {
      if (pollingClarificationInFlight.has(issueKey) || hasActiveAgentTask(issueKey)) {
        continue;
      }

      pollingClarificationInFlight.add(issueKey);
      try {
        const issue = await backendService.getIssue(issueKey);
        const analysisSignature = buildPollingAnalysisSignature(issue);

        if (!clarificationEnabled) {
          // Clarification analysis is disabled — proceed directly to delivery
          // with whatever information the ticket provides.
          if (hasAnyAnalysisLifecycleComment(issue) && !hasPendingAiBotTrigger(issue)) {
            await setHandledPollingAnalysis(issueKey, analysisSignature);
            continue;
          }
          if (handledPollingAnalyses[issueKey] === analysisSignature) {
            continue;
          }

          // Try to extract workflow reference from the ticket description/comments
          const ticketText = [issue.description ?? '', ...(issue.comments?.map(c => c.body) ?? [])].join('\n');
          ensureWorkflowAssignedFromAnalysis(issueKey, ticketText, availableWorkflows);

          outputChannel.appendLine(
            `[Jira Polling] Clarification analysis disabled — proceeding directly to delivery for ${issueKey}.`
          );
          await handlePollingAnalysisReady(issue, { analysisSignature });
          continue;
        }

        if (hasCopilotClarificationComment(issue)) {
          continue;
        }
        // Hard gate: once any analysis lifecycle comment exists on the ticket
        // (start, ready, clarification, or other Copilot reply), never re-run
        // analysis unless the user has explicitly pinged the bot with an
        // #AIbot-prefixed comment posted after the last bot comment. This is
        // immune to state-cache drift and version upgrades.
        if (hasAnyAnalysisLifecycleComment(issue) && !hasPendingAiBotTrigger(issue)) {
          outputChannel.appendLine(
            `[Jira Polling] Skipping re-analysis on ${issueKey}: no pending #AIbot trigger since last bot activity.`
          );
          await setHandledPollingAnalysis(issueKey, analysisSignature);
          continue;
        }
        if (handledPollingAnalyses[issueKey] === analysisSignature) {
          continue;
        }

        if (!hasCopilotAnalysisStartComment(issue)) {
          await backendService.addComment(issueKey, COPILOT_ANALYSIS_START_COMMENT);
        }

        let stagedAttachments;
        try {
          stagedAttachments = await stageIssueAttachments({
            issue,
            backendService,
            logger: outputChannel
          });
        } catch (error) {
          outputChannel.appendLine(
            `[Jira Polling] Warning: could not stage attachments for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const readinessAssessment = await assessCopilotImplementationReadiness(
          issue,
          cliPath,
          {
            workingDirectory,
            availableWorkflows,
            assignedWorkflow: aiSessionManager.getIssueWorkflowAssignment(issueKey)?.workflow,
            stagedAttachments
          }
        );
        if (readinessAssessment.status === 'ready') {
          ensureWorkflowAssignedFromAnalysis(
            issueKey,
            readinessAssessment.workflowReference,
            availableWorkflows
          );

          await handlePollingAnalysisReady(issue, {
            analysisSignature
          });
          continue;
        }

        if (!readinessAssessment.clarificationComment) {
          outputChannel.appendLine(
            `[Jira Polling] Readiness assessment on ${issueKey} returned needs_clarification without a comment body — skipping.`
          );
          await setHandledPollingAnalysis(issueKey, analysisSignature);
          continue;
        }
        await backendService.addComment(
          issueKey,
          formatPollingClarificationComment(readinessAssessment.clarificationComment)
        );
        await setHandledPollingAnalysis(issueKey, analysisSignature);
        outputChannel.appendLine(
          `[Jira Polling] Posted Copilot clarification request on ${issueKey}.`
        );
      } catch (error) {
        reportError(error, `pollingClarification:${issueKey}`);
      } finally {
        pollingClarificationInFlight.delete(issueKey);
      }
    }
  }

  async function processPollingClarificationReplies(event: {
    newKeys: string[];
    changedKeys: string[];
    eligibleIssueKeys: string[];
  }): Promise<void> {
    // Reply processing uses ALL changed/new keys — not just eligible ones.
    // The status-based eligibility gate is only for initial analysis triggers.
    // For replies, the explicit #AIbot prefix is the gating mechanism, and
    // tickets may have transitioned away from RequiredStatus during delivery.
    const candidateKeys = [...new Set([...event.newKeys, ...event.changedKeys])];

    if (candidateKeys.length === 0) {
      return;
    }

    if (!isCopilotSdkConfigured() && !isClaudeSdkConfigured()) {
      outputChannel.appendLine(
        '[Jira Polling] Clarification reply handling skipped because neither GitHub Copilot SDK nor Claude Code CLI is configured.'
      );
      return;
    }

    const clarificationEnabled = configStore.isJiraPollingClarificationAnalysisEnabled();
    const availableWorkflows = await discoverWorkspaceAgentWorkflows(workingDirectory);

    for (const issueKey of candidateKeys) {
      if (pollingReplyInFlight.has(issueKey) || hasActiveAgentTask(issueKey)) {
        continue;
      }

      pollingReplyInFlight.add(issueKey);
      try {
        const issue = await backendService.getIssue(issueKey);
        const latestCopilotSignature = getLatestCopilotCommentSignature(issue);
        // Primary #AIbot gate: if there is no #AIbot-prefixed comment posted
        // after the last bot activity, do absolutely nothing. No analysis,
        // no comments, no delivery. This is the single most important rule
        // for polling-triggered work.
        if (!hasPendingAiBotTrigger(issue)) {
          outputChannel.appendLine(
            `[Jira Polling] Skipping reply handling on ${issueKey}: no pending #AIbot trigger comment after last bot activity.`
          );
          continue;
        }
        const replyRequest = extractPendingCopilotReplyRequest(issue);
        if (!replyRequest) {
          outputChannel.appendLine(
            `[Jira Polling] Skipping reply handling on ${issueKey}: #AIbot trigger present but no extractable reply body.`
          );
          continue;
        }
        if (latestCopilotSignature && handledPollingReplies[issueKey] === latestCopilotSignature) {
          outputChannel.appendLine(
            `[Jira Polling] Skipping reply handling on ${issueKey}: already handled the current Copilot comment signature.`
          );
          continue;
        }
        outputChannel.appendLine(
          `[Jira Polling] Processing #AIbot reply on ${issueKey}: ${replyRequest.slice(0, 120)}`
        );

        // Check if this is a reply to a worktree conflict clarification
        const hasWorktreeConflict = issue.comments?.some(c => c.body.includes(WORKTREE_CONFLICT_COMMENT_MARKER)) ?? false;
        if (hasWorktreeConflict) {
          const normalizedReply = replyRequest.trim().toLowerCase();
          if (normalizedReply.includes('delete') || normalizedReply.includes('start fresh') || normalizedReply.includes('start over') || normalizedReply.includes('clean')) {
            outputChannel.appendLine(
              `[Jira Polling] Worktree conflict resolved for ${issueKey}: user chose to delete and start fresh.`
            );
            const ticketText = [issue.description ?? '', ...(issue.comments?.map(c => c.body) ?? [])].join('\n');
            ensureWorkflowAssignedFromAnalysis(issueKey, ticketText, availableWorkflows);
            await handlePollingAnalysisReady(issue, {
              replySignature: latestCopilotSignature,
              forceCleanWorktree: true
            });
            continue;
          }
          if (normalizedReply.includes('reuse') || normalizedReply.includes('continue') || normalizedReply.includes('keep')) {
            outputChannel.appendLine(
              `[Jira Polling] Worktree conflict resolved for ${issueKey}: user chose to reuse existing worktree. Manual intervention needed.`
            );
            await backendService.addComment(
              issueKey,
              `${AI_COMMENT_HEADER}\nUnderstood — keeping the existing worktree. Please start the delivery manually from the Ticket Manager task details view, or transition the ticket back to "To Do" and reply with \`#AIbot delete\` to start fresh.`
            );
            if (latestCopilotSignature) {
              await setHandledPollingReply(issueKey, latestCopilotSignature);
            }
            continue;
          }
        }

        if (!clarificationEnabled) {
          // Clarification analysis is disabled — treat #AIbot replies as
          // a direct instruction to proceed with delivery.
          const ticketText = [issue.description ?? '', ...(issue.comments?.map(c => c.body) ?? [])].join('\n');
          ensureWorkflowAssignedFromAnalysis(issueKey, ticketText, availableWorkflows);

          outputChannel.appendLine(
            `[Jira Polling] Clarification analysis disabled — proceeding directly to delivery for ${issueKey} after #AIbot reply.`
          );
          await handlePollingAnalysisReady(issue, {
            replySignature: latestCopilotSignature
          });
          continue;
        }

        let replyStagedAttachments;
        try {
          replyStagedAttachments = await stageIssueAttachments({
            issue,
            backendService,
            logger: outputChannel
          });
        } catch (error) {
          outputChannel.appendLine(
            `[Jira Polling] Warning: could not stage attachments for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const readinessAssessment = await assessCopilotImplementationReadiness(
          issue,
          getCopilotCliPathOverride(),
          {
            workingDirectory,
            availableWorkflows,
            assignedWorkflow: aiSessionManager.getIssueWorkflowAssignment(issueKey)?.workflow,
            stagedAttachments: replyStagedAttachments
          }
        );
        if (readinessAssessment.status === 'needs_clarification') {
          if (!readinessAssessment.clarificationComment) {
            outputChannel.appendLine(
              `[Jira Polling] Readiness assessment on ${issueKey} returned needs_clarification without a comment body — skipping.`
            );
            if (latestCopilotSignature) {
              await setHandledPollingReply(issueKey, latestCopilotSignature);
            }
            continue;
          }
          await backendService.addComment(
            issueKey,
            formatPollingClarificationComment(readinessAssessment.clarificationComment)
          );
          if (latestCopilotSignature) {
            await setHandledPollingReply(issueKey, latestCopilotSignature);
          }
          outputChannel.appendLine(
            `[Jira Polling] Posted another Copilot clarification request on ${issueKey} after a user reply.`
          );
          continue;
        }

        ensureWorkflowAssignedFromAnalysis(
          issueKey,
          readinessAssessment.workflowReference,
          availableWorkflows
        );

        await handlePollingAnalysisReady(issue, {
          replySignature: latestCopilotSignature
        });
      } catch (error) {
        reportError(error, `pollingClarificationReply:${issueKey}`);
      } finally {
        pollingReplyInFlight.delete(issueKey);
      }
    }
  }

  async function postAgentInputRequestComment(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const { issueKey } = record;
    const lastInputEvent = [...record.events]
      .reverse()
      .find(event => event.type === 'user_input_requested');
    const question = lastInputEvent?.summary ?? 'The AI agent needs your input to continue.';
    const commentBody = [
      AI_COMMENT_HEADER,
      COPILOT_AGENT_INPUT_REQUEST_MARKER,
      '',
      question,
      '',
      'Reply with "#AIbot <your answer>" so the bot sees your response.'
    ].join('\n');

    try {
      await backendService.addComment(issueKey, commentBody);
      outputChannel.appendLine(
        `[Agent Input] Posted input request comment on ${issueKey}: ${question.slice(0, 120)}`
      );
    } catch (error) {
      reportError(error, `agentInputComment:${issueKey}`);
    }
  }

  async function processPollingAgentInputReplies(event: {
    newKeys: string[];
    changedKeys: string[];
  }): Promise<void> {
    const candidateKeys = [...new Set([...event.newKeys, ...event.changedKeys])];
    if (candidateKeys.length === 0) {
      return;
    }

    const awaitingInputKeys = new Set<string>();
    for (const [key, record] of aiSessionManager.getAllAgentSessions()) {
      if (record.state === 'awaiting_input' && hasActiveAgentTask(key)) {
        awaitingInputKeys.add(key);
      }
    }

    for (const issueKey of candidateKeys) {
      if (!awaitingInputKeys.has(issueKey)) {
        continue;
      }
      if (pollingAgentInputReplyInFlight.has(issueKey)) {
        continue;
      }

      pollingAgentInputReplyInFlight.add(issueKey);
      try {
        const issue = await backendService.getIssue(issueKey);
        if (!hasPendingAiBotTrigger(issue)) {
          continue;
        }
        const replyBody = extractPendingCopilotReplyRequest(issue);
        if (!replyBody) {
          continue;
        }
        outputChannel.appendLine(
          `[Agent Input] Routing #AIbot reply to awaiting agent on ${issueKey}: ${replyBody.slice(0, 120)}`
        );
        agentSessionController.respondToInput(issueKey, replyBody);
      } catch (error) {
        reportError(error, `pollingAgentInputReply:${issueKey}`);
      } finally {
        pollingAgentInputReplyInFlight.delete(issueKey);
      }
    }
  }

  async function revealActiveSessionsView(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      await vscode.commands.executeCommand('ticketManager.activeSessions.focus');
    } catch {
      // View focus can fail while the workbench is closing or not ready yet.
    }
  }

  function getLatestPermissionRequestSummary(issueKey: string): string | undefined {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      return undefined;
    }

    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      if (event.type === 'permission_requested') {
        return event.summary;
      }
    }
    return undefined;
  }

  function buildPermissionPromptSnapshot(issueKey: string): {
    signature?: string;
    detail?: string;
  } {
    const descriptions = copilotAgentService
      .getPendingPermissionDescriptions(issueKey)
      .filter(description => description.trim().length > 0);
    if (descriptions.length > 0) {
      const additionalCount = descriptions.length - 1;
      return {
        signature: descriptions.join('\n'),
        detail:
          additionalCount > 0
            ? `${descriptions[0]}\n\n${additionalCount} more queued request${additionalCount === 1 ? '' : 's'} pending.`
            : descriptions[0]
      };
    }

    const fallback = getLatestPermissionRequestSummary(issueKey);
    return fallback
      ? {
          signature: `fallback:${fallback}`,
          detail: fallback
        }
      : {};
  }

  async function openAiSession(issueKey: string): Promise<void> {
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    copilotSessionPanelManager.open(issueKey);
  }

  function clearPermissionPromptTracking(issueKey: string): void {
    permissionPromptSignatures.delete(issueKey);
    permissionPromptInFlight.delete(issueKey);
  }

  async function promptForPendingPermission(issueKey: string): Promise<void> {
    // Autopilot mode: Ticket Manager agents auto-approve every Copilot SDK
    // permission request, so a user-facing permission modal must never fire.
    // Kept as a no-op so legacy call sites compile without reintroducing the
    // prompt.
    clearPermissionPromptTracking(issueKey);
    return Promise.resolve();
  }

  function getCopilotCliPathOverride(options?: { showWarning?: boolean }): string | undefined {
    const { cliPath, warning } = resolveCopilotCliOverride(configStore.getAiCopilotCliPath());
    if (warning) {
      outputChannel.appendLine(`[Copilot SDK] ${warning}`);
      if (options?.showWarning) {
        void vscode.window.showWarningMessage(warning);
      }
    }
    return cliPath;
  }

  function getClaudeCliPathOverride(options?: { showWarning?: boolean }): string | undefined {
    const cliPath = configStore.getAiClaudeCliPath();
    if (cliPath) {
      return cliPath;
    }
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
  }

  type AgentRuntimeProvider = Extract<AiProvider, 'copilot-cli' | 'claude-cli'>;

  function isAgentRuntimeProvider(provider: AiProvider | undefined): provider is AgentRuntimeProvider {
    return provider === 'copilot-cli' || provider === 'claude-cli';
  }

  function isAgentRuntimeConfigured(provider: AgentRuntimeProvider): boolean {
    return provider === 'claude-cli' ? isClaudeSdkConfigured() : isCopilotSdkConfigured();
  }

  function resolvePreferredAgentProvider(
    issueKey: string,
    record?: AgentSessionRecord,
    issue?: Pick<IssueDetails, 'description' | 'comments'>
  ): AgentRuntimeProvider | undefined {
    const assignmentProvider = aiSessionManager.getSession(issueKey)?.provider;
    if (isAgentRuntimeProvider(assignmentProvider) && isAgentRuntimeConfigured(assignmentProvider)) {
      return assignmentProvider;
    }

    if (record?.provider && isAgentRuntimeConfigured(record.provider)) {
      return record.provider;
    }

    // Check if the Jira ticket specifies which agent to use
    if (issue) {
      const ticketDirective = extractAgentProviderDirective(issue);
      if (ticketDirective && isAgentRuntimeConfigured(ticketDirective)) {
        return ticketDirective;
      }
    }

    const defaultProvider = configStore.getAiDefaultProvider();
    if (defaultProvider !== 'none' && isAgentRuntimeProvider(defaultProvider) && isAgentRuntimeConfigured(defaultProvider)) {
      return defaultProvider;
    }

    if (isCopilotSdkConfigured()) {
      return 'copilot-cli';
    }
    if (isClaudeSdkConfigured()) {
      return 'claude-cli';
    }
    return undefined;
  }

  function getAgentDisplayName(provider: AgentRuntimeProvider): string {
    return provider === 'claude-cli' ? 'Claude Code' : 'GitHub Copilot';
  }

  function hasActiveAgentTask(issueKey: string): boolean {
    return copilotAgentService.hasActiveTask(issueKey) || claudeAgentService.hasActiveTask(issueKey);
  }

  function getActiveAgentTaskIssueKeys(): string[] {
    return [...new Set([
      ...copilotAgentService.getActiveTaskIssueKeys(),
      ...claudeAgentService.getActiveTaskIssueKeys()
    ])];
  }

  async function abortActiveAgentTask(issueKey: string): Promise<void> {
    if (claudeAgentService.hasActiveTask(issueKey)) {
      await claudeAgentService.abortTask(issueKey);
    }
    if (copilotAgentService.hasActiveTask(issueKey)) {
      await copilotAgentService.abortTask(issueKey);
    }
  }

  async function pauseAllAgentTasks(reason: string): Promise<void> {
    await Promise.all([
      copilotAgentService.pauseAllTasks(reason),
      claudeAgentService.pauseAllTasks(reason)
    ]);
  }

  async function startAgentTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options?: {
      provider?: AgentRuntimeProvider;
      workingDirectory?: string;
    }
  ): Promise<AgentRuntimeProvider> {
    const provider = options?.provider ?? resolvePreferredAgentProvider(issue.key, undefined, issue);
    if (!provider) {
      throw new Error('No CLI-backed AI agent is configured. Configure GitHub Copilot SDK or Claude Code CLI.');
    }

    if (provider === 'claude-cli') {
      await claudeAgentService.startTask(issue, taskDefinition, {
        cliPath: getClaudeCliPathOverride({ showWarning: true }),
        workingDirectory: options?.workingDirectory
      });
      return provider;
    }

    await copilotAgentService.startTask(issue, taskDefinition, {
      cliPath: getCopilotCliPathOverride({ showWarning: true }),
      workingDirectory: options?.workingDirectory
    });
    return provider;
  }

  async function resumeAgentTask(
    issueKey: string,
    record: AgentSessionRecord
  ): Promise<AgentRuntimeProvider> {
    const provider = resolvePreferredAgentProvider(issueKey, record);
    if (!provider) {
      throw new Error('No CLI-backed AI agent is configured. Configure GitHub Copilot SDK or Claude Code CLI.');
    }

    const workingDirectory = resolveAgentWorkingDirectory(record);
    if (provider === 'claude-cli') {
      await claudeAgentService.resumeTask(issueKey, {
        cliPath: getClaudeCliPathOverride({ showWarning: true }),
        workingDirectory
      });
      return provider;
    }

    await copilotAgentService.resumeTask(issueKey, {
      cliPath: getCopilotCliPathOverride({ showWarning: true }),
      workingDirectory
    });
    return provider;
  }

  async function resolveGitLabAutomation(): Promise<ResolvedGitLabAutomation | undefined> {
    let skipReason: string | undefined;

    if (!workingDirectory) {
      skipReason = 'GitLab MR automation skipped: open the repository workspace first.';
    } else if (configStore.getGitLabConnectionType() !== 'api') {
      skipReason = 'GitLab MR automation skipped: only direct GitLab API mode is supported for automated MR handling.';
    }

    if (skipReason) {
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    let inferredRemote;
    try {
      inferredRemote = await inferGitLabProjectFromRepo(workingDirectory!);
    } catch (error) {
      skipReason = `GitLab MR automation skipped: could not infer the GitLab project from origin: ${error instanceof Error ? error.message : String(error)}`;
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    const baseUrl = configStore.getGitLabUrl().trim() || inferredRemote.baseUrl;
    const token = configStore.getGitLabApiKey().trim() || process.env.GITLAB_TOKEN?.trim() || '';
    if (!token) {
      skipReason = 'GitLab MR automation skipped: configure ticketManager.gitlabApiKey or set GITLAB_TOKEN.';
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    const cacheKey = JSON.stringify({
      baseUrl,
      projectPath: inferredRemote.projectPath,
      tokenHash: createHash('sha1').update(token).digest('hex')
    });
    if (cachedGitLabAutomation && cachedGitLabAutomationKey === cacheKey) {
      return cachedGitLabAutomation;
    }

    cachedGitLabAutomation = {
      client: new GitLabApiService({
        baseUrl,
        projectPath: inferredRemote.projectPath,
        token
      }),
      baseUrl,
      projectPath: inferredRemote.projectPath
    };
    cachedGitLabAutomationKey = cacheKey;
    lastGitLabAutomationSkipReason = undefined;
    return cachedGitLabAutomation;
  }

  function mapMergeRequestMetadata(
    mergeRequest: GitLabMergeRequest,
    existing?: NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']>,
    handledNotes?: Record<string, string>,
    pendingFeedback?: NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']>['pendingFeedback']
  ): NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']> {
    return {
      iid: mergeRequest.iid,
      webUrl: mergeRequest.webUrl,
      title: mergeRequest.title,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      state: mergeRequest.state,
      createdAt: mergeRequest.createdAt,
      updatedAt: mergeRequest.updatedAt,
      mergeCommitSha: mergeRequest.mergeCommitSha,
      handledNotes: handledNotes ?? existing?.handledNotes,
      lastSeenAt: new Date().toISOString(),
      pendingFeedback,
      buildRequiredOnMerge: existing?.buildRequiredOnMerge ?? false
    };
  }

  async function ensureMergeRequestForDoneIssue(issueKey: string): Promise<void> {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!isDeliveryTask(record)) {
      return;
    }

    const sourceBranch = record.delivery.createdBranch.trim();
    if (!sourceBranch || record.delivery.mergeRequest?.iid) {
      return;
    }

    const gitLabAutomation = await resolveGitLabAutomation();
    if (!gitLabAutomation) {
      return;
    }

    const issue = await backendService.getIssue(issueKey);
    const existingMergeRequests = await gitLabAutomation.client.listMergeRequestsForSourceBranch(sourceBranch);
    let mergeRequest = existingMergeRequests.find(candidate => mergeRequestMatchesIssueKey(candidate, issue.key))
      ?? existingMergeRequests[0];
    let created = false;
    if (!mergeRequest) {
      mergeRequest = await gitLabAutomation.client.createMergeRequest({
        sourceBranch,
        targetBranch: record.delivery.baseBranch,
        title: `${issue.key}: ${issue.summary}`,
        description: buildMergeRequestDescription(issue, record),
        removeSourceBranch: true
      });
      created = true;
    }

    const notes = filterGitLabNotesForAutomation(
      await gitLabAutomation.client.listMergeRequestDiscussions(mergeRequest.iid)
    );

    aiSessionManager.updateAgentDelivery(issueKey, {
      mergeRequest: mapMergeRequestMetadata(
        mergeRequest,
        record.delivery.mergeRequest,
        createGitLabHandledNoteState(notes),
        record.delivery.mergeRequest?.pendingFeedback
      )
    });

    if (created) {
      await backendService.addComment(issueKey, buildMergeRequestCreatedComment(mergeRequest.webUrl));
      outputChannel.appendLine(`[GitLab MR] Created merge request !${mergeRequest.iid} for ${issueKey} on ${sourceBranch}.`);
    } else {
      outputChannel.appendLine(`[GitLab MR] Reusing merge request !${mergeRequest.iid} for ${issueKey} on ${sourceBranch}.`);
    }
  }

  async function startMergeRequestFeedbackSession(
    issue: IssueDetails,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    mergeRequest: GitLabMergeRequest,
    currentNotes: GitLabDiscussionNote[],
    changedNotes: GitLabDiscussionNote[]
  ): Promise<void> {
    const taskDefinition = buildMergeRequestFeedbackTaskDefinition(issue, {
      branchName: record.delivery.createdBranch,
      worktreePath: record.delivery.worktreePath,
      mergeRequestUrl: mergeRequest.webUrl,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      notes: changedNotes.map(note => ({
        author: note.author,
        body: note.body,
        updatedAt: note.updatedAt
      })),
      workflow: record.taskDefinition.workflow
    });

    await startAgentTask(
      {
        ...issue,
        branch: record.delivery.createdBranch
      },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(issue.key, record, issue),
        workingDirectory: record.delivery.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(issue.key, {
      ...record.delivery,
      phase: 'merge-request-feedback',
      finalizationState: 'pending',
      finalizationMessage: `Processing ${changedNotes.length} merge request comment(s).`,
      mergeRequest: mapMergeRequestMetadata(
        mergeRequest,
        record.delivery.mergeRequest,
        createGitLabHandledNoteState(currentNotes),
        {
          triggeredAt: new Date().toISOString(),
          notes: changedNotes.map(note => ({
            id: note.id,
            discussionId: note.discussionId,
            author: note.author,
            body: note.body,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt
          }))
        }
      )
    }, { replace: true });

    outputChannel.appendLine(
      `[GitLab MR] Started merge request feedback session for ${issue.key} covering ${changedNotes.length} note(s).`
    );
  }

  async function syncTrackedMergeRequest(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    gitLabAutomation: ResolvedGitLabAutomation
  ): Promise<void> {
    const mergeRequestState = record.delivery.mergeRequest;
    if (!mergeRequestState) {
      return;
    }

    const mergeRequest = await gitLabAutomation.client.getMergeRequest(mergeRequestState.iid);
    const notes = filterGitLabNotesForAutomation(
      await gitLabAutomation.client.listMergeRequestDiscussions(mergeRequest.iid)
    );
    const { newNotes, updatedNotes } = diffGitLabDiscussionNotes(
      mergeRequestState.handledNotes,
      notes,
      !mergeRequestState.lastSeenAt
    );

    if (mergeRequest.state !== 'opened') {
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          createGitLabHandledNoteState(notes),
          mergeRequestState.pendingFeedback
        )
      });

      // When a sub-task MR is merged, advance to the next sub-task.
      // Guard against re-triggering: only advance if we haven't already recorded the merge.
      if (
        mergeRequest.state === 'merged'
        && record.delivery.parentFeatureIssueKey
        && mergeRequestState.state !== 'merged'
      ) {
        outputChannel.appendLine(
          `[Feature Sub-task] MR !${mergeRequest.iid} for sub-task ${record.issueKey} has been merged. Advancing to next sub-task.`
        );
        try {
          await advanceToNextSubTask(record.delivery.parentFeatureIssueKey);
        } catch (advanceError) {
          reportError(advanceError, `advanceSubTaskAfterMerge:${record.issueKey}`);
        }
      }
      return;
    }

    if (newNotes.length === 0 && updatedNotes.length === 0) {
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          createGitLabHandledNoteState(notes),
          mergeRequestState.pendingFeedback
        )
      });
      return;
    }

    if (hasActiveAgentTask(record.issueKey) || record.delivery.finalizationState === 'pending') {
      outputChannel.appendLine(
        `[GitLab MR] Skipping feedback session for ${record.issueKey}: ${newNotes.length + updatedNotes.length} note(s) changed while a task is already active.`
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          mergeRequestState.handledNotes,
          mergeRequestState.pendingFeedback
        )
      });
      return;
    }

    outputChannel.appendLine(
      `[GitLab MR] Detected ${newNotes.length} new and ${updatedNotes.length} updated merge request note(s) for ${record.issueKey}.`
    );
    const issue = await backendService.getIssue(record.issueKey);
    await startMergeRequestFeedbackSession(issue, record, mergeRequest, notes, [...newNotes, ...updatedNotes]);
  }

  async function syncTrackedMergeRequests(): Promise<void> {
    const gitLabAutomation = await resolveGitLabAutomation();
    if (!gitLabAutomation) {
      return;
    }

    for (const record of aiSessionManager.getAllAgentSessions().values()) {
      if (!isDeliveryTask(record) || !record.delivery.mergeRequest?.iid) {
        continue;
      }
      if (mergeRequestAutomationInFlight.has(record.issueKey)) {
        continue;
      }

      mergeRequestAutomationInFlight.add(record.issueKey);
      try {
        await syncTrackedMergeRequest(record, gitLabAutomation);
      } catch (error) {
        reportError(error, `gitlabMergeRequestSync:${record.issueKey}`);
      } finally {
        mergeRequestAutomationInFlight.delete(record.issueKey);
      }
    }
  }

  async function processPollingMergeRequestAutomation(event: PollingSyncEvent): Promise<void> {
    const nextSnapshots = event.issues.reduce<Record<string, string>>((result, issue) => {
      result[issue.key] = formatStatusSnapshot(
        issue.fields?.status?.name,
        issue.fields?.status?.statusCategory?.name
      );
      return result;
    }, {});

    const transitionCandidates = [...new Set([...event.newKeys, ...event.changedKeys])];
    for (const issueKey of transitionCandidates) {
      const currentSnapshot = parseStatusSnapshot(nextSnapshots[issueKey]);
      const previousSnapshot = parseStatusSnapshot(pollingStatusSnapshots[issueKey]);
      if (!shouldCreateMergeRequestForStatusChange({
        previousStatus: previousSnapshot.status,
        currentStatus: currentSnapshot.status,
        currentStatusCategory: currentSnapshot.statusCategory
      })) {
        continue;
      }

      outputChannel.appendLine(
        `[GitLab MR] ${issueKey} transitioned from ${previousSnapshot.status ?? 'unknown'} to ${currentSnapshot.status ?? 'unknown'}; preparing merge request automation.`
      );
      try {
        await ensureMergeRequestForDoneIssue(issueKey);
      } catch (error) {
        reportError(error, `gitlabMergeRequestEnsure:${issueKey}`);
      }
    }

    await syncTrackedMergeRequests();
    await persistPollingStatusSnapshots(nextSnapshots);
  }

  // Set mode context early so when-clauses on views evaluate correctly
  // before VS Code tries to resolve them.
  // !ticketManager.configured is true when the key is false OR doesn't exist,
  // which means the setup view shows by default before activate() even runs.
  const getModeContextState = () =>
    resolveBackendModeContextState(
      configStore.getBackendMode(),
      configStore.hasJiraConnectionConfig(),
      configStore.hasJiraApiConfig()
    );
  const JIRA_API_SCOPE_MIGRATION_KEY = 'ticketManager.jiraApiEpicIssueScopeMigrated';
  const initialModeContext = getModeContextState();
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.mode',
    initialModeContext.mode ?? 'unconfigured'
  );
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.configured',
    initialModeContext.configured
  );

  const issuesProvider = new IssuesTreeProvider(backendService, filterStore, aiSessionManager);
  const boardsProvider = new BoardsTreeProvider(backendService, boardStore);
  const detailsProvider = new DetailsViewProvider(backendService);
  let issuesSidebarViewProvider: IssuesSidebarViewProvider;
  let epicsSidebarViewProvider: EpicsSidebarViewProvider;
  let boardsSidebarViewProvider: BoardsSidebarViewProvider;
  let issueDetailsSidebarViewProvider: IssueDetailsSidebarViewProvider;
  let activeSessionsSidebarViewProvider: ActiveSessionsSidebarViewProvider;
  let issueDetailPanelManager: IssueDetailPanelManager;
  const boardPanelManager = new BoardPanelManager(
    backendService,
    async issue => {
      await selectIssue(issue);
    },
    async () => {
      await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
      const active = detailsProvider.getActiveIssue();
      if (active) {
        const refreshedIssue = issuesProvider.getIssueByKey(active.key);
        await detailsProvider.setIssue(refreshedIssue ?? undefined);
      } else {
        await detailsProvider.refresh();
      }
      issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      await issueDetailPanelManager.refreshIfShowing(
        detailsProvider.getActiveIssue()?.key ?? ''
      );
    },
    boardColumnStore
  );
  issueDetailPanelManager = new IssueDetailPanelManager(backendService, aiSessionManager, async () => {
    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
    const active = detailsProvider.getActiveIssue();
    if (active) {
      const refreshedIssue = issuesProvider.getIssueByKey(active.key);
      await detailsProvider.setIssue(refreshedIssue ?? undefined);
    } else {
      await detailsProvider.refresh();
    }
    issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(detailsProvider.getActiveIssue()?.key ?? '');
  });
  updateCommentPlaceholders();

  const localPeerReviewPanel = new LocalPeerReviewPanel(async (issue) => {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error('No AI providers configured. Run Ticket Manager: Configure AI.');
    }
    let chosen = options[0];
    if (options.length > 1) {
      const picked = await vscode.window.showQuickPick(
        options.map(opt => ({ label: opt.label, description: opt.description, option: opt })),
        { title: `Run Local Peer Review with` }
      );
      if (!picked) {
        throw new Error('Review cancelled.');
      }
      chosen = picked.option;
    }
    return runLocalPeerReview(issue, {
      provider: chosen.provider,
      credential: chosen.credential,
      agentName: chosen.agentName ?? chosen.label,
      cliPath: getCopilotCliPathOverride(),
      workingDirectory
    });
  });

  context.subscriptions.push(
    outputChannel,
    filterStore,
    boardStore,
    backendService,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    issueDetailPanelManager,
    localPeerReviewPanel,
    boardColumnStore,
    boardColumnConfigPanel,
    newProjectWizardPanel,
    aiSessionManager.onDidChangeAgentSession(record => {
      if (
        isDeliveryTask(record) &&
        record.delivery.finalizationState === 'pending' &&
        (record.state === 'completed' || record.state === 'failed')
      ) {
        void finalizeDeliverySession(record);
      }

      if (record.state === 'awaiting_input' && isDeliveryTask(record)) {
        void postAgentInputRequestComment(record);
      }

      if (record.state === 'awaiting_approval' && copilotAgentService.hasActiveTask(record.issueKey)) {
        void promptForPendingPermission(record.issueKey);
        return;
      }

      clearPermissionPromptTracking(record.issueKey);
    }),
    vscode.window.onDidChangeWindowState(windowState => {
      if (windowState.focused) {
        return;
      }

      const activeIssueKeys = getActiveAgentTaskIssueKeys().sort((left, right) => left.localeCompare(right));
      if (activeIssueKeys.length === 0 || suppressCloseWarning) {
        if (activeIssueKeys.length === 0) {
          lastCloseWarningSignature = undefined;
        }
        return;
      }

      const signature = activeIssueKeys.join('|');
      if (signature === lastCloseWarningSignature) {
        return;
      }
      lastCloseWarningSignature = signature;

      const sessionSummary = activeIssueKeys.length === 1
        ? `${activeIssueKeys[0]} has an active AI session`
        : `${activeIssueKeys.length} active AI sessions are running`;
      void vscode.window.showWarningMessage(
        `${sessionSummary}. Closing VS Code will pause them so you can resume later.`,
        'Show Sessions',
        'Do Not Warn Again'
      ).then(selection => {
        if (selection === 'Show Sessions') {
          void revealActiveSessionsView();
        } else if (selection === 'Do Not Warn Again') {
          suppressCloseWarning = true;
        }
      });
    }),
    boardColumnStore.onDidChange(() => {
      boardPanelManager.refreshColumnLayout();
    })
  );

  async function revealIssueDetailsInSidebar(options: { focus: boolean }): Promise<void> {
    if (!detailsProvider.getActiveIssue()) {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      if (options.focus) {
        await vscode.commands.executeCommand('ticketManager.issueDetails.focus');
      }
    } catch {
      // focusing can fail if the view is not ready
    }
  }

  async function setModeContext(): Promise<void> {
    const modeContext = getModeContextState();
    await vscode.commands.executeCommand('setContext', 'ticketManager.mode', modeContext.mode ?? 'unconfigured');
    await vscode.commands.executeCommand('setContext', 'ticketManager.configured', modeContext.configured);
  }

  async function ensureJiraApiIssueScopeVisibility(modeContext: ReturnType<typeof getModeContextState>): Promise<void> {
    if (modeContext.mode !== 'jiraapi' || !modeContext.configured) {
      return;
    }

    if (configStore.getJiraApiEpicKey().trim().length === 0) {
      return;
    }

    if (context.workspaceState.get<boolean>(JIRA_API_SCOPE_MIGRATION_KEY) === true) {
      return;
    }

    const filters = filterStore.getFilters();
    if (!shouldAdoptJiraApiEpicIssueScope(filters)) {
      await context.workspaceState.update(JIRA_API_SCOPE_MIGRATION_KEY, true);
      return;
    }

    await filterStore.updateFilters({ assigneeMode: 'all' });
    await context.workspaceState.update(JIRA_API_SCOPE_MIGRATION_KEY, true);
  }

  async function refreshSearchActionContexts(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.issuesSearchActive',
        filterStore.getFilters().searchText.trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.epicsSearchActive',
        epicsSidebarViewProvider?.getSearchText().trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.boardsSearchActive',
        boardStore.getFilters().searchText.trim().length > 0
      )
    ]);
  }

  async function linkEpicToWorkspace(issueKey: string): Promise<void> {
    if (backendService.mode !== 'jiraapi') {
      void vscode.window.showWarningMessage('Epic linking from the Epics view is available in Jira API mode only.');
      return;
    }

    const currentLinkedEpicKey = configStore.getJiraApiEpicKey();
    if (currentLinkedEpicKey === issueKey) {
      void vscode.window.showInformationMessage(`${issueKey} is already linked to this workspace.`);
      return;
    }

    const confirmation = await vscode.window.showInformationMessage(
      `Do you want to link ${issueKey} to this repo?`,
      {
        modal: true,
        detail: 'This sets the workspace Jira API epic link. New Jira API issue creation will use this epic as the default parent.'
      },
      'Link Epic',
      'Cancel'
    );
    if (confirmation !== 'Link Epic') {
      return;
    }

    await configStore.setJiraApiEpicKey(issueKey);
    epicsSidebarViewProvider.setLinkedEpicKey(issueKey);
    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      epicsSidebarViewProvider.refresh()
    ]);
    await selectBoard(await resolveBoardById(`epic:${issueKey}`));
    await boardPanelManager.refresh();
    await ticketManagerStatusBar.refresh();
    void vscode.window.showInformationMessage(`Linked this repo to Jira epic ${issueKey}.`);
  }

  async function ensureFilePlanConfigured(interactive: boolean): Promise<boolean> {
    const configuredUri = await configStore.getResolvedPlanFileUri();
    if (configuredUri) {
      try {
        await vscode.workspace.fs.stat(configuredUri);
        return true;
      } catch {
        // fall through to discovery/prompt
      }
    }

    const planCandidates = await configStore.findWorkspacePlanCandidates();
    if (planCandidates.length === 1) {
      await configStore.setPlanFilePath(planCandidates[0].fsPath);
      return true;
    }

    if (planCandidates.length > 1 && interactive) {
      const picked = await vscode.window.showQuickPick(
        planCandidates.map(candidate => ({
          label: candidate.fsPath,
          description: candidate.path,
          uri: candidate
        })),
        {
          title: 'Choose Plan File'
        }
      );
      if (picked) {
        await configStore.setPlanFilePath(picked.uri.fsPath);
        return true;
      }
    }

    if (!interactive) {
      return false;
    }

    const action = await vscode.window.showInformationMessage(
      configuredUri
        ? 'The configured plan file could not be found. Choose another file or create a new one.'
        : 'File mode needs a plan file. Choose an existing file or create a new one.',
      'Choose Existing',
      'Create New'
    );

    if (action === 'Choose Existing') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use Plan File',
        filters: {
          'Plan Files': ['jsonc', 'json']
        },
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      if (picked?.[0]) {
        await configStore.setPlanFilePath(picked[0].fsPath);
        return true;
      }
      return false;
    }

    if (action === 'Create New') {
      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Create Plan File',
        filters: {
          'Plan Files': ['jsonc']
        },
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'ticket-plan.jsonc')
          : undefined
      });
      if (saveUri) {
        await vscode.workspace.fs.writeFile(
          saveUri,
          Buffer.from(createPlanTemplate(vscode.workspace.workspaceFolders?.[0]?.name), 'utf8')
        );
        await configStore.setPlanFilePath(saveUri.fsPath);
        await vscode.window.showInformationMessage(`Created ${saveUri.fsPath}.`);
        return true;
      }
    }

    return false;
  }

  async function promptForBackendMode(): Promise<BackendMode | undefined> {
    const options: Array<{ label: string; description: string; mode: BackendMode }> = [
      {
        label: 'Jira via MCP',
        description: 'Connect to Jira through a configured MCP server.',
        mode: 'jira'
      },
      {
        label: 'Jira API',
        description: 'Connect directly to Jira Server/Data Center over REST.',
        mode: 'jiraapi'
      },
      {
        label: 'Demo',
        description: 'Use built-in demo data.',
        mode: 'demo'
      },
      {
        label: 'File',
        description: 'Use a plan file from the current workspace.',
        mode: 'file'
      },
      {
        label: 'Live Folder',
        description: 'Two-way sync with a markdown plans folder.',
        mode: 'livefolder'
      }
    ];
    if (!vscode.workspace.workspaceFolders?.length) {
      options.splice(2, 0, {
        label: 'User Workspace',
        description: 'Store boards outside VS Code workspaces and add plan folders as boards.',
        mode: 'userworkspace'
      });
    }

    const picked = await vscode.window.showQuickPick<
      { label: string; description: string; mode: BackendMode }
    >(
      options,
      {
        title: 'Choose Backend Mode',
        ignoreFocusOut: true
      }
    );

    return picked?.mode;
  }

  async function ensureStartupConfiguration(): Promise<void> {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      await setModeContext();
      return;
    }

    const modeContext = getModeContextState();
    await setModeContext();

    if (modeContext.mode === 'file' && modeContext.configured) {
      await ensureFilePlanConfigured(true);
    }
  }

  async function selectIssue(
    issue: IssueSummary | undefined,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await filterStore.setLastSelectedIssueKey(issue?.key);
    await detailsProvider.setIssue(issue);
    boardPanelManager.setSelectedIssueKey(issue?.key);
    issuesSidebarViewProvider.setSelectedIssueKey(issue?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(issue?.key);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issue?.key);

    if (!issue) {
      issueDetailPanelManager.clear();
      return;
    }

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issue.key);
      await revealIssueDetailsInSidebar({ focus: false });
    } else {
      await revealIssueDetailsInSidebar({ focus: true });
    }
  }

  async function selectBoard(board: Board | undefined): Promise<void> {
    if (!board) {
      await boardStore.setLastSelectedBoardId(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      boardPanelManager.clear();
      return;
    }

    await boardStore.setLastSelectedBoardId(board.id);
    boardsSidebarViewProvider.setSelectedBoardId(board.id);
    await boardPanelManager.openBoard(board);
  }

  async function selectIssueByKey(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const issue = issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await selectIssue(issue, options);
  }

  async function searchIssues(): Promise<void> {
    const filters = filterStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Issues',
      prompt: 'Filter the My Issues list by issue text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await filterStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  async function searchEpics(): Promise<void> {
    const searchText = await vscode.window.showInputBox({
      title: 'Search EPICs',
      prompt: 'Filter the EPICs list by issue text.',
      value: epicsSidebarViewProvider.getSearchText(),
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await epicsSidebarViewProvider.setSearchText(searchText);
    await refreshSearchActionContexts();
  }

  async function searchBoards(): Promise<void> {
    const filters = boardStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Boards',
      prompt: 'Filter the Boards list by board text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await boardStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  function getEpicIssueType(mode: BackendMode): string {
    return mode === 'jira' || mode === 'jiraapi' ? 'Epic' : 'Feature';
  }

  async function reportActionError(error: unknown): Promise<void> {
    reportError(error);
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }

  async function resolveBoardById(boardId: string): Promise<Board | undefined> {
    return (
      boardsProvider.getBoardById(boardId) ??
      (await backendService.getBoards(boardStore.getFilters())).find(candidate => candidate.id === boardId)
    );
  }

  async function pickProject(defaultProjectKey?: string) {
    const projects = await backendService.getProjects();
    if (projects.length === 0) {
      await vscode.window.showWarningMessage('No projects are available.');
      return undefined;
    }

    if (defaultProjectKey) {
      const defaultProject = projects.find(project => project.key === defaultProjectKey);
      if (defaultProject) {
        return defaultProject;
      }
    }

    if (projects.length === 1) {
      return projects[0];
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(project => ({
        label: project.key,
        description: project.name,
        project
      })),
      {
        title: 'Project'
      }
    );
    return picked?.project;
  }

  async function createEpic(): Promise<void> {
    if (backendService.mode === 'file' && !(await ensureFilePlanConfigured(true))) {
      return;
    }

    const filters = filterStore.getFilters();
    const defaultProjectKey =
      filters.projectKeys.length === 1
        ? filters.projectKeys[0]
        : detailsProvider.getActiveIssue()?.projectKey;
    const project = await pickProject(defaultProjectKey);
    if (!project) {
      return;
    }

    const summary = await vscode.window.showInputBox({
      title: 'Create EPIC',
      prompt: 'Enter a short summary for the new EPIC.',
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
    });
    if (summary === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: 'EPIC Description',
      prompt: 'Optional description for the EPIC.',
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }

    const created = await backendService.createIssue({
      projectKey: project.key,
      issueType: getEpicIssueType(backendService.mode),
      summary: summary.trim(),
      description: description.trim() || undefined
    });

    await refreshAndRestoreSelection();
    await selectIssueByKey(created.key, { openFullPanel: true });
  }

  async function editIssue(issueKey: string): Promise<void> {
    try {
      const issue = await backendService.getIssue(issueKey);
      const label = issue.issueType?.trim() || 'Issue';
      const summary = await vscode.window.showInputBox({
        title: `Edit ${label} (${issue.key})`,
        prompt: 'Update the summary.',
        value: issue.summary,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
      });
      if (summary === undefined) {
        return;
      }

      const description = await vscode.window.showInputBox({
        title: `Description (${issue.key})`,
        prompt: 'Update the description.',
        value: issue.description ?? '',
        ignoreFocusOut: true
      });
      if (description === undefined) {
        return;
      }

      const parentRule = getParentRule(issue.issueType, backendService.mode);
      let parentKey: string | null = null;
      if (parentRule.canHaveParent) {
        const currentParentDescription = issue.parentIssue
          ? `${issue.parentIssue.key} ${issue.parentIssue.summary ?? ''}`.trim()
          : undefined;
        const pickedParentKey = await vscode.window.showInputBox({
          title: `${parentRule.defaultLabel} (${issue.key})`,
          prompt: currentParentDescription
            ? `Current ${issue.parentIssue?.issueType ?? parentRule.defaultLabel}: ${currentParentDescription}`
            : parentRule.helperText,
          value: issue.parentKey ?? '',
          ignoreFocusOut: true,
          validateInput: value =>
            parentRule.requiresParent && value.trim().length === 0
              ? `${parentRule.defaultLabel} is required.`
              : undefined
        });
        if (pickedParentKey === undefined) {
          return;
        }
        parentKey = pickedParentKey.trim() || null;
      }

      await updateIssueAndRefresh(
        issueKey,
        {
          summary: summary.trim(),
          description,
          parentKey
        },
        undefined,
        { openFullPanel: true }
      );
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editEpic(issueKey: string): Promise<void> {
    await editIssue(issueKey);
  }

  async function deleteIssue(issueKey: string): Promise<void> {
    try {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${issueKey}?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') {
        return;
      }

      if (filterStore.getFilters().parentKey === issueKey) {
        await filterStore.updateFilters({ parentKey: undefined });
      }
      if (filterStore.getLastSelectedIssueKey() === issueKey) {
        await filterStore.setLastSelectedIssueKey(undefined);
        await detailsProvider.setIssue(undefined);
        boardPanelManager.setSelectedIssueKey(undefined);
        issuesSidebarViewProvider.setSelectedIssueKey(undefined);
        epicsSidebarViewProvider.setSelectedIssueKey(undefined);
        issueDetailPanelManager.clear();
      }

      await backendService.deleteIssue(issueKey);
      await refreshAndRestoreSelection();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      const name = await vscode.window.showInputBox({
        title: `Edit Board (${board.name})`,
        prompt: 'Update the board name.',
        value: board.name,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length === 0 ? 'Board name is required.' : undefined)
      });
      if (name === undefined) {
        return;
      }

      const updatedBoard = await backendService.updateBoard(boardId, {
        name: name.trim()
      });
      await boardsProvider.refresh();

      if (
        boardStore.getLastSelectedBoardId() === boardId ||
        boardPanelManager.getActiveBoard()?.id === boardId
      ) {
        await boardStore.setLastSelectedBoardId(boardId);
        boardsSidebarViewProvider.setSelectedBoardId(boardId);
        await boardPanelManager.openBoard(updatedBoard);
      }
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function deleteBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete board ${board.name}?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') {
        return;
      }

      await backendService.deleteBoard(boardId);
      if (
        boardStore.getLastSelectedBoardId() === boardId ||
        boardPanelManager.getActiveBoard()?.id === boardId
      ) {
        await boardStore.setLastSelectedBoardId(undefined);
        boardsSidebarViewProvider.setSelectedBoardId(undefined);
        boardPanelManager.clear();
      }

      await boardsProvider.refresh();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function updateIssueAndRefresh(
    issueKey: string,
    input: UpdateIssueInput,
    transitionId?: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const normalizedInput: UpdateIssueInput = {};
    if (typeof input.summary === 'string') {
      normalizedInput.summary = input.summary;
    }
    if (typeof input.description === 'string') {
      normalizedInput.description = input.description;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'parentKey')) {
      normalizedInput.parentKey = input.parentKey?.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      normalizedInput.assignee = input.assignee?.trim() || null;
    }
    if (typeof input.priority === 'string') {
      normalizedInput.priority = input.priority;
    }
    if (typeof input.issueType === 'string') {
      normalizedInput.issueType = input.issueType;
    }

    await backendService.updateIssue(issueKey, normalizedInput);
    if (transitionId) {
      await backendService.transitionIssue(issueKey, transitionId);
    }
    await syncIssueAfterMutation(issueKey, options);
  }

  async function addCommentAndRefresh(issueKey: string, body: string): Promise<void> {
    await backendService.addComment(issueKey, body);
    const copilotRequest = extractCopilotRequest(body, configStore.getAiMentionName());
    if (copilotRequest) {
      if (!isCopilotSdkConfigured()) {
        void vscode.window.showWarningMessage(
          'Comment added, but GitHub Copilot SDK is not configured for @copilot replies. Run Ticket Manager: Configure AI.'
        );
      } else {
        try {
          await postCopilotReply(issueKey, copilotRequest);
        } catch (error) {
          reportError(error);
          void vscode.window.showWarningMessage(
            `Comment added, but @copilot could not respond: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    await syncIssueAfterMutation(issueKey);
  }

  function getConfiguredAiOptions(): AiOptionPick[] {
    const registeredAgents = configStore.getConfiguredAiAgents();
    const providers = configStore.getConfiguredAiProviders();
    const configuredProviders = new Set(registeredAgents.map(agent => agent.provider));
    const options = [
      ...registeredAgents.map(agent => ({
        provider: agent.provider,
        label: agent.name,
        description: AI_PROVIDER_LABELS[agent.provider] ?? agent.provider,
        agentName: agent.name,
        credential: agent.apiKey
      })),
      ...providers
        .filter(provider => !configuredProviders.has(provider))
        .map(provider => ({
          provider,
          label: AI_PROVIDER_LABELS[provider] ?? provider,
          description: provider
        }))
    ];

    return sortAiOptionsByDefaultProvider(options, configStore.getAiDefaultProvider());
  }

  function getAiAssignmentMenuOptions(): AiAssignmentMenuOption[] {
    return getConfiguredAiOptions().map(option => ({
      provider: option.provider,
      label: option.label
    }));
  }

  function refreshAiAssignmentMenus(): void {
    const options = getAiAssignmentMenuOptions();
    boardPanelManager.setAiAssignOptions(options);
    issuesSidebarViewProvider?.setAiAssignOptions(options);
    issueDetailPanelManager.setAiAssignOptions(options);
    issueDetailsSidebarViewProvider?.setAiAssignOptions(options);
  }

  function isTerminalAgentState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  async function findTransitionIdForStatus(
    issueKey: string,
    targetStatus: string
  ): Promise<string | undefined> {
    const issue = await backendService.getIssue(issueKey);
    if (
      issue.status.trim().toLowerCase() === targetStatus.trim().toLowerCase() ||
      issue.statusCategory?.toLowerCase() === 'done'
    ) {
      return undefined;
    }
    const transitions = issue.transitions?.length
      ? issue.transitions
      : await backendService.getTransitions(issueKey);
    return transitions.find(
      transition => transition.toStatus?.trim().toLowerCase() === targetStatus.trim().toLowerCase()
    )?.id;
  }

  async function promptForAiAssignmentOption(issueKey: string): Promise<AiOptionPick | undefined> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      await vscode.window.showWarningMessage(
        'No AI providers are configured. Add API keys, a Cursor CLI path, or enable GitHub Copilot SDK in Settings → Ticket Manager → AI.'
      );
      return undefined;
    }

    if (options.length === 1) {
      return options[0];
    }

    const picked = await vscode.window.showQuickPick(
      options.map(option => ({
        label: option.label,
        description: option.description,
        option
      })),
      {
        title: `Assign ${issueKey} to AI Agent`
      }
    );
    return picked?.option;
  }

  async function refreshIssueAiPresentation(issueKey: string): Promise<void> {
    await issuesSidebarViewProvider.refresh();
    await activeSessionsSidebarViewProvider?.refresh();
    if (detailsProvider.getActiveIssue()?.key === issueKey) {
      const activeIssue = detailsProvider.getActiveIssue();
      if (activeIssue) {
        activeIssue.aiAssignment = aiSessionManager.getSession(issueKey);
        await detailsProvider.setIssue(activeIssue);
      }
    }
    await issueDetailPanelManager.refreshIfShowing(issueKey);
  }

  async function abandonAiSession(
    issueKey: string,
    options?: { showMessage?: boolean; clearAssignee?: boolean }
  ): Promise<void> {
    const showMessage = options?.showMessage ?? true;
    const clearAssignee = options?.clearAssignee ?? true;
    const session = aiSessionManager.getSession(issueKey);
    const agentRecord = aiSessionManager.getAgentSession(issueKey);
    if (!session && !agentRecord) {
      if (showMessage) {
        void vscode.window.showInformationMessage(`${issueKey} has no active AI session.`);
      }
      return;
    }

    if (agentRecord && !isTerminalAgentState(agentRecord.state)) {
      if (hasActiveAgentTask(issueKey)) {
        await abortActiveAgentTask(issueKey);
      } else {
        aiSessionManager.updateAgentState(issueKey, 'aborted');
      }
    }

    aiSessionManager.removeSession(issueKey);

    if (clearAssignee) {
      try {
        const issue = await backendService.getIssue(issueKey);
        const assignedLabel =
          session?.label?.trim() ||
          (session
            ? AI_PROVIDER_LABELS[session.provider]
            : agentRecord?.provider
              ? AI_PROVIDER_LABELS[agentRecord.provider]
              : AI_PROVIDER_LABELS['copilot-cli']);
        if (issue.assignee?.trim() === assignedLabel) {
          await updateIssueAndRefresh(issueKey, { assignee: null });
        } else {
          await refreshIssueAiPresentation(issueKey);
        }
      } catch {
        await refreshIssueAiPresentation(issueKey);
      }
    } else {
      await refreshIssueAiPresentation(issueKey);
    }

    if (showMessage) {
      void vscode.window.showInformationMessage(`AI session abandoned for ${issueKey}.`);
    }
  }

  async function assignIssueToAi(issueKey: string, chosen: AiOptionPick): Promise<void> {
    const existing = aiSessionManager.getSession(issueKey);
    const existingAgentRecord = aiSessionManager.getAgentSession(issueKey);
    const existingStatus =
      existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state)
        ? existingAgentRecord.state
        : existing?.status;
    if (existing || (existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state))) {
      const overwrite = await vscode.window.showWarningMessage(
        `${issueKey} is already assigned to an AI agent (${existingStatus ?? 'active'}). Replace?`,
        'Replace',
        'Cancel'
      );
      if (overwrite !== 'Replace') {
        return;
      }
      await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    }

    const assignment = aiSessionManager.createSession(issueKey, chosen.provider, chosen.label);
    const activeIssue = detailsProvider.getActiveIssue();
    if (activeIssue?.key === issueKey) {
      activeIssue.aiAssignment = assignment;
    }

    try {
      const transitionId = await findTransitionIdForStatus(issueKey, 'In Progress');
      await updateIssueAndRefresh(issueKey, { assignee: chosen.label }, transitionId);
      await refreshIssueAiPresentation(issueKey);
    } catch (error) {
      aiSessionManager.removeSession(issueKey);
      if (activeIssue?.key === issueKey) {
        activeIssue.aiAssignment = undefined;
      }
      await refreshIssueAiPresentation(issueKey);
      throw error;
    }

    void vscode.window.showInformationMessage(
      `${issueKey} assigned to ${chosen.label} (session: ${assignment.sessionId.slice(0, 8)})`
    );
  }

  async function assignIssueToAiByProvider(issueKey: string, provider: AiProvider): Promise<void> {
    const chosen = getConfiguredAiOptions().find(option => option.provider === provider);
    if (!chosen) {
      await vscode.window.showWarningMessage(
        `The AI provider ${AI_PROVIDER_LABELS[provider] ?? provider} is no longer configured.`
      );
      return;
    }

    await assignIssueToAi(issueKey, chosen);
  }

  async function assignIssueToMe(issueKey: string): Promise<void> {
    const label = await backendService.getSelfAssigneeLabel();
    if (!label) {
      void vscode.window.showWarningMessage(
        'Could not resolve the current user for assignment. For Jira, use Edit to set an assignee manually.'
      );
      return;
    }
    await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    await updateIssueAndRefresh(issueKey, { assignee: label });
  }

  async function loadPlanContext(issueKey: string): Promise<string | undefined> {
    try {
      const planUri = await configStore.getResolvedPlanFileUri();
      if (!planUri) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(planUri);
      const text = Buffer.from(bytes).toString('utf8');
      // Quick extraction: find the issue key in the plan text and grab surrounding context
      const lines = text.split('\n');
      const matchIndex = lines.findIndex(line => line.includes(`"${issueKey}"`));
      if (matchIndex < 0) {
        return undefined;
      }
      // Grab a window of lines around the match (the plan item block)
      const start = Math.max(0, matchIndex - 2);
      const end = Math.min(lines.length, matchIndex + 20);
      return lines.slice(start, end).join('\n').trim();
    } catch {
      return undefined;
    }
  }

  async function promptForCopilotTaskDefinition(
    issue: IssueDetails,
    previous?: AgentTaskDefinition
  ): Promise<AgentTaskDefinition | undefined> {
    const issueWorkflowAssignment = aiSessionManager.getIssueWorkflowAssignment(issue.key);
    const planContext = await loadPlanContext(issue.key);
    const defaultGoal = previous?.goal ??
      `${issue.summary}${issue.description ? '\\n' + issue.description.slice(0, 200) : ''}` +
      (planContext ? `\\n\\nPlan context:\\n${planContext.slice(0, 300)}` : '');

    const goal = await vscode.window.showInputBox({
      title: 'Goal',
      prompt: planContext
        ? 'What should the agent accomplish? (plan context included)'
        : 'What should the agent accomplish?',
      value: defaultGoal,
      ignoreFocusOut: true
    });
    if (!goal) {
      return undefined;
    }

    const scope = await vscode.window.showInputBox({
      title: 'Scope',
      prompt: 'What files/areas should the agent focus on?',
      value: previous?.scope ?? 'This issue and related files',
      ignoreFocusOut: true
    });
    if (scope === undefined) {
      return undefined;
    }

    const definitionOfDone = await vscode.window.showInputBox({
      title: 'Definition of Done',
      prompt: 'When is this task considered complete?',
      value:
        previous?.definitionOfDone ??
        'All acceptance criteria met, code compiles, tests pass',
      ignoreFocusOut: true
    });
    if (definitionOfDone === undefined) {
      return undefined;
    }

    const workflow = await promptForAgentWorkflowSelection({
      workspaceRoot: workingDirectory,
      previous: previous?.workflow ?? issueWorkflowAssignment?.workflow,
      title: 'Workflow Pack',
      placeHolder: 'Select an optional workflow pack for this Copilot task'
    });
    if (workflow === null) {
      return undefined;
    }

    return {
      goal,
      scope: scope || 'This issue and related files',
      definitionOfDone: definitionOfDone || 'Task complete',
      workflow,
      maxSteps: previous?.maxSteps,
      timeoutMs: previous?.timeoutMs,
      nonGoals: previous?.nonGoals
    };
  }

  async function startNewCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured() && !isClaudeSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'Neither GitHub Copilot SDK nor Claude Code CLI is configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    try {
      const existingRecord = aiSessionManager.getAgentSession(issueKey);
      if (hasActiveAgentTask(issueKey)) {
        const replace = await vscode.window.showWarningMessage(
          `${issueKey} already has a live AI session. Start a new one instead?`,
          'Start New',
          'Cancel'
        );
        if (replace !== 'Start New') {
          return;
        }
        await abortActiveAgentTask(issueKey);
      }

      const issue = await backendService.getIssue(issueKey);
      const taskDefinition = await promptForCopilotTaskDefinition(issue, existingRecord?.taskDefinition);
      if (!taskDefinition) {
        return;
      }

      const issueAttachments = await stageIssueAttachments({
        issue,
        backendService,
        logger: outputChannel
      });
      const taskDefinitionWithAttachments = issueAttachments.length > 0
        ? { ...taskDefinition, attachments: issueAttachments }
        : taskDefinition;

      const provider = await startAgentTask(issue, taskDefinitionWithAttachments, {
        provider: resolvePreferredAgentProvider(issueKey, existingRecord, issue),
        workingDirectory
      });
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `${getAgentDisplayName(provider)} session started for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'startNewCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to start a new AI session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function resolveAgentWorkingDirectory(record?: AgentSessionRecord): string | undefined {
    const deliveryWorktreePath = record?.delivery?.worktreePath?.trim();
    if (deliveryWorktreePath) {
      return deliveryWorktreePath;
    }

    return workingDirectory;
  }

  async function resumeCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured() && !isClaudeSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'Neither GitHub Copilot SDK nor Claude Code CLI is configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      void vscode.window.showWarningMessage(`No resumable AI session was found for ${issueKey}.`);
      return;
    }

    if (hasActiveAgentTask(issueKey)) {
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      copilotSessionPanelManager.open(issueKey);
      return;
    }

    try {
      const provider = await resumeAgentTask(issueKey, record);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `${getAgentDisplayName(provider)} session resumed for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'resumeCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to resume the AI session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function reviewIssueWithAi(issueKey: string): Promise<void> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error(
        'No AI providers are configured. Add an OpenAI key, Claude key, Cursor CLI path, or enable GitHub Copilot SDK in Settings.'
      );
    }

    let chosen = options[0];
    if (options.length > 1) {
      const picked = await vscode.window.showQuickPick(
        options.map(option => ({
          label: option.label,
          description: option.description,
          option
        })),
        { title: `Review ${issueKey} with AI` }
      );
      if (!picked) {
        return; // user cancelled
      }
      chosen = picked.option;
    }

    const issue = await backendService.getIssue(issueKey);

    let reviewText: string;
    if (chosen.provider === 'openai') {
      const apiKey = chosen.credential ?? configStore.getAiOpenaiApiKey().trim();
      const agentName = chosen.agentName ?? AI_PROVIDER_LABELS.openai;
      reviewText = await reviewTicketWithOpenAi(issue, apiKey, agentName);
    } else if (chosen.provider === 'claude') {
      const apiKey = chosen.credential ?? configStore.getAiClaudeApiKey().trim();
      const agentName = chosen.agentName ?? AI_PROVIDER_LABELS.claude;
      reviewText = await reviewTicketWithClaude(issue, apiKey, agentName);
    } else if (chosen.provider === 'copilot-cli') {
      reviewText = await reviewTicketWithCopilot(
        issue,
        getCopilotCliPathOverride(),
        chosen.agentName ?? AI_PROVIDER_LABELS['copilot-cli'],
        workingDirectory
      );
    } else {
      // Claude Code CLI is only used for agent tasks, not for AI reviews
      throw new Error(`AI review is not supported for provider: ${chosen.provider}`);
    }

    await backendService.addComment(issueKey, reviewText);
    await syncIssueAfterMutation(issueKey);
  }

  async function transitionIssueAndRefresh(issueKey: string, transitionId: string): Promise<void> {
    await backendService.transitionIssue(issueKey, transitionId);
    await syncIssueAfterMutation(issueKey);
  }

  async function syncIssueAfterMutation(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      epicsSidebarViewProvider.refresh(),
      activeSessionsSidebarViewProvider?.refresh() ?? Promise.resolve()
    ]);

    const refreshedIssue =
      issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await filterStore.setLastSelectedIssueKey(issueKey);
    await detailsProvider.setIssue(refreshedIssue);
    boardPanelManager.setSelectedIssueKey(issueKey);
    issuesSidebarViewProvider.setSelectedIssueKey(issueKey);
    epicsSidebarViewProvider.setSelectedIssueKey(issueKey);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(issueKey);

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issueKey);
      await revealIssueDetailsInSidebar({ focus: false });
    }
  }

  boardPanelManager.setCardActions({
    assignToMe: async issueKey => {
      await assignIssueToMe(issueKey);
    },
    assignToAi: async (issueKey, provider) => {
      await assignIssueToAiByProvider(issueKey, provider);
    },
    editIssue,
    deleteIssue
  });

  const refreshAndRestoreSelection = async (): Promise<void> => {
    const modeContext = getModeContextState();
    await setModeContext();
    await ensureJiraApiIssueScopeVisibility(modeContext);
    epicsSidebarViewProvider.setLinkedEpicKey(configStore.getJiraApiEpicKey());

    if (!modeContext.configured) {
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      return;
    }

    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      activeSessionsSidebarViewProvider?.refresh() ?? Promise.resolve()
    ]);
    const lastSelectedKey = filterStore.getLastSelectedIssueKey();
    if (lastSelectedKey) {
      const issue = issuesProvider.getIssueByKey(lastSelectedKey);
      if (issue) {
        await detailsProvider.setIssue(issue);
        await revealIssueDetailsInSidebar({ focus: false });
        boardPanelManager.setSelectedIssueKey(lastSelectedKey);
        issuesSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
        epicsSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
        activeSessionsSidebarViewProvider?.setSelectedIssueKey(lastSelectedKey);
      } else {
        await filterStore.setLastSelectedIssueKey(undefined);
        await detailsProvider.setIssue(undefined);
        boardPanelManager.setSelectedIssueKey(undefined);
        issuesSidebarViewProvider.setSelectedIssueKey(undefined);
        epicsSidebarViewProvider.setSelectedIssueKey(undefined);
        activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
        issueDetailPanelManager.clear();
      }
    } else {
      boardPanelManager.setSelectedIssueKey(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
    }

    boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());

    await boardPanelManager.refresh();
  };

  issuesSidebarViewProvider = new IssuesSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    aiSessionManager,
    {
      onSelectIssue: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onAssignToMe: async issueKey => {
        await assignIssueToMe(issueKey);
      },
      onAssignToAi: async (issueKey, provider) => {
        await assignIssueToAiByProvider(issueKey, provider);
      },
      onEditIssue: async issueKey => {
        await editIssue(issueKey);
      },
      onDeleteIssue: async issueKey => {
        await deleteIssue(issueKey);
      },
      onSetSearchText: async (searchText) => {
        await filterStore.updateFilters({ searchText });
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
        await filterStore.updateFilters({ statuses });
      },
      onLoadMore: async () => {
        await issuesProvider.loadMore();
      }
    }
  );
  refreshAiAssignmentMenus();
  epicsSidebarViewProvider = new EpicsSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    {
      onSelectEpic: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onCreateEpic: async () => {
        await createEpic();
      },
      onEditEpic: async issueKey => {
        await editEpic(issueKey);
      },
      onLinkEpic: async issueKey => {
        await linkEpicToWorkspace(issueKey);
      },
      onDeleteEpic: async issueKey => {
        await deleteIssue(issueKey);
      },
      onSetSearchText: async (_searchText) => {
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
        await filterStore.setEpicStatuses(statuses);
      }
    }
  );
  boardsSidebarViewProvider = new BoardsSidebarViewProvider(
    boardStore,
    boardsProvider,
    boardColumnStore,
    () => backendService.mode,
    {
      onSelectBoard: async boardId => {
        await selectBoard(boardsProvider.getBoardById(boardId));
      },
      onEditBoard: async boardId => {
        await editBoard(boardId);
      },
      onDeleteBoard: async boardId => {
        await deleteBoard(boardId);
      }
    }
  );
  issueDetailsSidebarViewProvider = new IssueDetailsSidebarViewProvider(
    backendService,
    detailsProvider,
    aiSessionManager,
    () => configStore.getAiAgentNames(),
    {
      onSaveIssueEdits: async (issueKey, input, transitionId) => {
        await updateIssueAndRefresh(issueKey, input, transitionId);
      },
      onAddComment: async (issueKey, body) => {
        await addCommentAndRefresh(issueKey, body);
      },
      onRequestAiReview: async (issueKey) => {
        await reviewIssueWithAi(issueKey);
      }
    }
  );
  updateCommentPlaceholders();
  activeSessionsSidebarViewProvider = new ActiveSessionsSidebarViewProvider(
    backendService,
    aiSessionManager,
    issueKey => copilotAgentService.hasActiveTask(issueKey) || claudeAgentService.hasActiveTask(issueKey),
    {
      onOpenSession: async issueKey => {
        activeSessionsSidebarViewProvider.setSelectedIssueKey(issueKey);
        copilotSessionPanelManager.open(issueKey);
      },
      onResumeSession: async issueKey => {
        await resumeCopilotSession(issueKey);
      },
      onStartNewSession: async issueKey => {
        await startNewCopilotSession(issueKey);
      },
      onAbandonSession: async issueKey => {
        await abandonAiSession(issueKey);
      }
    }
  );

  function resolveIssueKeyFromArgOrActive(arg?: unknown): string | undefined {
    if (typeof arg === 'string' && arg.trim().length > 0) {
      return arg.trim();
    }
    if (
      arg &&
      typeof arg === 'object' &&
      'issueKey' in arg &&
      typeof (arg as { issueKey?: unknown }).issueKey === 'string'
    ) {
      return (arg as { issueKey: string }).issueKey;
    }
    return detailsProvider.getActiveIssue()?.key;
  }

  await refreshSearchActionContexts();

  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.createEpic', async () => {
      try {
        await createEpic();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssues', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssuesActive', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpics', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpicsActive', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoards', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoardsActive', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToMe', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await assignIssueToMe(issueKey);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToAi', async (arg?: unknown, providerArg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        if (typeof providerArg === 'string') {
          await assignIssueToAiByProvider(issueKey, providerArg as AiProvider);
          return;
        }

        const picked = await promptForAiAssignmentOption(issueKey);
        if (!picked) {
          return;
        }

        await assignIssueToAi(issueKey, picked);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.unassignAi', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await abandonAiSession(issueKey, { showMessage: true, clearAssignee: true });
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.reviewWithAi', async () => {
      try {
        const issue = detailsProvider.getActiveIssue();
        if (!issue) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${issue.key} with AI…`,
            cancellable: false
          },
          async () => {
            await reviewIssueWithAi(issue.key);
          }
        );
        await vscode.window.showInformationMessage(`AI review posted as a comment on ${issue.key}.`);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.localPeerReview', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        const issue = await backendService.getIssue(issueKey);
        await localPeerReviewPanel.open(issue);
      } catch (error) {
        await vscode.window.showErrorMessage(
          `LPR failed: ${error instanceof Error ? error.message : String(error)}`
        );
        reportError(error, 'localPeerReview');
      }
    }),
    vscode.commands.registerCommand('ticketManager.startClaudeSession', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await startNewCopilotSession(issueKey); // This will now prefer Claude Code
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.startSubTaskDelivery', async (parentIssueKey?: string, subTaskKey?: string) => {
      if (!parentIssueKey || !subTaskKey) {
        void vscode.window.showErrorMessage('Parent issue key and sub-task key are required.');
        return;
      }
      try {
        await startSubTaskDelivery(parentIssueKey, subTaskKey);
        void vscode.window.showInformationMessage(`Started delivery workflow for sub-task ${subTaskKey}.`);
      } catch (error) {
        reportError(error, `startSubTaskDelivery:${subTaskKey}`);
        void vscode.window.showErrorMessage(
          `Failed to start sub-task delivery: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:local-dev.ticket-manager ticketManager'
      );
    }),
    vscode.commands.registerCommand('ticketManager.configureAi', async () => {
      try {
        const result = await promptToConfigureDefaultAiProvider();
        refreshAiAssignmentMenus();
        await ticketManagerStatusBar.refresh();
        if (result.status !== 'cancelled') {
          await vscode.window.showInformationMessage(describeAiConfigurationResult(result));
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        reportError(error);
      }
    }),
    ...registerCommands({
      context,
      configStore,
      backendService,
      filterStore,
      boardStore,
      boardColumnConfigPanel,
      newProjectWizardPanel,
      setupWizardPanel,
      setupSidebarViewProvider,
      issuesProvider,
      boardsProvider,
      detailsProvider,
      boardPanelManager,
      issueDetailPanelManager,
      revealIssueDetailsTree: () => revealIssueDetailsInSidebar({ focus: false }),
      ensureFilePlanConfigured,
      output: outputChannel,
      onConnectionCheck: result => {
        ticketManagerStatusBar.recordConnectionResult(result);
      },
      reportError,
      copilotAgentService,
      copilotSessionPanelManager,
      aiSessionManager
    }),
    vscode.window.registerWebviewViewProvider('ticketManager.myIssues', issuesSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.epics', epicsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.boards', boardsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.activeSessions', activeSessionsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.issueDetails', issueDetailsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.setup', setupSidebarViewProvider),
    setupSidebarViewProvider,
    issuesSidebarViewProvider,
    epicsSidebarViewProvider,
    boardsSidebarViewProvider,
    activeSessionsSidebarViewProvider,
    issueDetailsSidebarViewProvider,
    ticketManagerStatusBar,
    startupPollingController,
    copilotAgentService,
    copilotSessionPanelManager,
    aiSessionManager,
    filterStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
      void (async () => {
        try {
          const activeIssue = detailsProvider.getActiveIssue();
          await issuesProvider.refresh();
          if (activeIssue) {
            const refreshedIssue = issuesProvider.getIssueByKey(activeIssue.key) ?? activeIssue;
            await detailsProvider.setIssue(refreshedIssue);
          }
          boardPanelManager.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
        } catch (error) {
          reportError(error);
        }
      })();
    }),
    boardStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
      boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
      void boardsProvider.refresh().catch(error => reportError(error));
    }),
    ...(context.extensionMode !== vscode.ExtensionMode.Test
      ? [
          vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('ticketManager')) {
              return;
            }

            if (
              event.affectsConfiguration('ticketManager.ai') &&
              !event.affectsConfiguration('ticketManager.backendMode') &&
              !event.affectsConfiguration('ticketManager.connectionType') &&
              !event.affectsConfiguration('ticketManager.httpUrl') &&
              !event.affectsConfiguration('ticketManager.stdioCommand') &&
              !event.affectsConfiguration('ticketManager.stdioArgs') &&
              !event.affectsConfiguration('ticketManager.stdioCwd') &&
              !event.affectsConfiguration('ticketManager.planFilePath') &&
              !event.affectsConfiguration('ticketManager.liveFolderPath') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectKey') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectName') &&
              !event.affectsConfiguration('ticketManager.workspaceMcpServerName') &&
              !event.affectsConfiguration('ticketManager.userMcpServerRef')
            ) {
              refreshAiAssignmentMenus();
              void ticketManagerStatusBar.refresh().catch(error => reportError(error));
              return;
            }

            void (async () => {
              try {
                refreshAiAssignmentMenus();
                const modeContext = getModeContextState();
                await setModeContext();
                if (modeContext.mode === 'file' && modeContext.configured) {
                  await ensureFilePlanConfigured(true);
                }
                await filterStore.setLastSelectedIssueKey(undefined);
                await boardStore.setLastSelectedBoardId(undefined);
                await detailsProvider.setIssue(undefined);
                boardsSidebarViewProvider.setSelectedBoardId(undefined);
                await epicsSidebarViewProvider.setSearchText('');
                await refreshSearchActionContexts();
                boardPanelManager.clear();
                issueDetailPanelManager.clear();
                await backendService.reset();
                await refreshAndRestoreSelection();
                await startupPollingController.refresh();
                await ticketManagerStatusBar.refresh();
              } catch (error) {
                reportError(error);
              }
            })();
          })
        ]
      : [])
  );

  try {
    await ensureStartupConfiguration();
    if (getModeContextState().configured) {
      await refreshAndRestoreSelection();
    }
    await startupPollingController.refresh();
    await ticketManagerStatusBar.refresh();

    // Recover in-flight delivery sessions that were interrupted by a restart.
    // The onDidChangeAgentSession listener only fires on changes, so sessions
    // that were already pending finalization at shutdown must be re-triggered.
    await recoverPendingDeliverySessions();
  } catch (error) {
    reportError(error);
  }

  deactivateHandler = async () => {
    await startupPollingController.stop();
    await pauseAllAgentTasks(
      'Session paused because VS Code is closing. Reopen VS Code and resume to continue.'
    );
  };

  return {
    refresh: refreshAndRestoreSelection,
    backendService,
    filterStore,
    boardStore,
    boardColumnStore,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    issueDetailPanelManager,
    configStore,
    aiSessionManager,
    outputChannel
  };
}

export async function deactivate(): Promise<void> {
  const handler = deactivateHandler;
  deactivateHandler = undefined;
  await handler?.();
}
