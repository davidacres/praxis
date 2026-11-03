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

export class TeamChatAcceptanceUnknown extends Error {}

export interface TeamChatExecutionResult {
  text: string;
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
  preparedPrompt?: string;
  nativePrompt?: string;
  signal?: AbortSignal;
}

export interface TeamChatExecutionAdapter {
  summarize?(prompt: string, params: { conversation: DurableConversation; turn: ConversationTurn; participant: ConversationParticipant; signal?: AbortSignal }): Promise<TeamChatExecutionResult>;
  prepare?(params: { conversation: DurableConversation; turn: ConversationTurn; participant: ConversationParticipant }): Promise<TeamChatConfiguration>;
  execute(params: TeamChatExecutionParams): Promise<TeamChatExecutionResult>;
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
  | 'decision_pinned';

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
  contextBudget?: { limit: number; reserved: number };
  repository: TeamChatRepository;
  executionAdapter: TeamChatExecutionAdapter;
  clock?: () => string;
  idSource?: () => string;
  onUpdate?: (update: ConversationUpdate) => void;
}

export class TeamChatCoordinator {
  private readonly contextBudget?: { limit: number; reserved: number };
  private readonly repository: TeamChatRepository;
  private readonly executionAdapter: TeamChatExecutionAdapter;
  private readonly clock: () => string;
  private readonly idSource: () => string;
  private readonly onUpdate?: (update: ConversationUpdate) => void;
  private readonly subscribers = new Map<string, Set<(update: ConversationUpdate) => void>>();
  private readonly activeLoops = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private initialization?: Promise<void>;

