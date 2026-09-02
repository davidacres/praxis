import type { AiProvider } from '../types';

// ── Agent Task State Machine ─────────────────────────────────────────────
//
//  NotStarted → Planning → AwaitingApproval → Executing ⇄ AwaitingInput
//                                                 ↓
//                                     Paused | Completed | Failed | Aborted

export type AgentTaskState =
  | 'not_started'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_input'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface AgentWorkflowReference {
  id: string;
  name: string;
  description?: string;
  /** Repo-relative when possible so the same path works from a worktree. */
  instructionsPath: string;
  link?: string;
}

export type WorkflowAssignmentSource = 'manual' | 'automatic' | 'analysis';

export interface IssueWorkflowAssignment {
  /**
   * The chosen workflow pack. `undefined` means the user (or analysis) explicitly
   * selected "No workflow pack" for this issue — delivery should still proceed
   * but without a workflow directive. Compare to absence of an assignment
   * record, which means the user has not yet made a choice.
   */
  workflow?: AgentWorkflowReference;
  source: WorkflowAssignmentSource;
  assignedAt: string;
  reason?: string;
}

export interface AgentTaskAttachment {
  fileName: string;
  localPath: string;
  mediaType?: string;
  sizeBytes?: number;
  sourceUrl?: string;
}

/** What the agent should do, with explicit guardrail boundaries. */
export interface AgentTaskDefinition {
  kind?: 'general' | 'analysis' | 'review' | 'jira-delivery';
  /** Explicit composer mode, when a task was created from a session composer. */
  sessionMode?: SessionMode;
  goal: string;
  scope: string;
  definitionOfDone: string;
  workflow?: AgentWorkflowReference;
  attachments?: AgentTaskAttachment[];
  nonGoals?: string[];
  completionContract?: string;
  /** Hard limit on tool invocations before the session is stopped. Default: 200. */
  maxSteps?: number;
  /** Hard timeout in ms for the entire task. Default: 10 800 000 (3 h). */
  timeoutMs?: number;
}

export interface DeliveryTaskResult {
  status: 'success' | 'failure';
  summary: string;
  branch: string;
  commitHash?: string;
  pushedRef?: string;
  buildIdentifier?: string;
  artifactPaths: string[];
  failureReason?: string;
}

