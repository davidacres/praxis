import type {
  AiProvider,
  CancelTurnCommand,
  ConversationCommandResult,
  ConversationControlCommand,
  ConversationControlOutcome,
  DurableConversation,
  ResolveAttemptCommand,
  RetryParticipantCommand,
  SubmitConversationCommand,
  TeamChatRecord,
  TeamChatSummary
} from '@praxis/core';
import type { TeamChatServices } from './teamChatServices';
import type { TeamChatAttachments } from './teamChatAttachments';

export interface TeamChatCommandDeps {
  services: TeamChatServices;
  attachments: () => TeamChatAttachments;
  /** Whether a (non-empty) project ID names a project this profile knows. */
  projectExists: (projectId: string) => boolean;
  activeProvider: () => string;
  assertCanRunAgentSession: (provider: AiProvider) => void;
}

/**
 * The validated command surface behind `AssistantIpc`'s durable team-chat methods. Everything
 * here runs before the coordinator accepts or dispatches anything, so an invalid command never
 * reaches a provider. It is Electron-free so it can be tested on a temporary profile.
 *
 * Nothing ties accepted work to the window that sent it: the coordinator is a process singleton
 * and its updates go to every window, so closing the initiating window cancels nothing.
 */
export function createTeamChatCommands(deps: TeamChatCommandDeps) {
  const { services } = deps;
  const assertProject = (projectId: string | undefined): void => {
    if (projectId && !deps.projectExists(projectId)) throw new Error(`Project ${projectId} was not found.`);
  };
  const conversation = async (id: string): Promise<DurableConversation> => {
    await services.coordinator().initialize();
    const found = services.coordinator().getConversation(id);
    if (!found) throw new Error(`Conversation ${id} was not found.`);
    return found;
  };
  const requireText = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    return value;
  };
  const fenced = (command: { conversationId: string; commandId: string; expectedRevision: number; turnId: string }): void => {
    requireText(command?.conversationId, 'A conversation ID');
    requireText(command.commandId, 'A command ID');
    requireText(command.turnId, 'A turn ID');
    if (typeof command.expectedRevision !== 'number' || !Number.isInteger(command.expectedRevision)) throw new Error('An expected revision is required.');
  };
  const control = async (command: ConversationControlCommand): Promise<ConversationControlOutcome> => {
    await services.activate();
    return services.coordinator().controlWithOutcome(command);
  };

  return {
    async submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult> {
      await services.activate();
      const target = await conversation(requireText(command?.conversationId, 'A conversation ID'));
      assertProject(target.projectId);
      if (command.context?.projectId && target.projectId && command.context.projectId !== target.projectId) {
        throw new Error('Page context belongs to a different project.');
      }
      try {
        await deps.attachments().resolve(command.conversationId, command.attachmentRefs ?? []);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || /Invalid attachment digest/.test(String((error as Error).message))) throw new Error('Unknown attachment reference.');
        throw error;
      }
      if (command.attachmentRefs?.length) {
        const options = command.runtimeOptions ?? {};
        if ((options.mode ?? 'chat') === 'chat' && (options.toolMode ?? 'project-only') === 'project-only') throw new Error('Choose an image-capable agent runtime before attaching images.');
        deps.assertCanRunAgentSession(String(options.provider ?? deps.activeProvider()) as AiProvider);
      }
      return services.submitTurn(command);
    },
    async getConversation(conversationId: string): Promise<DurableConversation | undefined> {
      await services.activate();
      await services.coordinator().initialize();
      return services.coordinator().getConversation(conversationId);
    },
    async listChats(projectId: string): Promise<TeamChatSummary[]> {
      await services.activate();
      return services.store().list(projectId);
    },
    async createChat(projectId: string, issueKey?: string): Promise<TeamChatRecord> {
      await services.activate();
      assertProject(projectId);
      return services.store().create(projectId, issueKey);
    },
    async cancelTurn(command: CancelTurnCommand): Promise<ConversationControlOutcome> {
      fenced(command);
      return control({ conversationId: command.conversationId, commandId: command.commandId, expectedRevision: command.expectedRevision,
        action: 'cancel', turnId: command.turnId, ...(command.attemptId ? { attemptId: command.attemptId } : {}) });
    },
    async retryParticipant(command: RetryParticipantCommand): Promise<ConversationControlOutcome> {
      fenced(command);
      requireText(command.participantId, 'A participant ID');
      requireText(command.attemptId, 'An attempt ID');
      return control({ conversationId: command.conversationId, commandId: command.commandId, expectedRevision: command.expectedRevision,
        action: 'retry', turnId: command.turnId, attemptId: command.attemptId, participantId: command.participantId });
    },
    async resolveAttempt(command: ResolveAttemptCommand): Promise<ConversationControlOutcome> {
      fenced(command);
      requireText(command.attemptId, 'An attempt ID');
      if (command.resolution !== 'reconcile' && command.resolution !== 'retry') throw new Error('Unknown attempt resolution.');
      const base = { conversationId: command.conversationId, commandId: command.commandId, expectedRevision: command.expectedRevision,
        turnId: command.turnId, attemptId: command.attemptId };
      return command.resolution === 'reconcile'
        ? control({ ...base, action: 'reconcile', reconciliationNote: command.reconciliationNote ?? '' })
        : control({ ...base, action: 'retry', acknowledgeDuplicateActionRisk: command.acknowledgeDuplicateActionRisk === true,
          ...(command.reconciliationEvidenceId ? { reconciliationEvidenceId: command.reconciliationEvidenceId } : {}) });
    }
  };
}
export type TeamChatCommands = ReturnType<typeof createTeamChatCommands>;
