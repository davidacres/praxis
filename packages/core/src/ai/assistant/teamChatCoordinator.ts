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

export interface TeamChatExecutionResult {
  text: string;
  usageReferences?: string[];
  toolEvidenceReferences?: string[];
}

export interface TeamChatExecutionParams {
  conversation: DurableConversation;
  turn: ConversationTurn;
  attempt: ConversationAttempt;
  participant: ConversationParticipant;
  messages: readonly ConversationMessage[];
  signal?: AbortSignal;
}

export interface TeamChatExecutionAdapter {
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
  | 'turn_cancelled';

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
  repository: TeamChatRepository;
  executionAdapter: TeamChatExecutionAdapter;
  clock?: () => string;
  idSource?: () => string;
  onUpdate?: (update: ConversationUpdate) => void;
}

export class TeamChatCoordinator {
  private readonly repository: TeamChatRepository;
  private readonly executionAdapter: TeamChatExecutionAdapter;
  private readonly clock: () => string;
  private readonly idSource: () => string;
  private readonly onUpdate?: (update: ConversationUpdate) => void;
  private readonly subscribers = new Map<string, Set<(update: ConversationUpdate) => void>>();
  private readonly activeLoops = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  public constructor(options: TeamChatCoordinatorOptions) {
    this.repository = options.repository;
    this.executionAdapter = options.executionAdapter;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idSource = options.idSource ?? (() => `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.onUpdate = options.onUpdate;
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
    if (!command.conversationId?.trim()) throw new Error('A conversationId is required.');
    if (!command.commandId?.trim()) throw new Error('A commandId is required.');
    if (!command.text?.trim()) throw new Error('A message text is required.');

    // Validate permission choice
    if (command.runtimeOptions?.permissionMode === ('invalid' as never)) {
      throw new Error('Invalid permission choice.');
    }

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

  public async cancelTurn(conversationId: string, turnId: string): Promise<void> {
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
        if (!a || !t) return conv;
        a.state = 'completed';
        a.completedAt = this.clock();
        if (!t.completedParticipantIds.includes(a.participantId)) {
          t.completedParticipantIds.push(a.participantId);
        }
        if (t.completedParticipantIds.length === t.plan.participants.length) {
          t.state = 'completed';
        }
        conv.revision++;
        return conv;
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
        const visibleMessages = conversation.messages.filter(m => m.sequence < activeTurn!.acceptedSequence || m.turnId === activeTurn!.id);
        const messageIds = visibleMessages.map(m => m.id);
        const contextDigest = conversationPayloadDigest({
          turnId: activeTurn.id,
          participantId: nextParticipant.id,
          ordinal,
          messageIds
        });
        const contextReceipt = {
          digest: contextDigest,
          messageIds
        };

        const attempt: ConversationAttempt = {
          id: attemptId,
          turnId: activeTurn.id,
          participantId: nextParticipant.id,
          ordinal,
          coordinatorEpoch: conversation.coordinatorEpoch,
          state: 'prepared',
          contextReceipt,
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

        // Advance to dispatching then running
        const dispatchTime = this.clock();
        currentConv = await this.transitionConversation(conversationId, conv => {
          const step1 = advanceConversationAttempt(conv, conv.revision, activeTurn!.id, attemptId, conv.coordinatorEpoch, 'dispatching', dispatchTime);
          return advanceConversationAttempt(step1, step1.revision, activeTurn!.id, attemptId, step1.coordinatorEpoch, 'running', dispatchTime);
        });

        this.notify({
          conversationId,
          revision: currentConv.revision,
          type: 'attempt_running',
          turnId: activeTurn.id,
          attemptId
        });

        const abortController = new AbortController();
        const abortKey = `${conversationId}:${activeTurn.id}`;
        this.abortControllers.set(abortKey, abortController);

        let executionError: Error | undefined;
        let result: TeamChatExecutionResult | undefined;

        try {
          result = await this.executionAdapter.execute({
            conversation: currentConv,
            turn: activeTurn,
            attempt,
            participant: nextParticipant,
            messages: visibleMessages,
            signal: abortController.signal
          });
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
            a.state = 'failed';
            a.error = executionError!.message;
            a.completedAt = this.clock();
            t.state = 'failed';
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
              state: 'failed'
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
            sequence: (currentConv.messages.at(-1)?.sequence ?? 0) + 1,
            attachments: []
          };

          const completedConv = await this.transitionConversation(conversationId, conv => {
            return completeConversationAttempt(
              conv,
              conv.revision,
              activeTurn!.id,
              attemptId,
              conv.coordinatorEpoch,
              replyMessage,
              contextReceipt
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
