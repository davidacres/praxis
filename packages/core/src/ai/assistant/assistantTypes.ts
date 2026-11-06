/** The five specialist seats on the virtual engineering team. */
export type AssistantRole = 'lead' | 'dev' | 'qa' | 'security' | 'product';

/** Who authored a message in a team chat. */
export type AssistantSpeaker = AssistantRole | 'user';

/** The kind of surface a page context describes. */
export type AssistantPageType = 'board' | 'issue' | 'git' | 'workflow' | 'workflow-run' | 'project' | 'general';

export interface AssistantPersona {
  id: AssistantRole;
  /** Display name, e.g. "QA Specialist". */
  name: string;
  /** Short badge text, e.g. "QA". */
  badge: string;
  role: AssistantRole;
  /** A renderer `IconName`; kept a plain string so core stays UI-free. */
  icon: string;
  /** Names a `--persona-<tone>` colour token in the renderer's theme. */
  tone: AssistantRole;
  systemPrompt: string;
}

/** What the page the user is looking at advertises to the assistant. */
export interface PageAssistantContext {
  pageType: AssistantPageType;
  entityId?: string;
  /** Short label for the context pill, e.g. "Issue PRX-12". */
  title: string;
  /** One or two lines the model reads first. */
  summary: string;
  /** Serialized page state (markdown/JSON text). Truncated before it is sent. */
  data?: string;
  projectId?: string;
  issueKey?: string;
  /** Quick prompts shown as chips. */
  suggestedPrompts?: string[];
}

export interface AssistantChoiceOption {
  label: string;
  /** Sent back into the conversation as the user's next message. */
  prompt: string;
}

export type AssistantProposedAction =
  | { kind: 'update-workflow'; label: string; summary: string; workflow: unknown }
  | { kind: 'update-ticket'; label: string; summary: string; description: string }
  /** A new child task under the ticket the user is looking at. */
  | { kind: 'create-subtask'; label: string; summary: string; title: string; description: string }
  | { kind: 'delegate-session'; label: string; summary: string; prompt: string };

export interface AssistantMessage {
  id: string;
  role: AssistantSpeaker;
  text: string;
  createdAt: string;
  /** Page the message was written against, for the feed's context hint. */
  contextTitle?: string;
  choices?: AssistantChoiceOption[];
  proposedAction?: AssistantProposedAction;
  /** Set on a failed turn so the feed can style it as an error. */
  error?: boolean;
}

export interface AssistantTurnRequest {
  message: string;
  /** Persona to answer when the message carries no `@mention`. Defaults to `lead`. */
  personaId?: AssistantRole;
  context?: PageAssistantContext;
  history?: readonly AssistantMessage[];
}

export interface AssistantTurnResult {
  messages: AssistantMessage[];
}

export interface AssistantTeamReviewRequest {
  prompt?: string;
  context?: PageAssistantContext;
  history?: readonly AssistantMessage[];
}

export interface TeamChatRecord {
  id: string;
  projectId: string;
  title: string;
  issueKey?: string;
  createdAt: string;
  updatedAt: string;
  messages: AssistantMessage[];
}

/** A chat without its transcript, for the sidebar list. */
export type TeamChatSummary = Omit<TeamChatRecord, 'messages'> & { messageCount: number; personas: AssistantRole[] };