export interface DeliveryMergeRequestNoteSnapshot {
  id: string;
  discussionId?: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryMergeRequestFeedbackContext {
  triggeredAt: string;
  notes: DeliveryMergeRequestNoteSnapshot[];
}

export interface DeliveryMergeRequestMetadata {
  iid: number;
  webUrl: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  mergeCommitSha?: string;
  handledNotes?: Record<string, string>;
  lastSeenAt?: string;
  pendingFeedback?: DeliveryMergeRequestFeedbackContext;
  buildRequiredOnMerge?: boolean;
}

export interface FeatureSubTaskRecord {
  /** Jira issue key of the created sub-task. */
  issueKey: string;
  summary: string;
  order: number;
  /** Workflow pack assigned to this sub-task (if any). */
  workflow?: AgentWorkflowReference;
  /** Agent session state for the sub-task delivery. */
  deliveryState?: 'pending' | 'in-progress' | 'completed' | 'failed';
  /** Worktree branch name when a delivery session is active. */
  worktreeBranch?: string;
}

export interface FeatureDecompositionMetadata {
  /** The parent feature request issue key. */
  parentIssueKey: string;
  /** The feature branch all sub-task MRs merge into. */
  featureBranch: string;
  /** The base branch the feature branch was created from. */
  baseBranch: string;
  /** Sub-tasks created from the decomposition. */
  subTasks: FeatureSubTaskRecord[];
  /** Summary from the decomposition agent. */
  decompositionSummary?: string;
}

export interface DeliverySessionMetadata {
  source: 'jira-polling';
  phase: 'analysis' | 'implementation' | 'merge-request-feedback' | 'feature-decomposition';
  baseBranch: string;
  worktreeName: string;
  worktreePath: string;
  createdBranch: string;
  publishCommand: string;
  artifactPattern: string;
  mergeRequest?: DeliveryMergeRequestMetadata;
  analysisSummary?: string;
  analysisPlan?: string;
  summaryTemplate?: string;
  failureTemplate?: string;
  finalizationState: 'pending' | 'completed' | 'failed';
  finalizationMessage?: string;
  result?: DeliveryTaskResult;
  /** Artifact names already uploaded to Jira — used to avoid duplicates on recovery. */
  uploadedArtifactNames?: string[];
  /** When this is a sub-task delivery, the parent feature request issue key. */
  parentFeatureIssueKey?: string;
  /** Present when this is a feature request decomposition workflow. */
  featureDecomposition?: FeatureDecompositionMetadata;
}

/** One file touched by a tool call, with a unified diff when the before/after text is known. */
export interface AgentToolFileChange {
  path: string;
  diff?: string;
  oldText?: string;
  newText?: string;
}

/**
 * Structured companion to an `AgentEventSummary` for `tool_start` / `tool_complete`
 * events. Optional and provider-agnostic — hosts that cannot supply a field leave
 * it unset and the renderer falls back to the plain `detail` string.
 */
export interface AgentToolEventData {
  callId?: string;
  toolName?: string;
  kind?: 'shell' | 'write' | 'read' | 'list' | 'search' | 'tracker' | 'other';
  /** One-line digest of the arguments, for the `tool_start` summary row. */
  argsSummary?: string;
  /** Raw arguments (`tool_start`). */
  args?: Record<string, unknown>;
  ok?: boolean;
  /** Unified-diff text for a single-file write. */
  diff?: string;
  fileChanges?: AgentToolFileChange[];
  /** Terminal-style stdout/stderr for a shell command. */
  output?: string;
  exitCode?: number;
}

/** Compact event record for display and persistence (not the raw SDK event). */
export interface AgentEventSummary {
  timestamp: string;
  type: AgentEventType;
  summary: string;
  detail?: string;
  /** Structured tool metadata for `tool_start` / `tool_complete`; absent on older records. */
  data?: AgentToolEventData;
}

export type AgentEventType =
  | 'session_start'
  | 'plan'
  | 'intent'
  | 'reasoning'
  | 'message'
  | 'tool_start'
  | 'tool_complete'
  | 'permission_requested'
  | 'permission_completed'
  | 'user_input_requested'
  | 'user_input_completed'
  | 'idle'
  | 'error'
  | 'task_complete'
  | 'aborted'
  | 'info'
  | 'warning';

/** Persisted chat turn for gateway agent resume (OpenAI-compatible wire messages). */
export interface AgentConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Tool access granted to an agent session. Read-only is enforced by the host, not just prompted. */
export type AgentToolMode = 'read-only' | 'full' | 'project-only';

/** Explicit purpose of a user-facing AI session. */
export type SessionMode = 'chat' | 'analysis' | 'review';

/** Full persisted record for an AI agent session attached to an issue. */
export interface AgentSessionRecord {
  issueKey: string;
  sessionId: string;
  /** User-editable display title. Falls back to the task goal for older records. */
  title?: string;
  provider?: AiProvider;
  /** Runtime model selected when the session started; reused for follow-up turns. */
  model?: string;
  /** Stable workspace root used for every turn in this session. */
  workingDirectory?: string;
  /** When this session runs in a dedicated git worktree: its checkout path. */
  worktreePath?: string;
  /** The branch `git worktree add -b` created for this session. */
  worktreeBranch?: string;
  /** The branch the session worktree was based on. */
  worktreeBaseBranch?: string;
  /** The worktree directory name (also the branch name). */
  worktreeName?: string;
  /** Host-enforced tool access. Older sessions default to full access. */
  toolMode?: AgentToolMode;
  /** Provider-owned identifier used when the runtime supports native resume. */
  runtimeSessionId?: string;
  /** Tracker connection bound when this issue session was created. */
  connectionId?: string;
  /**
   * Set when this session is a governed workflow stage (FX-BF-013). Together
   * these make a session traceable back to the run and node that started it —
   * what lets the Sessions view label it and the run monitor link to it.
   * Absent for ordinary ticket and composer sessions.
   */
  workflowRunId?: string;
  workflowNodeId?: string;
  state: AgentTaskState;
  taskDefinition: AgentTaskDefinition;
  delivery?: DeliverySessionMetadata;
  events: AgentEventSummary[];
  planText?: string;
  reasoningText?: string;
  responseText?: string;
  /** Conversation history for vercel-gateway resume (excludes system prompt). */
  conversationHistory?: AgentConversationMessage[];
  stepCount: number;
  startedAt: string;
  completedAt?: string;
  boardId?: string;
  /** Explicit session purpose; older records derive this from taskDefinition.kind. */
  mode?: SessionMode;
}

/** Default guardrail limits. */
export const AGENT_DEFAULTS = {
  maxSteps: 500,
  timeoutMs: 3 * 60 * 60 * 1000 // 3 hours — delivery workflows can run E2E suites, long builds, and iterative reviews
} as const;
