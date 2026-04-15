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

export type WorkflowAssignmentSource = 'manual' | 'automatic';

export interface IssueWorkflowAssignment {
  workflow: AgentWorkflowReference;
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
  kind?: 'general' | 'jira-delivery';
  goal: string;
  scope: string;
  definitionOfDone: string;
  workflow?: AgentWorkflowReference;
  attachments?: AgentTaskAttachment[];
  nonGoals?: string[];
  completionContract?: string;
  /** Hard limit on tool invocations before the session is stopped. Default: 200. */
  maxSteps?: number;
  /** Hard timeout in ms for the entire task. Default: 1 800 000 (30 min). */
  timeoutMs?: number;
}

export interface DeliveryTaskResult {
  status: 'success' | 'failure';
  summary: string;
  branch: string;
  commitHash?: string;
  pushedRef?: string;
  artifactPaths: string[];
  failureReason?: string;
}

export interface DeliverySessionMetadata {
  source: 'jira-polling';
  baseBranch: string;
  worktreeName: string;
  worktreePath: string;
  createdBranch: string;
  publishCommand: string;
  artifactPattern: string;
  summaryTemplate?: string;
  failureTemplate?: string;
  finalizationState: 'pending' | 'completed' | 'failed';
  finalizationMessage?: string;
  result?: DeliveryTaskResult;
}

/** Compact event record for display and persistence (not the raw SDK event). */
export interface AgentEventSummary {
  timestamp: string;
  type: AgentEventType;
  summary: string;
  detail?: string;
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

/** Full persisted record for a Copilot agent session attached to an issue. */
export interface AgentSessionRecord {
  issueKey: string;
  sessionId: string;
  state: AgentTaskState;
  taskDefinition: AgentTaskDefinition;
  delivery?: DeliverySessionMetadata;
  events: AgentEventSummary[];
  planText?: string;
  reasoningText?: string;
  responseText?: string;
  stepCount: number;
  startedAt: string;
  completedAt?: string;
}

/** Default guardrail limits. */
export const AGENT_DEFAULTS = {
  maxSteps: 500,
  timeoutMs: 30 * 60 * 1000 // 30 minutes
} as const;
