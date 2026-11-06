import { appendConversationSummary, latestValidConversationSummary, pinConversationDecision } from './teamChatSummaries';
import { resolveTeamChatBinding, type TeamChatConfiguration } from './teamChatBindings';
import { eligibleTeamChatMessages, prepareTeamChatContext, TeamChatContextRequired } from './teamChatContext';
import { parseAssistantMention, getAssistantPersona } from './assistantPersonas';
import type {
  AssistantRole,
  ConversationAttempt,
  ConversationMessage,
  ConversationParticipant,
  ConversationTurn,
  DurableConversation,
  SubmitConversationCommand,
  ConversationCommandResult,
  TeamChatRepository
} from './assistantTypes';
import {
  advanceConversationAttempt,
  completeConversationAttempt,
  beginConversationEpoch,
  invalidateAttemptApproval,
  settleAttemptApproval,
  recordAttemptApproval,
  resolveAttemptApproval,
  restoreAttemptApproval,
  conversationPayloadDigest,
  reserveConversationAttempt,
  startConversationTurn,
  submitConversationTurn
} from './teamChatTransitions';

export const CANONICAL_ROLE_ORDER: readonly AssistantRole[] = ['dev', 'qa', 'security', 'product', 'lead'];

export function makeParticipant(role: AssistantRole): ConversationParticipant {
  const persona = getAssistantPersona(role);
  return {
    id: `part-${role}`,
    role,
    instructionVersion: '1',
    instructions: persona.systemPrompt,
    defaults: {}
  };
}

function assertKnownParticipants(conversation: DurableConversation, ids: readonly string[] | undefined): void {
  if (!ids?.length) return;
  const knownIds = new Set(conversation.participants.map(p => p.id));
  if (ids.some(id => !knownIds.has(id))) throw new Error('Invalid participant reference.');
}

/** An explicit mention selects only that member; no selection means lead; otherwise canonical role order. */
function resolvePlanParticipants(conversation: DurableConversation, command: SubmitConversationCommand): ConversationParticipant[] {
  const mention = parseAssistantMention(command.text);
  if (mention.personaId) {
    return [conversation.participants.find(p => p.role === mention.personaId) ?? makeParticipant(mention.personaId)];
  }
  if (!command.selectedParticipantIds?.length) {
    return [conversation.participants.find(p => p.role === 'lead') ?? makeParticipant('lead')];
  }
  const rank = (role: AssistantRole) => {
    const index = CANONICAL_ROLE_ORDER.indexOf(role);
    return index >= 0 ? index : 99;
  };
  return command.selectedParticipantIds
    .map(id => conversation.participants.find(p => p.id === id))
    .filter((p): p is ConversationParticipant => Boolean(p))
    .sort((a, b) => rank(a.role) - rank(b.role));
}

export class TeamChatAcceptanceUnknown extends Error {}

/** The transition refused an attempt reservation; distinct from a storage fault. */
class ReservationRejected extends Error {
  constructor(readonly rejection: unknown) {
    super(rejection instanceof Error ? rejection.message : String(rejection));
  }
}

export interface TeamChatExecutionResult {
  text: string;
  choices?: import('./assistantTypes').AssistantChoiceOption[];
  proposedAction?: import('./assistantTypes').AssistantProposedAction;
  error?: boolean;
  contextDelivery?: 'native' | 'reconstruction';
  providerSessionId?: string;
  reportedCost?: { currency: string; amount: number };
  usage?: import('../gateway/wire').TokenUsage;
  usageReferences?: string[];
  toolEvidenceReferences?: string[];
}

export interface TeamChatExecutionParams {
  conversation: DurableConversation;
  turn: ConversationTurn;
  attempt: ConversationAttempt;
  participant: ConversationParticipant;
  messages: readonly ConversationMessage[];
  onAccepted?: () => Promise<void>;
  onEvidence?: (evidence: Pick<import('./assistantTypes').ConversationRecoveryEvidence, 'kind' | 'provenance' | 'data'>) => Promise<void>;
  /** Report a runtime permission request (with its stable id) or its resolution. */
  onApproval?: (approval: { runtimeRequestId: string; resolved?: boolean }) => Promise<void>;
  preparedPrompt?: string;
  nativePrompt?: string;
  signal?: AbortSignal;
}

export interface TeamChatExecutionAdapter {
  validateAttachments?(conversationId: string, messages: readonly ConversationMessage[]): Promise<void>;
  summarize?(prompt: string, params: { conversation: DurableConversation; turn: ConversationTurn; participant: ConversationParticipant; signal?: AbortSignal }): Promise<TeamChatExecutionResult>;
  prepare?(params: { conversation: DurableConversation; turn: ConversationTurn; participant: ConversationParticipant }): Promise<TeamChatConfiguration>;
  execute(params: TeamChatExecutionParams): Promise<TeamChatExecutionResult>;
  /** Live runtime permission requests for an attempt; absence or failure means nothing can be restored. */
  listLiveApprovals?(attempt: ConversationAttempt): Promise<readonly { requestId: string; attemptId: string }[]>;
}

export type ConversationUpdateType =
  | 'turn_accepted'
  | 'turn_started'
  | 'attempt_prepared'
  | 'attempt_running'
  | 'attempt_completed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'context_required'
  | 'decision_pinned'
  | 'approval_restored'
  | 'approval_invalidated'
  /** A committed revision no typed update reported; subscribers re-read the snapshot. */
  | 'revision_committed';

export interface ConversationUpdate {
  conversationId: string;
  revision: number;
  type: ConversationUpdateType;
  turnId?: string;
  attemptId?: string;
  message?: ConversationMessage;
  state?: ConversationTurn['state'];
  error?: string;
}

export interface TeamChatCoordinatorOptions {
  captureRuntimeOptions?: (options: Readonly<Record<string, string | number | boolean>>) => Readonly<Record<string, string | number | boolean>>;
  contextBudget?: { limit: number; reserved: number };
  repository: TeamChatRepository;
  executionAdapter: TeamChatExecutionAdapter;
  clock?: () => string;
  idSource?: () => string;
  onUpdate?: (update: ConversationUpdate) => void;
}