  public constructor(options: TeamChatCoordinatorOptions) {
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
        const updated = await this.transitionConversation(conversation.id, current =>
          beginConversationEpoch(current, current.revision, epoch, this.clock()));
        if (updated.turns.some(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))) {
          this.notify({ conversationId: updated.id, revision: updated.revision, type: 'turn_failed',
            turnId: updated.turns.find(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))?.id,
            state: updated.turns.find(turn => ['interrupted', 'outcome_unknown'].includes(turn.state))?.state });
        }
      }
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
    mutate: (current: DurableConversation) => DurableConversation
  ): Promise<DurableConversation> {
    return this.repository.transaction(draft => {
      const index = draft.conversations.findIndex(c => c.id === conversationId);
      if (index < 0) throw new Error(`Conversation ${conversationId} was not found.`);
      const current = draft.conversations[index];
      const next = mutate(structuredClone(current));
      draft.conversations[index] = structuredClone(next);
      return structuredClone(next);
    });
  }

  public async submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult> {
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

    // Validate participants
    if (command.selectedParticipantIds && command.selectedParticipantIds.length > 0) {
      const knownIds = new Set(conversation.participants.map(p => p.id));
      for (const id of command.selectedParticipantIds) {
        if (!knownIds.has(id)) {
          throw new Error('Invalid participant reference.');
        }
      }
    }

    // Resolve roster & member ordering
    const mention = parseAssistantMention(command.text);
    let planParticipants: ConversationParticipant[] = [];

    if (mention.personaId) {
      const p = conversation.participants.find(part => part.role === mention.personaId) ?? makeParticipant(mention.personaId);
      planParticipants = [p];
    } else if (!command.selectedParticipantIds || command.selectedParticipantIds.length === 0) {
      const lead = conversation.participants.find(part => part.role === 'lead') ?? makeParticipant('lead');
      planParticipants = [lead];
    } else {
      const selected = command.selectedParticipantIds
        .map(id => conversation.participants.find(p => p.id === id))
        .filter((p): p is ConversationParticipant => Boolean(p));
      planParticipants = selected.sort((a, b) => {
        const orderA = CANONICAL_ROLE_ORDER.indexOf(a.role);
        const orderB = CANONICAL_ROLE_ORDER.indexOf(b.role);
        return (orderA >= 0 ? orderA : 99) - (orderB >= 0 ? orderB : 99);
      });
    }

    const turnId = this.idSource();
    const userMessageId = this.idSource();
    const sequence = (conversation.messages.at(-1)?.sequence ?? 0) + 1;

    const turn: ConversationTurn = {
      id: turnId,
      commandId: command.commandId,
      payloadDigest,
      userMessageId,
      acceptedSequence: sequence,
      plan: {
        participants: planParticipants,
        runtimeOptions: command.runtimeOptions,
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
      attachments: command.attachmentRefs ?? []
    };

    const updated = await this.transitionConversation(command.conversationId, conv => {
      // Ensure participants in plan exist on the conversation record
      for (const p of planParticipants) {
        if (!conv.participants.some(existing => existing.id === p.id)) {
          conv.participants.push(p);
        }
      }
      return submitConversationTurn(conv, conv.revision, command, turn, userMessage);
    });

    this.notify({
      conversationId: command.conversationId,
      revision: updated.revision,
      type: 'turn_accepted',
      turnId,
      message: userMessage,
      state: 'queued'
    });

    void this.processConversation(command.conversationId);

    return {
      turnId,
      revision: updated.revision,
      state: 'queued'
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

  public async cancelTurn(conversationId: string, turnId: string): Promise<void> {
    await this.initialize();
    const abortKey = `${conversationId}:${turnId}`;
    const controller = this.abortControllers.get(abortKey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(abortKey);
    }

    await this.transitionConversation(conversationId, conv => {
      const turn = conv.turns.find(t => t.id === turnId);
      if (!turn || ['completed', 'cancelled'].includes(turn.state)) return conv;
      turn.state = 'cancelled';
      conv.revision++;
      for (const att of turn.attempts) {
        if (!['completed', 'failed', 'interrupted', 'outcome_unknown'].includes(att.state)) {
          att.state = 'cancelled';
          att.completedAt = this.clock();
        }
      }
      return conv;
    });

    const updated = this.getConversation(conversationId);
    if (updated) {
      this.notify({
        conversationId,
        revision: updated.revision,
        type: 'turn_cancelled',
        turnId,
        state: 'cancelled'
      });
    }

    void this.processConversation(conversationId);
  }

  public async retryParticipant(conversationId: string, turnId: string, participantId: string): Promise<void> {
    await this.initialize();
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} was not found.`);
    const turn = conversation.turns.find(t => t.id === turnId);
    if (!turn || turn.state !== 'failed') {
      throw new Error('Stale or invalid retry target.');
    }
    const lastAttempt = turn.attempts.filter(a => a.participantId === participantId).at(-1);
    if (!lastAttempt || lastAttempt.state !== 'failed') {
      throw new Error('Stale or invalid retry target.');
    }

    await this.transitionConversation(conversationId, conv => {
      const targetTurn = conv.turns.find(t => t.id === turnId);
      if (!targetTurn) return conv;
      targetTurn.state = 'running';
      conv.revision++;
      return conv;
    });

    void this.processConversation(conversationId);
  }

  public async resolveAttempt(
    conversationId: string,
    turnId: string,
    attemptId: string,
    resolution: 'accept' | 'retry' | 'abort'
  ): Promise<void> {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} was not found.`);
    const turn = conversation.turns.find(t => t.id === turnId);
    const attempt = turn?.attempts.find(a => a.id === attemptId);
    if (!turn || !attempt) throw new Error('Stale or invalid retry target.');

    if (resolution === 'abort') {
      await this.cancelTurn(conversationId, turnId);
      return;
    }

    if (resolution === 'retry') {
      await this.retryParticipant(conversationId, turnId, attempt.participantId);
      return;
    }

    if (resolution === 'accept') {
      await this.transitionConversation(conversationId, conv => {
        const t = conv.turns.find(item => item.id === turnId);
        const a = t?.attempts.find(item => item.id === attemptId);
        if (!a || !t || !a.recoveryEvidence?.some(item => item.kind === 'final_result' && item.data?.text)) {
          throw new Error('Cannot accept an attempt without a recovered final result.');
        }
        throw new Error('Recovered result import is required before accepting an attempt.');
      });
      void this.processConversation(conversationId);
    }
  }

  private async processConversation(conversationId: string): Promise<void> {
    if (this.activeLoops.has(conversationId)) return;
    this.activeLoops.add(conversationId);

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
        const nextParticipant = activeTurn.plan.participants.find(p => !activeTurn!.completedParticipantIds.includes(p.id));
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
          prepared = prepareTeamChatContext(conversation, activeTurn, nextParticipant, binding, false, contextLimit, this.contextBudget?.reserved);
          nativePrepared = binding?.deliveredMessageIds.length ? prepareTeamChatContext(conversation, activeTurn, nextParticipant, binding, true, contextLimit, this.contextBudget?.reserved) : prepared;
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
              const summaryAbortKey = `${conversationId}:${activeTurn.id}`;
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
            return reserveConversationAttempt(conv, conv.revision, attempt);
          });
        } catch {
          break;
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
            return advanceConversationAttempt(conv, conv.revision, activeTurn!.id, attemptId, conv.coordinatorEpoch, 'running', this.clock());
          }).then(conv => {
            if (conv.turns.find(t => t.id === activeTurn!.id)?.attempts.find(a => a.id === attemptId)?.state === 'running') {
              this.notify({ conversationId, revision: conv.revision, type: 'attempt_running', turnId: activeTurn!.id, attemptId });
            }
          });
          return acceptance;
        };

        const abortController = new AbortController();
        const abortKey = `${conversationId}:${activeTurn.id}`;
        this.abortControllers.set(abortKey, abortController);

        let executionError: Error | undefined;
        let result: TeamChatExecutionResult | undefined;

        try {
          result = await this.executionAdapter.execute({
            conversation: currentConv,
            onAccepted: accepted,
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
          this.abortControllers.delete(abortKey);
        }

        if (abortController.signal.aborted) {
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
            if (!t || !a) return conv;
            const uncertain = executionError instanceof TeamChatAcceptanceUnknown;
            a.state = uncertain ? 'outcome_unknown' : 'failed';
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
            createdAt: this.clock(),
            sequence: (latestConv!.messages.at(-1)?.sequence ?? 0) + 1,
            attachments: []
          };

          const completedConv = await this.transitionConversation(conversationId, conv => {
            replyMessage.sequence = (conv.messages.at(-1)?.sequence ?? 0) + 1;
            return completeConversationAttempt(
              conv,
              conv.revision,
              activeTurn!.id,
              attemptId,
              conv.coordinatorEpoch,
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
        }
      }
    } finally {
      this.activeLoops.delete(conversationId);
    }
  }
}
