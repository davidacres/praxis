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

/** What the agent should do, with explicit guardrail boundaries. */
export interface AgentTaskDefinition {
  goal: string;
  scope: string;
  definitionOfDone: string;
  nonGoals?: string[];
  /** Hard limit on tool invocations before the session is stopped. Default: 200. */
  maxSteps?: number;
  /** Hard timeout in ms for the entire task. Default: 1 800 000 (30 min). */
  timeoutMs?: number;
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
