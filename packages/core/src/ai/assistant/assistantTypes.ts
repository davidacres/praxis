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
  commandReceipts: ConversationCommandReceipt[];
}
export interface TeamChatSnapshot {
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