/** Versioned authoritative state; legacy transcripts remain readable until migration. */
export interface ConversationParticipant {
  id: string;
  role: AssistantRole;
  instructionVersion: string;
  instructions: string;
  defaults: Readonly<Record<string, string | number | boolean>>;
}
export type ConversationTurnState = 'queued' | 'running' | 'completed' | 'awaiting_approval' | 'context_required' | 'failed' | 'interrupted' | 'outcome_unknown' | 'cancelling' | 'cancelled';
export type ConversationAttemptState = 'prepared' | 'dispatching' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'interrupted' | 'outcome_unknown' | 'cancelled';
export interface ConversationAttachment { id: string; digest: string; mediaType: string; size: number; }
export interface ConversationMessage extends AssistantMessage {
  provenance?: 'imported' | 'imported-unknown';
  sequence: number;
  turnId: string;
  participantId?: string;
  attachments: ConversationAttachment[];
  context?: PageAssistantContext;
}
export interface ConversationContextReceipt { digest: string; messageIds: string[]; bindingId?: string; instructionVersion?: string; summaryId?: string; budget?: { limit: number; reserved: number; estimated: number; method: string }; }
export interface ConversationAttempt {
  id: string;
  turnId: string;
  participantId: string;
  ordinal: number;
  coordinatorEpoch: string;
  state: ConversationAttemptState;
  bindingId?: string;
  providerSessionId?: string;
  nativeContextReceipt?: ConversationContextReceipt;
  contextReceipt: ConversationContextReceipt;
  dispatchIntent?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
  resultMessageId?: string;
  reportedCost?: { currency: string; amount: number };
  usage?: import('../gateway/wire').TokenUsage;
  usageReferences: string[];
  toolEvidenceReferences: string[];
  /** Durable observations gathered for recovery; absence is never proof of non-execution. */
  recoveryEvidence?: ConversationRecoveryEvidence[];
  /** Runtime permission request this attempt is blocked on; it is never reassigned to another attempt. */
  pendingApproval?: ConversationPendingApproval;
}
export interface ConversationPendingApproval {
  runtimeRequestId: string;
  requestedAt: string;
  coordinatorEpoch: string;
  status: 'pending' | 'invalidated' | 'restored' | 'resolved';
  /** Epoch that verified a live matching runtime request. */
  restoredEpoch?: string;
}
export interface ConversationRecoveryEvidence {
  id: string;
  conversationId: string;
  turnId: string;
  participantId: string;
  attemptId: string;
  coordinatorEpoch: string;
  /** Epoch observing this evidence; coordinatorEpoch always identifies the originating attempt. */
  observingEpoch?: string;
  result?: import('./teamChatCoordinator').TeamChatExecutionResult;
  kind: 'partial_output' | 'tool_activity' | 'final_result' | 'runtime_identity' | 'reconciliation' | 'decision';
  observedAt: string;
  provenance: string;
  data?: Readonly<Record<string, string | number | boolean>>;
}
export interface ConversationTurn {
  id: string;
  commandId: string;
  payloadDigest: string;
  userMessageId: string;
  acceptedSequence: number;
  plan: { participants: ConversationParticipant[]; runtimeOptions: Readonly<Record<string, string | number | boolean>>; context?: PageAssistantContext };
  state: ConversationTurnState;
  contextRequiredReason?: string;
  completedParticipantIds: string[];
  skippedParticipantIds?: string[];
  attempts: ConversationAttempt[];
}
export interface ConversationBinding {
  id: string;
  conversationId: string;
  participantId: string;
  providerRuntime: string;
  providerSessionId?: string;
  compatibilityDigest: string;
  deliveredMessageIds: string[];
  nativeOutputMessageIds: string[];
  summarizedMessageIds?: string[];
  summaryId?: string;
  status: 'valid' | 'invalid';
}
export interface ConversationSummary {
  sourceMessageIds?: string[];
  id: string; version: number; sourceStart: number; sourceEnd: number; sourceDigest: string;
  text: string; attemptId: string; provider: string; supersedesId?: string;
}
/**
 * What main observed about one pre-durable runtime session record, gathered after the
 * activation fence settles. No title, goal or reply text: migration may not use them.
 */
export interface LegacyRuntimeSessionEvidence {
  issueKey: string;
  provider?: string;
  model?: string;
  state: string;
  definitionOfDone?: string;
  /** `detail` of every "Virtual Team transcript checkpoint" info event: the persona reply it saw last. */
  checkpointMessageIds: string[];
}
/**
 * A proven association between an imported conversation member and the runtime session that
 * served it before cutover. It is a record, never a binding: the legacy configuration digest
 * cannot be checked against today's runtime, so the next turn always binds fresh and rebuilds.
 */