export class TeamChatCoordinator {
  private readonly captureRuntimeOptions?: TeamChatCoordinatorOptions['captureRuntimeOptions'];
  private readonly contextBudget?: { limit: number; reserved: number };
  private readonly repository: TeamChatRepository;
  private readonly executionAdapter: TeamChatExecutionAdapter;
  private readonly clock: () => string;
  private readonly idSource: () => string;
  private readonly onUpdate?: (update: ConversationUpdate) => void;
  private readonly subscribers = new Map<string, Set<(update: ConversationUpdate) => void>>();
  private readonly activeLoops = new Set<string>();
  /** Conversations whose loop stopped on a storage fault; see `processConversation`. */
  private readonly haltedLoops = new Map<string, string>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** Highest revision each conversation's subscribers have been told about. */
  private readonly notifiedRevisions = new Map<string, number>();
  private initialization?: Promise<void>;

  public constructor(options: TeamChatCoordinatorOptions) {
    this.captureRuntimeOptions = options.captureRuntimeOptions;
    this.contextBudget = options.contextBudget;
    this.repository = options.repository;
    this.executionAdapter = options.executionAdapter;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idSource = options.idSource ?? (() => `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.onUpdate = options.onUpdate;
  }

  /** Persist a new generation once before accepting scheduling work. */
  public initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const epoch = this.idSource();
      const snapshot = this.repository.read();
      for (const conversation of snapshot.conversations) {
        let updated = await this.transitionConversation(conversation.id, current =>
          beginConversationEpoch(current, current.revision, epoch, this.clock()),
          { touchUpdatedAt: false });
        for (const turn of updated.turns) {
          const attempt = turn.attempts.at(-1);
          if (attempt && ['prepared', 'dispatching', 'running', 'awaiting_approval', 'interrupted', 'outcome_unknown', 'failed'].includes(attempt.state) &&
              attempt.recoveryEvidence?.some(e => e.kind === 'final_result' && typeof (e.result?.text ?? e.data?.text) === 'string')) {
            await this.importRecoveredResult(updated.id, turn.id, attempt.id);
          }
        }
        for (const turn of updated.turns) {
          const attempt = turn.attempts.at(-1);
          if (attempt?.pendingApproval?.status !== 'invalidated') continue;
          const requestId = attempt.pendingApproval.runtimeRequestId;
          let live: readonly { requestId: string; attemptId: string }[] = [];
          try { live = await this.executionAdapter.listLiveApprovals?.(attempt) ?? []; } catch { live = []; }
          // A live request must name this attempt; one without an attempt identity is never restored.
          const match = live.some(item => item.requestId === requestId && item.attemptId === attempt.id);
          if (match) {
            const restored = await this.transitionConversation(updated.id, current =>
              restoreAttemptApproval(current, current.revision, turn.id, attempt.id, current.coordinatorEpoch, requestId, this.clock()),
              { touchUpdatedAt: false });
            this.notify({ conversationId: restored.id, revision: restored.revision, type: 'approval_restored', turnId: turn.id, attemptId: attempt.id });
          } else {
            this.notify({ conversationId: updated.id, revision: updated.revision, type: 'approval_invalidated', turnId: turn.id, attemptId: attempt.id });
          }
        }
        updated = this.getConversation(updated.id)!;
        if (updated.turns.some(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))) {
          this.notify({ conversationId: updated.id, revision: updated.revision, type: 'turn_failed',
            turnId: updated.turns.find(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))?.id,
            state: updated.turns.find(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))?.state });
        }
      }
      for (const conversation of this.repository.read().conversations) void this.processConversation(conversation.id);
    })();
    return this.initialization;
  }

  public subscribe(conversationId: string, listener: (update: ConversationUpdate) => void): () => void {
    let listeners = this.subscribers.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(conversationId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.subscribers.delete(conversationId);
      }
    };
  }

  private notify(update: ConversationUpdate): void {
    this.notifiedRevisions.set(update.conversationId, Math.max(this.notifiedRevisions.get(update.conversationId) ?? -1, update.revision));
    try {
      this.onUpdate?.(update);
    } catch {
      // Ignored
    }
    const listeners = this.subscribers.get(update.conversationId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(update);
        } catch {
          // Listeners must not break coordinator operation
        }
      }
    }
  }

  public getConversation(conversationId: string): DurableConversation | undefined {
    return this.repository.read().conversations.find(c => c.id === conversationId);
  }

  private async transitionConversation(
    conversationId: string,
    mutate: (current: DurableConversation) => DurableConversation,
    options?: { touchUpdatedAt?: boolean }
  ): Promise<DurableConversation> {
    return this.repository.transaction(draft => {
      const index = draft.conversations.findIndex(c => c.id === conversationId);
      if (index < 0) throw new Error(`Conversation ${conversationId} was not found.`);
      const current = draft.conversations[index];
      const next = mutate(structuredClone(current));
      const touchUpdatedAt = options?.touchUpdatedAt ?? true;
      if (touchUpdatedAt && next.revision > current.revision) next.updatedAt = this.clock();
      if (draft.activation && next.turns.length > current.turns.length) draft.activation.acceptedNewTurns = true;
      draft.conversations[index] = structuredClone(next);
      return structuredClone(next);
    }).then(committed => {
      // Snapshots carry state, so every committed revision must reach subscribers. Most commits
      // are followed by a typed update; a commit with none (binding, attempt bookkeeping) would
      // leave a window holding a stale revision whose next control is refused as stale.
      if (committed.revision > (this.notifiedRevisions.get(conversationId) ?? -1)) {
        setTimeout(() => {
          if (committed.revision > (this.notifiedRevisions.get(conversationId) ?? -1)) {
            this.notify({ conversationId, revision: committed.revision, type: 'revision_committed' });
          }
        }, 0);
      }
      return committed;
    });
  }

  public async submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult> {
    command = structuredClone(command);
    await this.initialize();
    if (!command.conversationId?.trim()) throw new Error('A conversationId is required.');
    if (!command.commandId?.trim()) throw new Error('A commandId is required.');
    if (!command.text?.trim()) throw new Error('A message text is required.');

    // Validate permission choice
    if (command.runtimeOptions?.permissionMode !== undefined && !['manual', 'auto', 'bypass', 'autopilot'].includes(String(command.runtimeOptions.permissionMode))) {
      throw new Error('Invalid permission choice.');
    }
    if (command.runtimeOptions?.toolMode !== undefined && !['full', 'read-only', 'project-only'].includes(String(command.runtimeOptions.toolMode))) throw new Error('Invalid tool mode.');
    if (command.runtimeOptions?.mode !== undefined && !['chat', 'analysis', 'review'].includes(String(command.runtimeOptions.mode))) throw new Error('Invalid execution mode.');

    // Validate attachment references
    if (command.attachmentRefs) {
      for (const att of command.attachmentRefs) {
        if (!att || !att.digest || typeof att.digest !== 'string' || !att.mediaType) {
          throw new Error('Invalid attachment reference.');
        }
      }
    }

    const snapshot = this.repository.read();
    const conversation = snapshot.conversations.find(c => c.id === command.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${command.conversationId} was not found.`);
    }

