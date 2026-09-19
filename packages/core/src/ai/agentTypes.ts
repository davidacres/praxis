import type { AiProvider } from '../types';
import type { TokenUsage } from './gateway';

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
  /** Optional version declared by the pack front matter. */
  version?: string;
  /** Repo-relative when possible so the same path works from a worktree. */
  instructionsPath: string;
  link?: string;
}

export type AgentWorkflowResolutionMode = 'content' | 'reference';

/** Immutable provenance for the pack actually handed to a session. */
export interface AgentWorkflowProvenance {
  source: 'workspace';
  resolutionMode: AgentWorkflowResolutionMode;
  fingerprint: string;
  version?: string;
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
  workflowProvenance?: AgentWorkflowProvenance;
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
  /** The AI participant that produced an assistant message in a multi-AI conversation. */
  speaker?: AgentConversationSpeaker;
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
  | 'warning'
  | 'model_change'
  | 'provider_handover'
  | 'conversation_turn';

export type AgentConversationMode = 'consult' | 'debate' | 'pair';
export type AgentConversationState = 'idle' | 'running' | 'stopped' | 'capped' | 'failed';

/** A named AI in an opt-in conversation. The host is the original session runtime. */
export interface AgentConversationParticipant {
  id: string;
  provider: AiProvider;
  model?: string;
  role: 'host' | 'guest';
  displayLabel: string;
}

/** Stable identity carried by completed assistant message events. */
export interface AgentConversationSpeaker {
  participantId: string;
  provider: AiProvider;
  model?: string;
  displayLabel: string;
}

/** Persisted state for a bounded, sequential conversation between two AIs. */
export interface AgentConversation {
  mode: AgentConversationMode;
  participants: [AgentConversationParticipant, AgentConversationParticipant];
  currentSpeakerId: string;
  toolOwnerId: string;
  /** Tool mode to restore when the opt-in conversation ends. */
  originalToolMode: AgentToolMode;
  turnCap: number;
  turnsUsed: number;
  state: AgentConversationState;
  /** Human messages queued for specific participants while another turn is running. */
  pendingUserMessages?: Array<{ participantId: string; message: string }>;
}

export interface AiStartConversationInput {
  provider: AiProvider;
  model?: string;
  mode: AgentConversationMode;
  turnCap: number;
}

/** A human-directed message in an active bounded AI conversation. */
export interface AiConversationMessageInput {
  participantId: string;
  message: string;
}

/** Why a session exists — a snapshot of the ticket or plan at session creation. */
export interface SessionPurpose {
  issueKey: string;
  title?: string;
  goal: string;
  scope: string;
  definitionOfDone: string;
}

export type HandoverBriefFreshness = 'updating' | 'fresh' | 'stale' | 'failed';

/** Structured living account of the session, distinct from git file listings. */
export interface HandoverBrief {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  /** Number of events covered by this revision. */
  sourceEventCount: number;
  freshness: HandoverBriefFreshness;
  lastError?: string;
  progress: string;
  changes: string;
  decisions: string;
  risks: string;
  openQuestions: string;
  nextSteps: string;
  /** User-authored notes; automatic refresh must not erase these. */
  userNotes: string;
  touchedFiles: string[];
}

export type RuntimeEpochReason = 'started' | 'model_change' | 'provider_handover' | 'conversation_turn';

/** One provider/model segment inside a continuous Praxis session. */
export interface SessionRuntimeEpoch {
  id: string;
  provider?: AiProvider;
  model?: string;
  runtimeSessionId?: string;
  startedAt: string;
  endedAt?: string;
  reason: RuntimeEpochReason;
  tokenUsage?: TokenUsage;
}

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

/** The transport that actually owned a session turn. */
export type AgentRuntimeAdapter = 'acp' | 'gateway' | 'legacy-acp' | 'legacy-gateway';

/** The role an AI session plays in a governed workflow. */
export type WorkflowSessionRole = 'controller' | 'stage';

/** Non-secret launch facts retained for session audit and recovery diagnostics. */
export interface AgentRuntimeLaunch {
  adapter: AgentRuntimeAdapter;
  transport: 'acp' | 'gateway';
  hostId?: string;
  command?: string;
}

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
  /** What actually launched this session; distinct from selected Agent Hub attribution. */
  runtimeLaunch?: AgentRuntimeLaunch;
  /** Tracker connection bound when this issue session was created. */
  connectionId?: string;
  /** Project workspace this interactive session belongs to, when known. */
  projectId?: string;
  /**
   * Set when this session is a governed workflow stage (FX-BF-013). Together
   * these make a session traceable back to the run and node that started it —
   * what lets the Sessions view label it and the run monitor link to it.
   * Absent for ordinary ticket and composer sessions.
   */
  workflowRunId?: string;
  /**
   * Every governed run this interactive session controls, oldest first.
   * `workflowRunId` remains the selected run for backwards compatibility and
   * for the compact inspector summary; this list preserves earlier runs when
   * someone adds another workflow from the same conversation.
   */
  workflowRunIds?: string[];
  workflowNodeId?: string;
  /** The immutable workflow identity selected for this session. */
  workflowId?: string;
  workflowVersion?: number;
  workflowRole?: WorkflowSessionRole;
  /**
   * Set when this session was launched from the Agent Hub (FX-BF-011): the
   * discovered runtime agent it is attributed to, and the skills that were
   * active at launch. Attribution only — the conversation still runs on the
   * session's AI provider.
   */
  /** Agent profile attribution. Legacy records used agentId for a combined profile/host id. */
  agentId?: string;
  profileId?: string;
  hostId?: string;
  activeSkills?: string[];
  skillActivations?: Array<{ skillId: string; mode: 'native' | 'tools' | 'context'; version?: string }>;
  state: AgentTaskState;
  taskDefinition: AgentTaskDefinition;
  /** Ticket/plan purpose captured when the session started. Older records fall back to taskDefinition. */
  purpose?: SessionPurpose;
  /** Living handover brief; absent on records written before FX-BE-115. */
  handoverBrief?: HandoverBrief;
  /** Provider/model segments. Older records have none; current provider/model still apply. */
  runtimeEpochs?: SessionRuntimeEpoch[];
  /** Present only for an explicitly started multi-AI conversation. */
  conversation?: AgentConversation;
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
  /**
   * Tokens this session has consumed, summed across its turns — present only
   * for the API providers whose usage the gateway wire parser reads. ACP
   * defines a `usage_update` (`used` / `size`, i.e. exactly `contextTokens` /
   * `contextLimit` below, plus an optional cost) that could give CLI-hosted
   * agents (Claude Code, Codex) the same figure, but `AcpAgentHost` does not
   * read it yet — so those sessions carry no usage rather than a misleading
   * zero, not because the protocol has nothing to offer.
   */
  tokenUsage?: TokenUsage;
  /**
   * How full the model's context is *right now* — the input-token count of the
   * most recent turn, replaced each turn rather than summed.
   *
   * Deliberately separate from `tokenUsage.inputTokens`, which totals every
   * turn: a session can burn a million tokens across fifty small turns without
   * ever filling its window. Context pressure is the size of the current
   * prompt, and only the latest turn measures that.
   */
  contextTokens?: number;
  /** The active model's context window, when the provider publishes one. */
  contextLimit?: number;
  /**
   * Cumulative cost of the session, when the agent reports one (ACP's
   * `usage_update` carries an optional `cost`). Genuinely cumulative, unlike
   * the `used` figure alongside it — see `contextTokens`.
   */
  cost?: { amount: number; currency: string };
  /**
   * The agent's current task list, when it reports one (ACP's `plan` session
   * update — Claude Code's TodoWrite and Codex's plan tool both surface this
   * way). ACP defines a plan update as a complete snapshot, not a diff: each
   * one replaces the array wholesale, so this is always the latest state, not
   * an append log. Absent for a session that has never reported one, and for
   * every non-ACP provider — the local-tools loop has no equivalent tool.
   */
  taskList?: AgentTaskListItem[];
  boardId?: string;
  /** Explicit session purpose; older records derive this from taskDefinition.kind. */
  mode?: SessionMode;
  /**
   * The agent's own slash commands (ACP's `available_commands_update`),
   * when it reports any — Claude Code and Codex both expose native
   * commands this way. Prefixed "acp" throughout to keep this unambiguous
   * against `mode`/`SessionMode` above, which is Praxis's own chat/analysis/
   * review phase and has nothing to do with the agent's protocol-level state.
   * Absent for a session that has never reported any, and for every
   * non-ACP provider — the local-tools loop has no equivalent.
   */
  acpAvailableCommands?: AgentAvailableCommand[];
  /**
   * The agent's own operating mode (ACP's Session Modes — e.g. "ask" /
   * "architect" / "code"), when the agent advertises any. Read once from
   * `session/new`'s response at session start and kept current via
   * `current_mode_update` (the agent can switch modes on its own, not just
   * in response to `setAcpMode`). `acpCurrentModeId` is one of
   * `acpAvailableModes[].id`, or absent for an agent that never reported
   * modes.
   */
  acpCurrentModeId?: string;
  acpAvailableModes?: AgentModeOption[];
  /** Last failure message or abort reason recorded for this session. */
  lastError?: string;
  /** True when the failure was caused by a provider credit, rate, session, or usage limit. */
  providerLimitReached?: boolean;
}

/** One slash command the agent advertised via `available_commands_update`. */
export interface AgentAvailableCommand {
  name: string;
  description: string;
  /** Placeholder text for the command's argument, when it takes one. */
  inputHint?: string;
}

/** One entry in `AgentSessionRecord.acpAvailableModes` — an ACP Session Mode. */
export interface AgentModeOption {
  id: string;
  name: string;
  description?: string;
}

/** One entry in an agent's self-reported task list — see `AgentSessionRecord.taskList`. */
export interface AgentTaskListItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

/** Default guardrail limits. */
export const AGENT_DEFAULTS = {
  maxSteps: 500,
  timeoutMs: 3 * 60 * 60 * 1000 // 3 hours — delivery workflows can run E2E suites, long builds, and iterative reviews
} as const;
