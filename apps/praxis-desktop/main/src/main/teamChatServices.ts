import * as fs from 'node:fs';
import { TeamChatStore, type ConversationCommandResult, type LegacyRuntimeSessionEvidence, type SubmitConversationCommand, type TeamChatCoordinator } from '@praxis/core';
import { FileTeamChatRepository } from './adapters/teamChatRepository';
import { TeamChatActivation } from './teamChatActivation';

export interface TeamChatServicesOptions {
  filePath: () => string;
  enabled: boolean;
  createCoordinator: (repository: FileTeamChatRepository) => TeamChatCoordinator;
  /**
   * Pre-durable runtime session records, read only once legacy work has quiesced so a
   * still-running legacy turn's session is included. Migration links only what it can prove.
   */
  legacyRuntimeEvidence?: () => Promise<LegacyRuntimeSessionEvidence[]>;
}

/** One profile's durable team-chat storage, activation fence and coordinator, created lazily. */
export function createTeamChatServices(options: TeamChatServicesOptions) {
  const activation = new TeamChatActivation(options.enabled);
  let repository: FileTeamChatRepository | undefined;
  let store: TeamChatStore | undefined;
  let coordinator: TeamChatCoordinator | undefined;
  const services = {
    activation,
    repository: (): FileTeamChatRepository => (repository ??= new FileTeamChatRepository(options.filePath())),
    store: (): TeamChatStore => (store ??= new TeamChatStore(services.repository())),
    coordinator: (): TeamChatCoordinator => (coordinator ??= options.createCoordinator(services.repository())),
    activate: (): Promise<void> => activation.activate(async () => {
      // An activated profile ignores evidence, so skip loading legacy transcripts at all.
      const evidence = services.repository().read().activation ? [] : await options.legacyRuntimeEvidence?.() ?? [];
      await services.repository().activate(evidence);
    }),
    /** Durable dispatch only ever runs behind a successful activation. */
    async submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult> {
      await services.activate();
      return services.coordinator().submitTurn(command);
    },
    /**
     * Start a new coordinator epoch at launch: reconcile interrupted attempts, then resume
     * queued work, without waiting for a window to open the chat. A profile that has never
     * activated durable chat is left alone (activation stays with the first chat request).
     */
    async recoverOnStartup(): Promise<boolean> {
      if (!options.enabled || !fs.existsSync(options.filePath())) return false;
      if (!services.repository().read().activation) return false;
      await services.activate();
      await services.coordinator().initialize();
      return true;
    }
  };
  return services;
}
export type TeamChatServices = ReturnType<typeof createTeamChatServices>;