    const payloadDigest = conversationPayloadDigest(command);
    const existingReceipt = conversation.commandReceipts.find(r => r.commandId === command.commandId);
    if (existingReceipt) {
      if (existingReceipt.payloadDigest !== payloadDigest) {
        throw new Error('Command payload conflict.');
      }
      const existingTurn = conversation.turns.find(t => t.id === existingReceipt.turnId);
      return {
        turnId: existingReceipt.turnId,
        revision: conversation.revision,
        state: existingTurn?.state ?? 'completed'
      };
    }

    // Cheap pre-check; the authoritative check repeats inside the transaction.
    assertKnownParticipants(conversation, command.selectedParticipantIds);

    // Side effects (IDs, settings reads) happen before the transaction so the
    // mutation stays synchronous. Everything that depends on the conversation's
    // current state — roster, plan, sequence — is resolved against the draft, so
    // two sends queued behind each other each see the other's committed turn.
    const turnId = this.idSource();
    const userMessageId = this.idSource();
    const runtimeOptions = this.captureRuntimeOptions?.(command.runtimeOptions) ?? command.runtimeOptions;

    const updated = await this.transitionConversation(command.conversationId, conv => {
      const receipt = conv.commandReceipts.find(r => r.commandId === command.commandId);
      if (receipt) {
        if (receipt.payloadDigest !== payloadDigest) throw new Error('Command payload conflict.');
        return conv;
      }
      assertKnownParticipants(conv, command.selectedParticipantIds);
      const planParticipants = resolvePlanParticipants(conv, command);
      const sequence = (conv.messages.at(-1)?.sequence ?? 0) + 1;

      const turn: ConversationTurn = {
        id: turnId,
        commandId: command.commandId,
        payloadDigest,
        userMessageId,
        acceptedSequence: sequence,
        plan: {
          participants: planParticipants,
          runtimeOptions,
          ...(command.context ? { context: command.context } : {})
        },
        state: 'queued',
        completedParticipantIds: [],
        attempts: []
      };

      const userMessage: ConversationMessage = {
        id: userMessageId,
        turnId,
        role: 'user',
        text: command.text,
        createdAt: this.clock(),
        sequence,
        attachments: command.attachmentRefs ?? [],
        ...(command.context ? { context: command.context, contextTitle: command.context.title } : {})
      };

      // Ensure participants in plan exist on the conversation record
      for (const p of planParticipants) {
        if (!conv.participants.some(existing => existing.id === p.id)) {
          conv.participants.push(p);
        }
      }
      // Appending does not target a mutable attempt; concurrent windows may enqueue.
      if (conv.title === 'New team chat') conv.title = command.text.trim().slice(0, 80);
      return submitConversationTurn(conv, conv.revision, command, turn, userMessage);
    });

    const acceptedTurn = updated.turns.find(t => t.id === updated.commandReceipts.find(r => r.commandId === command.commandId)!.turnId)!;
    if (acceptedTurn.id !== turnId) {
      // A concurrent delivery of the same command won; it already announced the turn.
      return { turnId: acceptedTurn.id, revision: updated.revision, state: acceptedTurn.state };
    }
    const acceptedMessage = updated.messages.find(m => m.id === acceptedTurn.userMessageId)!;
    this.notify({
      conversationId: command.conversationId,
      revision: updated.revision,
      type: 'turn_accepted',
      turnId: acceptedTurn.id,
      message: acceptedMessage,
      state: 'queued'
    });

    void this.processConversation(command.conversationId);

