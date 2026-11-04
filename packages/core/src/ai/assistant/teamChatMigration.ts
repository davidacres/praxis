import type { DurableConversation, TeamChatRecord, TeamChatSnapshot } from './assistantTypes';
import { CANONICAL_ROLE_ORDER, makeParticipant } from './teamChatCoordinator';

/** No provider binding can be inferred from transcript text or a synthetic key. */
export function importLegacyTeamChat(chat: TeamChatRecord): DurableConversation {
  const ids = new Set<string>();
  let boundary = 'orphan';
  return {
    ...structuredClone(chat), schemaVersion: 2, revision: 0, coordinatorEpoch: 'imported',
    participants: CANONICAL_ROLE_ORDER.map(makeParticipant),
    messages: chat.messages.map((message, index) => {
      if (!message.id || ids.has(message.id)) throw new Error('Duplicate legacy message identity.');
      ids.add(message.id);
      if (message.role === 'user') boundary = message.id;
      return { ...structuredClone(message), sequence: index + 1, turnId: `legacy:${boundary}`,
        provenance: boundary === 'orphan' ? 'imported-unknown' as const : 'imported' as const, attachments: [] };
    }),
    turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: []
  };
}

/** Convert the complete candidate, never schedule imported history or invent attempts. */
export function migrateTeamChats(source: TeamChatSnapshot): TeamChatSnapshot {
  if (source.schemaVersion !== 2) throw new Error('Unsupported conversation version.');
  if (source.activation?.version === 1) return structuredClone(source);
  const ids = new Set(source.conversations.map(chat => chat.id));
  for (const chat of source.teamChats) {
    if (ids.has(chat.id)) throw new Error('Conversation identity collision.');
    ids.add(chat.id);
  }
  return { ...structuredClone(source), teamChats: [],
    conversations: [...structuredClone(source.conversations), ...source.teamChats.map(importLegacyTeamChat)],
    activation: { version: 1, acceptedNewTurns: false } };
}