export interface LegacyRuntimeLink {
  runtimeSessionKey: string;
  conversationId: string;
  participantId: string;
  role: AssistantRole;
  provider?: string;
  legacyConfigurationDigest: string;
  checkpointMessageId: string;
  status: 'imported';
}
export type LegacyRuntimeDiagnosticReason = 'unknown-conversation' | 'not-virtual-team' | 'no-checkpoint';
export interface ConversationCommandReceipt {
  commandId: string; payloadDigest: string; turnId: string; revision: number; outcome: 'accepted';
}
export interface DurableConversation extends Omit<TeamChatRecord, 'messages' | 'projectId'> {
  schemaVersion: 2;
  projectId?: string;
  revision: number;
  coordinatorEpoch: string;
  participants: ConversationParticipant[];
  messages: ConversationMessage[];
  turns: ConversationTurn[];
  bindings: ConversationBinding[];
  summaries: ConversationSummary[];
  summaryAttempts?: { id: string; provider: string; state: 'dispatching' | 'completed' | 'failed'; sourceDigest: string; usage?: import('../gateway/wire').TokenUsage; error?: string }[];
  decisionCorrections?: { messageId: string; supersedesMessageId: string }[];
  pinnedMessageIds: string[];
  controlReceipts?: { commandId: string; payloadDigest: string; revision: number }[];
  commandReceipts: ConversationCommandReceipt[];
  /** Runtime sessions migration proved served this chat; never consulted when binding. */
  legacyRuntimeLinks?: LegacyRuntimeLink[];
}
export interface TeamChatSnapshot {
  /** Unprovable legacy associations stay available for forward repair, never dispatched. */
  legacyDiagnostics?: { id: string; completedAt: string; context?: PageAssistantContext; messages: AssistantMessage[] }[];
  /** Legacy-shaped runtime sessions migration could not prove; the records themselves are kept. */
  legacyRuntimeDiagnostics?: { runtimeSessionKey: string; reason: LegacyRuntimeDiagnosticReason }[];
  activation?: { version: 1; acceptedNewTurns: boolean };
  schemaVersion: 2;
  revision: number;
  teamChats: TeamChatRecord[];
  conversations: DurableConversation[];
}
/** The repository owns serialization, isolation and durable publication. */
export interface TeamChatRepository {
  read(): TeamChatSnapshot;
  transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T>;
}

export interface SubmitConversationCommand {
  conversationId: string;
  commandId: string;
  expectedRevision: number;
  text: string;
  selectedParticipantIds: string[];
  context?: PageAssistantContext;
  attachmentRefs: ConversationAttachment[];
  runtimeOptions: Readonly<Record<string, string | number | boolean>>;
}
export interface ConversationCommandResult {
  turnId: string;
  revision: number;
  state: ConversationTurnState;
}

export interface ConversationControlCommand {
  conversationId: string;
  commandId: string;
  expectedRevision: number;
  action: 'cancel' | 'retry' | 'pin' | 'unpin' | 'resume-context' | 'reconcile';
  turnId?: string;
  attemptId?: string;
  /** Retry only: the member the caller believes is next. A mismatch is a stale target. */
  participantId?: string;
  messageId?: string;
  acknowledgeDuplicateActionRisk?: boolean;
  reconciliationEvidenceId?: string;
  reconciliationNote?: string;
}
/**
 * Every control command answers with the fresh committed conversation. A stale command is not a
 * silent no-op: it is a `conflict` naming why, so the caller can tell it apart from success.
 */
export type ConversationControlOutcome =
  | { status: 'applied' | 'duplicate'; conversation: DurableConversation }
  | { status: 'conflict'; reason: 'stale-revision' | 'stale-target' | 'not-actionable'; conversation: DurableConversation };
/** Stop an active turn, or cancel one still queued. */
export interface CancelTurnCommand { conversationId: string; commandId: string; expectedRevision: number; turnId: string; attemptId?: string }
/** Retry the member whose latest attempt failed or was interrupted. */
export interface RetryParticipantCommand { conversationId: string; commandId: string; expectedRevision: number; turnId: string; participantId: string; attemptId: string }
/** Resolve an `outcome_unknown` attempt: record what was checked, or retry after accepting the duplicate-action risk. */
export interface ResolveAttemptCommand {
  conversationId: string; commandId: string; expectedRevision: number; turnId: string; attemptId: string;
  resolution: 'reconcile' | 'retry';
  reconciliationNote?: string;
  acknowledgeDuplicateActionRisk?: boolean;
  reconciliationEvidenceId?: string;
}