    return {
      turnId: acceptedTurn.id,
      revision: updated.revision,
      state: acceptedTurn.state
    };
  }

  public async pinDecision(conversationId: string, messageId: string, supersedesMessageId?: string): Promise<void> {
    const updated = await this.transitionConversation(conversationId, conv => {
      pinConversationDecision(conv, messageId, supersedesMessageId);
      conv.revision++;
      return conv;
    });
    this.notify({ conversationId, revision: updated.revision, type: 'decision_pinned' });
  }

  /** Revision and target fencing plus the command receipt commit in one transaction. */
  public async control(command: import('./assistantTypes').ConversationControlCommand): Promise<DurableConversation> {
    return (await this.controlWithOutcome(command)).conversation;
  }

  /**
   * As `control`, but says what happened: `applied`, `duplicate` (the same command ID was already
   * committed), or `conflict` with the reason. The conversation is always the fresh committed state.
   */
  public async controlWithOutcome(command: import('./assistantTypes').ConversationControlCommand): Promise<import('./assistantTypes').ConversationControlOutcome> {
    command = structuredClone(command);
    await this.initialize();
    if (!['cancel', 'retry', 'pin', 'unpin', 'resume-context', 'reconcile'].includes(command.action)) throw new Error('Invalid conversation control.');
    const digest = conversationPayloadDigest(command);
    let applied = false;
    let rejection: { status: 'duplicate' } | { status: 'conflict'; reason: 'stale-revision' | 'stale-target' | 'not-actionable' } | undefined;
    const reject = (conv: DurableConversation, reason: 'stale-revision' | 'stale-target' | 'not-actionable') => {
      rejection = { status: 'conflict', reason };
      return conv;
    };
    const updated = await this.transitionConversation(command.conversationId, conv => {
      const receipt = conv.controlReceipts?.find(r => r.commandId === command.commandId);
      if (receipt) {
        if (receipt.payloadDigest !== digest) throw new Error('Command payload conflict.');
        rejection = { status: 'duplicate' };
        return conv;
      }
      if (conv.revision !== command.expectedRevision) return reject(conv, 'stale-revision');
      if (!command.commandId.trim()) throw new Error('Command ID required.');
      const turn = conv.turns.find(t => t.id === command.turnId);
      const attempt = turn?.attempts.at(-1);
      if (command.attemptId && attempt?.id !== command.attemptId) return reject(conv, 'stale-target');
      if (command.action === 'retry' && command.participantId && attempt?.participantId !== command.participantId) return reject(conv, 'stale-target');
      if (command.action === 'pin') pinConversationDecision(conv, command.messageId!);
      else if (command.action === 'unpin') conv.pinnedMessageIds = conv.pinnedMessageIds.filter(id => id !== command.messageId);
      else {
        if (!turn) throw new Error('Turn not found.');
        if (command.action === 'cancel') {
          if (['completed', 'cancelled'].includes(turn.state)) return reject(conv, 'not-actionable');
          const active = attempt && ['dispatching', 'running', 'awaiting_approval'].includes(attempt.state);
          turn.state = active ? 'cancelling' : turn.state === 'outcome_unknown' ? 'outcome_unknown' : 'cancelled';
          turn.skippedParticipantIds = turn.plan.participants.filter(p => !turn.completedParticipantIds.includes(p.id) && p.id !== (active ? attempt.participantId : undefined)).map(p => p.id);
          if (attempt?.state === 'prepared') attempt.state = 'cancelled';
          if (attempt) invalidateAttemptApproval(attempt);
        } else if (command.action === 'reconcile') {
          if (turn.state !== 'outcome_unknown' || !attempt || attempt.id !== command.attemptId || !command.reconciliationNote?.trim()) throw new Error('Describe the reconciliation for the unknown attempt.');
          (attempt.recoveryEvidence ??= []).push({ id: command.commandId, conversationId: conv.id, turnId: turn.id,
            participantId: attempt.participantId, attemptId: attempt.id, coordinatorEpoch: attempt.coordinatorEpoch,
            kind: 'reconciliation', observedAt: this.clock(), provenance: 'user', data: { note: command.reconciliationNote.trim() } });
        } else if (command.action === 'resume-context') {
          if (turn.state !== 'context_required') return reject(conv, 'not-actionable');
          turn.state = 'running';
          delete turn.contextRequiredReason;
        } else if (command.action === 'retry') {
          if (!attempt || attempt.id !== command.attemptId) return reject(conv, 'stale-target');
          if (!['failed', 'interrupted', 'outcome_unknown'].includes(turn.state)) return reject(conv, 'not-actionable');
          if (turn.state === 'outcome_unknown') {
            if (!command.acknowledgeDuplicateActionRisk || !attempt.recoveryEvidence?.some(e => e.id === command.reconciliationEvidenceId && e.kind === 'reconciliation')) throw new Error('Acknowledge duplicate-action risk after reconciliation.');
            attempt.recoveryEvidence.push({ id: command.commandId, conversationId: conv.id, turnId: turn.id,
              participantId: attempt.participantId, attemptId: attempt.id, coordinatorEpoch: attempt.coordinatorEpoch,
              kind: 'decision', observedAt: this.clock(), provenance: 'user', data: { retryKind: 'user-authorized-unknown', acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: command.reconciliationEvidenceId! } });
          }
          const binding = conv.bindings.find(b => b.id === attempt.bindingId);
          if (binding) binding.status = 'invalid';
          turn.state = 'running';
        }
      }
      conv.revision++;
      (conv.controlReceipts ??= []).push({ commandId: command.commandId, payloadDigest: digest, revision: conv.revision });
      applied = true;
      return conv;
    });
    if (applied) {
      if (command.action === 'cancel' && command.turnId) this.abortTurn(command.conversationId, command.turnId);
      this.notify({ conversationId: updated.id, revision: updated.revision, type: 'turn_accepted' });
      void this.processConversation(updated.id);
    }
    return rejection ? { ...rejection, conversation: updated } : { status: 'applied', conversation: updated };
  }

  private abortTurn(conversationId: string, turnId: string): void {
    const prefix = `${conversationId}:${turnId}:`;
    for (const [key, controller] of this.abortControllers) if (key.startsWith(prefix)) controller.abort();
  }

  public async removeConversation(conversationId: string): Promise<void> {
    for (const [key, controller] of this.abortControllers) if (key.startsWith(`${conversationId}:`)) controller.abort();
    await this.repository.transaction(draft => {
      draft.conversations = draft.conversations.filter(c => c.id !== conversationId);
      draft.teamChats = draft.teamChats.filter(c => c.id !== conversationId);
    });
  }

  public async cancelTurn(conversationId: string, turnId: string): Promise<void> {
    await this.initialize();
    // Persist the intent before signalling the runtime. An abort request is not
    // evidence that an external tool did not execute.
    const updated = await this.transitionConversation(conversationId, conv => {
      const turn = conv.turns.find(t => t.id === turnId);
      if (!turn || ['completed', 'cancelled'].includes(turn.state)) return conv;
      const queuedOnly = turn.state === 'queued';
      turn.skippedParticipantIds = turn.plan.participants.filter(p => !turn.completedParticipantIds.includes(p.id) &&
        !turn.attempts.some(a => a.participantId === p.id && ['dispatching', 'running', 'awaiting_approval', 'outcome_unknown'].includes(a.state))).map(p => p.id);
      const active = turn.attempts.find(a => ['dispatching', 'running', 'awaiting_approval'].includes(a.state));
      turn.state = active ? 'cancelling' : turn.state === 'outcome_unknown' ? 'outcome_unknown' : 'cancelled';
      for (const a of turn.attempts) invalidateAttemptApproval(a);
      for (const a of turn.attempts) if (a.state === 'prepared') {
        a.state = 'cancelled';
        a.completedAt = this.clock();
      }
      if (!queuedOnly) for (const queued of conv.turns) if (queued.state === 'queued') {
        queued.state = 'cancelled';
        queued.skippedParticipantIds = queued.plan.participants.map(p => p.id);
      }
      conv.revision++;
      return conv;
    });
    this.abortTurn(conversationId, turnId);
    this.notify({ conversationId, revision: updated.revision, type: 'turn_cancelled', turnId,
      state: updated.turns.find(t => t.id === turnId)?.state });
    void this.processConversation(conversationId);
  }

  public async retryParticipant(conversationId: string, turnId: string, participantId: string): Promise<void> {
    await this.initialize();
    await this.transitionConversation(conversationId, conv => {
      const targetTurn = conv.turns.find(t => t.id === turnId);
      const lastAttempt = targetTurn?.attempts.at(-1);
      if (targetTurn?.state === 'outcome_unknown' || lastAttempt?.state === 'outcome_unknown') throw new Error('Unknown outcome: use resolveAttempt with reconciliation evidence and duplicate-risk acknowledgement.');
      if (!targetTurn || !['failed', 'interrupted'].includes(targetTurn.state) ||
          !lastAttempt || lastAttempt.participantId !== participantId ||
          !['failed', 'interrupted'].includes(lastAttempt.state)) throw new Error('Stale or invalid retry target.');
      targetTurn.state = 'running';
      const binding = conv.bindings.find(b => b.id === lastAttempt.bindingId);
      if (binding) binding.status = 'invalid';
      conv.revision++;
      return conv;
    });

    void this.processConversation(conversationId);
  }

  public async resolveAttempt(
    conversationId: string,
    turnId: string,
    attemptId: string,
    resolution: 'accept' | 'retry' | 'abort',
    options?: { acknowledgeDuplicateActionRisk: boolean; reconciliationEvidenceId: string }
  ): Promise<void> {
    await this.initialize();
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} was not found.`);
    const turn = conversation.turns.find(t => t.id === turnId);
    const attempt = turn?.attempts.find(a => a.id === attemptId);
    if (!turn || !attempt || (resolution === 'retry' && turn.attempts.at(-1)?.id !== attemptId)) throw new Error('Stale or invalid retry target.');

    if (resolution === 'abort') {
      await this.cancelTurn(conversationId, turnId);
      return;
    }

    if (resolution === 'retry') {
      if (attempt.state === 'outcome_unknown') {
        await this.transitionConversation(conversationId, conv => {
          const t = conv.turns.find(item => item.id === turnId);
          const a = t?.attempts.at(-1);
          if (!t || t.state !== 'outcome_unknown' || a?.id !== attemptId ||
              !options?.acknowledgeDuplicateActionRisk || !a.recoveryEvidence?.some(e =>
                e.id === options.reconciliationEvidenceId && e.kind === 'reconciliation' && e.attemptId === a.id)) {
            throw new Error('Unknown outcome retry requires reconciliation evidence and duplicate-action risk acknowledgement.');
          }
          a.recoveryEvidence.push({ id: this.idSource(), conversationId, turnId, participantId: a.participantId,
            attemptId, coordinatorEpoch: a.coordinatorEpoch, observingEpoch: conv.coordinatorEpoch, kind: 'decision', observedAt: this.clock(),
            provenance: 'user', data: { retryKind: 'user-authorized-unknown', acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: options.reconciliationEvidenceId } });
          const binding = conv.bindings.find(b => b.id === a.bindingId);
          if (binding) binding.status = 'invalid';
          t.state = 'running';
          conv.revision++;
          return conv;
        });
        void this.processConversation(conversationId);
        return;
      }
      await this.retryParticipant(conversationId, turnId, attempt.participantId);
      return;
    }

    if (resolution === 'accept') {
      await this.importRecoveredResult(conversationId, turnId, attemptId);
      void this.processConversation(conversationId);
    }
  }

  private async importRecoveredResult(conversationId: string, turnId: string, attemptId: string): Promise<void> {
    await this.transitionConversation(conversationId, conv => {
      const t = conv.turns.find(item => item.id === turnId);
      const a = t?.attempts.find(item => item.id === attemptId);
      if (a?.state === 'completed' && a.resultMessageId) return conv;
      const evidence = a?.recoveryEvidence?.find(item => item.kind === 'final_result' && typeof (item.result?.text ?? item.data?.text) === 'string');
      if (!a || !t || !evidence) {
        throw new Error('Cannot accept an attempt without a recovered final result.');
      }
      const result = evidence.result ?? { text: String(evidence.data!.text) };
      return completeConversationAttempt(conv, conv.revision, turnId, attemptId, a.coordinatorEpoch,
        { id: this.idSource(), turnId, participantId: a.participantId,
          role: t.plan.participants.find(p => p.id === a.participantId)!.role,
          text: result.text,
            ...(result.choices ? { choices: result.choices } : {}),
            ...(result.proposedAction ? { proposedAction: result.proposedAction } : {}),
            ...(result.error ? { error: true } : {}),
          ...(t.plan.context ? { context: t.plan.context } : {}), createdAt: this.clock(), sequence: (conv.messages.at(-1)?.sequence ?? 0) + 1, attachments: [] },
        result.contextDelivery === 'native' ? a.nativeContextReceipt! : a.contextReceipt, result, evidence.id);
      });
  }

  private async processConversation(conversationId: string): Promise<void> {
    if (this.activeLoops.has(conversationId)) return;
    const halted = this.haltedLoops.get(conversationId);
    if (halted !== undefined) {
      // Commands still commit; only dispatch waits for startup recovery.
      this.reportLoopStop(conversationId, halted);
      return;
    }
    this.activeLoops.add(conversationId);
    const loopEpoch = this.getConversation(conversationId)?.coordinatorEpoch;

    try {
      while (true) {
        let conversation = this.getConversation(conversationId);
        if (!conversation) break;

        // Check for an active running turn
        let activeTurn = conversation.turns.find(t => t.state === 'running');

        if (!activeTurn) {
          // If no running turn, see if the next queued turn can start
          const hasFailedOrPausedTurn = conversation.turns.some(t => !['queued', 'completed', 'cancelled'].includes(t.state));
          if (hasFailedOrPausedTurn) {
            // Failures and pauses block subsequent queued turns
            break;
          }

          const nextQueuedTurn = conversation.turns.find(t => t.state === 'queued');
          if (!nextQueuedTurn) {
            // No more work queued
            break;
          }

          const started = await this.transitionConversation(conversationId, conv => {
            return startConversationTurn(conv, conv.revision, nextQueuedTurn.id);
          });

          this.notify({
            conversationId,
            revision: started.revision,
            type: 'turn_started',
            turnId: nextQueuedTurn.id,
            state: 'running'
          });

          conversation = started;
          activeTurn = conversation.turns.find(t => t.id === nextQueuedTurn.id);
        }

        if (!activeTurn || activeTurn.state !== 'running') {
          break;
        }

        // Find next participant
        const nextParticipant = activeTurn.plan.participants.find(p => !activeTurn!.completedParticipantIds.includes(p.id) && !activeTurn!.skippedParticipantIds?.includes(p.id));
        if (!nextParticipant) {
          // Turn completed
          await this.transitionConversation(conversationId, conv => {
            const t = conv.turns.find(item => item.id === activeTurn!.id);
            if (t && t.state !== 'completed') {
              t.state = 'completed';
              conv.revision++;
            }
            return conv;
          });
          const updated = this.getConversation(conversationId);
          if (updated) {
            this.notify({
              conversationId,
              revision: updated.revision,
              type: 'turn_completed',
              turnId: activeTurn.id,
              state: 'completed'
            });
          }
          continue; // Process next queued turn
        }

        // Prepare attempt
        const attemptId = this.idSource();
        const ordinal = activeTurn.attempts.filter(a => a.participantId === nextParticipant.id).length + 1;
        const visibleMessages = eligibleTeamChatMessages(conversation, activeTurn);
        let prepared;
        let nativePrepared;
        let binding: import('./assistantTypes').ConversationBinding | undefined;
        let contextLimit = this.contextBudget?.limit;
        try {
          if (this.executionAdapter.prepare) {
            const configuration = await this.executionAdapter.prepare({ conversation, turn: activeTurn, participant: nextParticipant });
            contextLimit = configuration.contextLimit ?? contextLimit;
            conversation = await this.transitionConversation(conversationId, conv => {
              binding = resolveTeamChatBinding(conv.bindings, configuration, this.idSource());
              conv.revision++;
              return conv;
            });
          }
          if (visibleMessages.some(m => m.attachments.length)) await this.executionAdapter.validateAttachments?.(conversationId, visibleMessages);
          prepared = prepareTeamChatContext(conversation, activeTurn, nextParticipant, binding, false, contextLimit, this.contextBudget?.reserved, Boolean(this.executionAdapter.validateAttachments));
          nativePrepared = binding?.deliveredMessageIds.length ? prepareTeamChatContext(conversation, activeTurn, nextParticipant, binding, true, contextLimit, this.contextBudget?.reserved, Boolean(this.executionAdapter.validateAttachments)) : prepared;
        } catch (error) {
          if (error instanceof TeamChatContextRequired && error.reason === 'budget' && this.executionAdapter.summarize && (conversation.summaryAttempts?.length ?? 0) < 8) {
            const eligible = visibleMessages.filter(m => m.turnId !== activeTurn!.id && !conversation!.pinnedMessageIds.includes(m.id));
            const previous = latestValidConversationSummary(conversation, new Set(visibleMessages.map(m => m.id)));
            const summaryBudget = Math.min(16000, (contextLimit ?? 32768) - 8192 - 1024);
            let prompt = previous ? `Previous summary:\n${previous.text}\n` : '';
            let end = previous?.sourceEnd ?? 0;
            for (const message of eligible.filter(m => m.sequence > end)) {
              const next = `\n[${message.id}] ${message.role}: ${message.text}`;
              if (Buffer.byteLength(prompt + next) > summaryBudget) break;
              prompt += next;
              end = message.sequence;
            }
            if (end > (previous?.sourceEnd ?? 0)) {
              const source = visibleMessages.filter(m => m.turnId !== activeTurn!.id && m.sequence <= end &&
                (!conversation!.pinnedMessageIds.includes(m.id) || previous?.sourceMessageIds?.includes(m.id)));
              const sourceDigest = conversationPayloadDigest(source);
              const summaryAttemptId = this.idSource();
              const provider = binding?.providerRuntime ?? 'configured';
              await this.transitionConversation(conversationId, conv => {
                conv.summaryAttempts ??= [];
                conv.summaryAttempts.push({ id: summaryAttemptId, provider, state: 'dispatching', sourceDigest });
                conv.revision++;
                return conv;
              });
              let reportedSummary: TeamChatExecutionResult | undefined;
              const summaryAbort = new AbortController();
              const summaryAbortKey = `${conversationId}:${activeTurn.id}:summary`;
              this.abortControllers.set(summaryAbortKey, summaryAbort);
              try {
                const summary = await this.executionAdapter.summarize(prompt, { conversation, turn: activeTurn, participant: nextParticipant, signal: summaryAbort.signal });
                reportedSummary = summary;
                if (!summary.text.trim() || Buffer.byteLength(summary.text) > 4000) throw new Error('Summary exceeded its bounded output budget.');
                await this.transitionConversation(conversationId, conv => {
                  const attempt = conv.summaryAttempts!.find(a => a.id === summaryAttemptId)!;
                  attempt.state = 'completed';
                  if (summary.usage) attempt.usage = summary.usage;
                  appendConversationSummary(conv, { id: this.idSource(), version: (conv.summaries.at(-1)?.version ?? 0) + 1,
                    sourceStart: source[0].sequence, sourceEnd: end, sourceMessageIds: source.map(m => m.id), sourceDigest, text: summary.text,
                    attemptId: summaryAttemptId, provider, ...(previous ? { supersedesId: previous.id } : {}) });
                  conv.revision++;
                  return conv;
                });
                continue;
              } catch (summaryError) {
                await this.transitionConversation(conversationId, conv => {
                  const attempt = conv.summaryAttempts!.find(a => a.id === summaryAttemptId)!;
                  attempt.state = 'failed';
                  if (reportedSummary?.usage) attempt.usage = reportedSummary.usage;
                  attempt.error = String(summaryError);
                  conv.revision++;
                  return conv;
                });
              } finally {
                if (this.abortControllers.get(summaryAbortKey) === summaryAbort) this.abortControllers.delete(summaryAbortKey);
              }
            }
          }
          const paused = await this.transitionConversation(conversationId, conv => {
            const turn = conv.turns.find(t => t.id === activeTurn!.id)!;
            if (turn.state !== 'running') return conv;
            turn.state = 'context_required';
            turn.contextRequiredReason = error instanceof Error ? error.message : String(error);
            conv.revision++;
            return conv;
          });
          if (paused.turns.find(t => t.id === activeTurn!.id)?.state === 'context_required') this.notify({ conversationId, revision: paused.revision, type: 'context_required', turnId: activeTurn.id,
            state: 'context_required', error: error instanceof Error ? error.message : String(error) });
          break;
        }
        const contextReceipt = prepared.receipt;

        const attempt: ConversationAttempt = {
          id: attemptId,
          turnId: activeTurn.id,
          participantId: nextParticipant.id,
          ordinal,
          coordinatorEpoch: conversation.coordinatorEpoch,
          state: 'prepared',
          ...(binding ? { bindingId: binding.id } : {}),
          contextReceipt,
          nativeContextReceipt: nativePrepared.receipt,
          createdAt: this.clock(),
          usageReferences: [],
          toolEvidenceReferences: []
        };

        const checkTurnBefore = this.getConversation(conversationId)?.turns.find(t => t.id === activeTurn!.id);
        if (!checkTurnBefore || checkTurnBefore.state !== 'running') {
          break;
        }

        let currentConv: DurableConversation;
        try {
          currentConv = await this.transitionConversation(conversationId, conv => {
            const t = conv.turns.find(item => item.id === activeTurn!.id);
            if (!t || t.state !== 'running') return conv;
            try {
              return reserveConversationAttempt(conv, conv.revision, attempt);
            } catch (rejection) {
              throw new ReservationRejected(rejection);
            }
          });
        } catch (error) {
          // A refused reservation stops this pass quietly. A storage fault (before or
          // after the rename) must reach the halting handler so it is reported.
          if (error instanceof ReservationRejected) break;
          throw error;
        }

        if (currentConv.turns.find(t => t.id === activeTurn!.id)?.state !== 'running') {
          break;
        }

        // Intent is durable before sending; running requires provider acceptance evidence.
        const dispatchTime = this.clock();
        currentConv = await this.transitionConversation(conversationId, conv =>
          advanceConversationAttempt(conv, conv.revision, activeTurn!.id, attemptId, conv.coordinatorEpoch, 'dispatching', dispatchTime));
        let acceptance: Promise<void> | undefined;
        const accepted = (): Promise<void> => {
          acceptance ??= this.transitionConversation(conversationId, conv => {
            const target = conv.turns.find(t => t.id === activeTurn!.id);
            if (target?.state !== 'running' || target.attempts.find(a => a.id === attemptId)?.state !== 'dispatching') return conv;
            return advanceConversationAttempt(conv, conv.revision, activeTurn!.id, attemptId, attempt.coordinatorEpoch, 'running', this.clock());
          }).then(conv => {
            if (conv.turns.find(t => t.id === activeTurn!.id)?.attempts.find(a => a.id === attemptId)?.state === 'running') {
              this.notify({ conversationId, revision: conv.revision, type: 'attempt_running', turnId: activeTurn!.id, attemptId });
            }
          });
          return acceptance;
        };

        const abortController = new AbortController();
        const abortKey = `${conversationId}:${activeTurn.id}:${attemptId}`;
        this.abortControllers.set(abortKey, abortController);

        let executionError: Error | undefined;
        let result: TeamChatExecutionResult | undefined;

        try {
          result = await this.executionAdapter.execute({
            conversation: currentConv,
            onAccepted: accepted,
            onEvidence: async evidence => {
              await this.transitionConversation(conversationId, conv => {
                const t = conv.turns.find(t => t.id === activeTurn!.id);
                const a = t?.attempts.find(a => a.id === attemptId);
                if (!a || !t || !['running', 'cancelling'].includes(t.state) || conv.coordinatorEpoch !== attempt.coordinatorEpoch ||
                    a.coordinatorEpoch !== attempt.coordinatorEpoch || t.attempts.at(-1)?.id !== attemptId) throw new Error('Fenced runtime evidence.');
                a.recoveryEvidence ??= [];
                a.recoveryEvidence.push({ ...evidence, id: this.idSource(), conversationId, turnId: t.id,
                  participantId: a.participantId, attemptId, coordinatorEpoch: a.coordinatorEpoch, observedAt: this.clock() });
                conv.revision++;
                return conv;
              });
            },
            onApproval: async approval => {
              await accepted();
              await this.transitionConversation(conversationId, conv => approval.resolved
                ? resolveAttemptApproval(conv, conv.revision, activeTurn!.id, attemptId, attempt.coordinatorEpoch, approval.runtimeRequestId)
                : recordAttemptApproval(conv, conv.revision, activeTurn!.id, attemptId, attempt.coordinatorEpoch, approval.runtimeRequestId, this.clock()));
            },
            turn: activeTurn,
            attempt,
            participant: nextParticipant,
            messages: visibleMessages,
            preparedPrompt: prepared.prompt,
            nativePrompt: nativePrepared.prompt,
            signal: abortController.signal
          });
          await accepted();
        } catch (err) {
          executionError = err instanceof Error ? err : new Error(String(err));
        } finally {
          if (this.abortControllers.get(abortKey) === abortController) this.abortControllers.delete(abortKey);
        }

        if (abortController.signal.aborted) {
          await this.transitionConversation(conversationId, conv => {
            const t = conv.turns.find(t => t.id === activeTurn!.id);
            const a = t?.attempts.find(a => a.id === attemptId);
            if (!t || !a || t.state !== 'cancelling' || a.coordinatorEpoch !== attempt.coordinatorEpoch ||
                conv.coordinatorEpoch !== attempt.coordinatorEpoch) return conv;
            a.recoveryEvidence ??= [];
            const textOnly = a.recoveryEvidence.some(e => e.kind === 'runtime_identity' && e.data?.toolCapable === false);
            a.recoveryEvidence.push({ id: this.idSource(), conversationId, turnId: t.id, participantId: a.participantId,
              attemptId, coordinatorEpoch: a.coordinatorEpoch, kind: 'reconciliation', observedAt: this.clock(),
              provenance: 'execution-settled-after-abort', data: { executionSettled: true, externalOutcomeUnknown: !textOnly } });
            if (result) a.recoveryEvidence.push({ id: this.idSource(), conversationId, turnId: t.id,
              participantId: a.participantId, attemptId, coordinatorEpoch: a.coordinatorEpoch,
              kind: 'final_result', observedAt: this.clock(), provenance: 'execution-adapter-after-abort', result });
            a.state = textOnly && !result ? 'cancelled' : 'outcome_unknown';
            settleAttemptApproval(a, 'invalidated');
            a.completedAt = this.clock();
            t.state = a.state;
            conv.revision++;
            return conv;
          });
          if (result) await this.importRecoveredResult(conversationId, activeTurn.id, attemptId);
          const settled = this.getConversation(conversationId);
          if (settled) this.notify({ conversationId, revision: settled.revision, type: 'turn_cancelled', turnId: activeTurn.id,
            state: settled.turns.find(t => t.id === activeTurn!.id)?.state });
          break;
        }

        const latestConv = this.getConversation(conversationId);
        const latestTurn = latestConv?.turns.find(t => t.id === activeTurn!.id);
        if (!latestTurn || latestTurn.state === 'cancelled') {
          break;
        }

        if (executionError) {
          // Failure pauses the current turn and leaves later turns queued
          await this.transitionConversation(conversationId, conv => {
            const t = conv.turns.find(item => item.id === activeTurn!.id);
            const a = t?.attempts.find(item => item.id === attemptId);
            if (!t || !a || t.state !== 'running' || a.coordinatorEpoch !== attempt.coordinatorEpoch ||
                conv.coordinatorEpoch !== attempt.coordinatorEpoch || t.attempts.at(-1)?.id !== attemptId) return conv;
            const uncertain = executionError instanceof TeamChatAcceptanceUnknown;
            a.state = uncertain ? 'outcome_unknown' : 'failed';
            settleAttemptApproval(a, 'invalidated');
            const binding = conv.bindings.find(b => b.id === a.bindingId);
            if (binding) binding.status = 'invalid';
            a.error = executionError!.message;
            a.completedAt = this.clock();
            t.state = uncertain ? 'outcome_unknown' : 'failed';
            conv.revision++;
            return conv;
          });

          const failedConv = this.getConversation(conversationId);
          if (failedConv) {
            this.notify({
              conversationId,
              revision: failedConv.revision,
              type: 'turn_failed',
              turnId: activeTurn.id,
              attemptId,
              error: executionError.message,
              state: executionError instanceof TeamChatAcceptanceUnknown ? 'outcome_unknown' : 'failed'
            });
          }
          break; // Stop loop on failure
        }

        if (result) {
          const checkTurn = this.getConversation(conversationId)?.turns.find(t => t.id === activeTurn!.id);
          const checkAttempt = checkTurn?.attempts.find(a => a.id === attemptId);
          if (!checkTurn || checkTurn.state === 'cancelled' || !checkAttempt || checkAttempt.state === 'cancelled') {
            break;
          }

          const replyMessage: ConversationMessage = {
            id: this.idSource(),
            turnId: activeTurn.id,
            participantId: nextParticipant.id,
            role: nextParticipant.role,
            text: result.text,
            ...(result.choices ? { choices: result.choices } : {}),
            ...(result.proposedAction ? { proposedAction: result.proposedAction } : {}),
            ...(result.error ? { error: true } : {}),
            createdAt: this.clock(),
            sequence: (latestConv!.messages.at(-1)?.sequence ?? 0) + 1,
            attachments: [],
            ...(activeTurn.plan.context ? { context: activeTurn.plan.context } : {})
          };

          await this.transitionConversation(conversationId, conv => {
            const a = conv.turns.find(t => t.id === activeTurn!.id)?.attempts.find(a => a.id === attemptId);
            if (!a || conv.coordinatorEpoch !== attempt.coordinatorEpoch || a.coordinatorEpoch !== attempt.coordinatorEpoch) throw new Error('Fenced result.');
            a.recoveryEvidence ??= [];
            a.recoveryEvidence.push({ id: this.idSource(), conversationId, turnId: activeTurn!.id,
              participantId: a.participantId, attemptId, coordinatorEpoch: a.coordinatorEpoch,
              kind: 'final_result', observedAt: this.clock(), provenance: 'execution-adapter', result });
            conv.revision++;
            return conv;
          });
          const completedConv = await this.transitionConversation(conversationId, conv => {
            replyMessage.sequence = (conv.messages.at(-1)?.sequence ?? 0) + 1;
            return completeConversationAttempt(
              conv,
              conv.revision,
              activeTurn!.id,
              attemptId,
              attempt.coordinatorEpoch,
              replyMessage,
              result.contextDelivery === 'native' ? nativePrepared.receipt : contextReceipt,
              result
            );
          });

          this.notify({
            conversationId,
            revision: completedConv.revision,
            type: 'attempt_completed',
            turnId: activeTurn.id,
            attemptId,
            message: replyMessage
          });
          // The last member's reply completes the turn in the same transaction, so the loop's own
          // completion branch never sees it: announce it here, at the same revision.
          if (completedConv.turns.find(t => t.id === activeTurn!.id)?.state === 'completed') {
            this.notify({ conversationId, revision: completedConv.revision, type: 'turn_completed', turnId: activeTurn.id, state: 'completed' });
          }
        }
      }
    } catch (error) {
      // Deletion removes the authoritative identity, and a newer epoch fences this
      // loop's attempt; in both cases late callbacks may only drain.
      const current = this.getConversation(conversationId);
      if (!current || current.coordinatorEpoch !== loopEpoch) return;
      // This loop runs detached, so a storage fault must be reported, not left as an
      // unhandled rejection. What did commit stays durable for startup recovery.
      //
      // A fault can leave an attempt `running` with an unknown outcome. Only startup
      // recovery (a new epoch) may reconcile it: re-entering the loop here cannot make
      // progress, because reservation refuses a second attempt while one is open, and it
      // would stop silently. So dispatch halts and every later command is told why.
      // Later queued turns stay queued: they were accepted and never ran, so they are
      // neither failed nor retried here, and startup recovery dispatches them in order.
      const message = error instanceof Error ? error.message : String(error);
      this.haltedLoops.set(conversationId, message);
      this.reportLoopStop(conversationId, message);
    } finally {
      this.activeLoops.delete(conversationId);
    }
  }

  /** Tell subscribers dispatch stopped; never throws, because the loop runs detached. */
  private reportLoopStop(conversationId: string, message: string): void {
    try {
      console.error(`Team chat ${conversationId} stopped: ${message}`);
      const current = this.getConversation(conversationId);
      if (!current) return;
      const turn = current.turns.find(t => !['queued', 'completed', 'cancelled'].includes(t.state));
      this.notify({ conversationId, revision: current.revision, type: 'turn_failed', ...(turn ? { turnId: turn.id, state: turn.state } : {}),
        error: `${message} Restart Praxis to recover this team chat.` });
    } catch {
      // Reporting is best effort; the committed state is what startup recovery reads.
    }
  }
}
