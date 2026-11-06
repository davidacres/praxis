import type {
  AssistantRole, DurableConversation, LegacyRuntimeDiagnosticReason, LegacyRuntimeLink, LegacyRuntimeSessionEvidence,
  TeamChatRecord, TeamChatSnapshot
} from './assistantTypes';
import { CANONICAL_ROLE_ORDER, makeParticipant } from './teamChatCoordinator';

/** The pre-durable runtime key: `ASSISTANT-<chatId>-<persona>-<16-hex configuration digest>`. */
const LEGACY_RUNTIME_KEY = /^ASSISTANT-(.+)-(lead|dev|qa|security|product)-([0-9a-f]{16})$/;
/** Every pre-durable Virtual Team runtime session carried exactly this definition of done. */
export const LEGACY_VIRTUAL_TEAM_DEFINITION_OF_DONE = 'Respond to the Virtual Team chat with the result.';

export type LegacyRuntimeClassification =
  | { kind: 'ignored' }
  | { kind: 'link'; link: LegacyRuntimeLink }
  | { kind: 'diagnostic'; reason: LegacyRuntimeDiagnosticReason };

/**
 * Proof is structural only — never a title, goal or reply text. A legacy session links to a
 * chat when its key names that chat's exact id, it is a Virtual Team session, and one of its
 * transcript checkpoints is a non-error reply by the same persona in that chat.
 */
export function classifyLegacyRuntimeSession(
  evidence: LegacyRuntimeSessionEvidence, legacyChatsById: ReadonlyMap<string, TeamChatRecord>
): LegacyRuntimeClassification {
  const match = LEGACY_RUNTIME_KEY.exec(evidence.issueKey);
  if (!match) return { kind: 'ignored' };
  const [, chatId, role, digest] = match as unknown as [string, string, AssistantRole, string];
  if (evidence.definitionOfDone !== LEGACY_VIRTUAL_TEAM_DEFINITION_OF_DONE) return { kind: 'diagnostic', reason: 'not-virtual-team' };
  const chat = legacyChatsById.get(chatId);
  if (!chat) return { kind: 'diagnostic', reason: 'unknown-conversation' };
  const replies = new Set(chat.messages.filter(message => message.role === role && !message.error).map(message => message.id));
  const checkpoint = [...evidence.checkpointMessageIds].reverse().find(id => replies.has(id));
  if (!checkpoint) return { kind: 'diagnostic', reason: 'no-checkpoint' };
  return { kind: 'link', link: { runtimeSessionKey: evidence.issueKey, conversationId: chat.id, participantId: makeParticipant(role).id, role,
    ...(evidence.provider ? { provider: evidence.provider } : {}), legacyConfigurationDigest: digest, checkpointMessageId: checkpoint, status: 'imported' } };
}

/** Bindings are never inferred; proven legacy runtime sessions are attached as typed links by `migrateTeamChats`. */
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

/**
 * Convert the complete candidate, never schedule imported history or invent attempts.
 * `evidence` only ever adds typed links to chats converted here, or diagnostics; it never
 * merges conversations, creates bindings or removes a runtime record.
 */
export function migrateTeamChats(source: TeamChatSnapshot, evidence: readonly LegacyRuntimeSessionEvidence[] = []): TeamChatSnapshot {
  if (source.schemaVersion !== 2) throw new Error('Unsupported conversation version.');
  if (source.activation?.version === 1) return structuredClone(source);
  const ids = new Set(source.conversations.map(chat => chat.id));
  for (const chat of source.teamChats) {
    if (ids.has(chat.id)) throw new Error('Conversation identity collision.');
    ids.add(chat.id);
  }
  const legacyChats = new Map(source.teamChats.map(chat => [chat.id, chat] as const));
  const durableIds = new Set(source.conversations.map(chat => chat.id));
  const links = new Map<string, LegacyRuntimeLink[]>();
  const diagnostics: NonNullable<TeamChatSnapshot['legacyRuntimeDiagnostics']> = [];
  const sorted = [...evidence].sort((a, b) => (a.issueKey < b.issueKey ? -1 : a.issueKey > b.issueKey ? 1 : 0));
  for (const item of sorted) {
    if (durableIds.has(LEGACY_RUNTIME_KEY.exec(item.issueKey)?.[1] ?? '')) continue; // already durable: not ours to link
    const result = classifyLegacyRuntimeSession(item, legacyChats);
    if (result.kind === 'link') {
      const forChat = links.get(result.link.conversationId) ?? [];
      if (!forChat.some(link => link.runtimeSessionKey === result.link.runtimeSessionKey)) forChat.push(result.link);
      links.set(result.link.conversationId, forChat);
    } else if (result.kind === 'diagnostic' && !diagnostics.some(d => d.runtimeSessionKey === item.issueKey)) {
      diagnostics.push({ runtimeSessionKey: item.issueKey, reason: result.reason });
    }
  }
  const imported = source.teamChats.map(chat => {
    const conversation = importLegacyTeamChat(chat);
    const proven = links.get(chat.id);
    return proven ? { ...conversation, legacyRuntimeLinks: proven } : conversation;
  });
  const result: TeamChatSnapshot = { ...structuredClone(source), teamChats: [],
    conversations: [...structuredClone(source.conversations), ...imported],
    activation: { version: 1, acceptedNewTurns: false } };
  if (diagnostics.length) result.legacyRuntimeDiagnostics = [...(result.legacyRuntimeDiagnostics ?? []), ...diagnostics];
  return result;
}
