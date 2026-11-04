import { serializePageContext } from './assistantEngine';
import { latestValidConversationSummary } from './teamChatSummaries';
import type { ConversationBinding, ConversationContextReceipt, ConversationMessage, ConversationParticipant, ConversationTurn, DurableConversation } from './assistantTypes';
import { conversationPayloadDigest } from './teamChatTransitions';

export function eligibleTeamChatMessages(conversation: DurableConversation, turn: ConversationTurn): ConversationMessage[] {
  const turnIndex = conversation.turns.findIndex(t => t.id === turn.id);
  const earlierTurns = new Set(conversation.turns.slice(0, Math.max(turnIndex, 0)).map(t => t.id));
  return conversation.messages.filter(m => m.turnId === turn.id || earlierTurns.has(m.turnId) || m.sequence < turn.acceptedSequence);
}

export class TeamChatContextRequired extends Error {
  constructor(message: string, public readonly reason: 'budget' | 'attachments' | 'missing_source' = 'budget') { super(message); }
}
export interface PreparedTeamChatContext { prompt: string; messages: ConversationMessage[]; receipt: ConversationContextReceipt; }
/** Conservative UTF-8 byte estimate, one token per byte; fallback window 32k, reserve 8k output plus 4k tools/runtime overhead. */
export function prepareTeamChatContext(conversation: DurableConversation, turn: ConversationTurn, participant: ConversationParticipant,
  binding?: ConversationBinding, nativeResume = false, limit = 32768, reserved = 12288, attachmentsResolved = false): PreparedTeamChatContext {
  const eligible = eligibleTeamChatMessages(conversation, turn);
  if (!attachmentsResolved && eligible.some(m => m.attachments.length)) throw new TeamChatContextRequired('Attachment content must be resolved before dispatch.', 'attachments');
  const covered = new Set(nativeResume ? [...(binding?.deliveredMessageIds ?? []), ...(binding?.nativeOutputMessageIds ?? []), ...(binding?.summarizedMessageIds ?? [])] : []);
  const messages = eligible.filter(m => !covered.has(m.id));
  const summary = latestValidConversationSummary(conversation, new Set(eligible.map(m => m.id)));
  const pinned = new Set(conversation.pinnedMessageIds);
  if (conversation.pinnedMessageIds.some(id => !conversation.messages.some(m => m.id === id))) throw new TeamChatContextRequired('Pinned source is missing.', 'missing_source');
  const selected = summary && !nativeResume ? messages.filter(m => !(summary.sourceMessageIds ? summary.sourceMessageIds.includes(m.id) : m.sequence <= summary.sourceEnd) || pinned.has(m.id) || m.id === turn.userMessageId) : messages;
  const prompt = [participant.instructions, turn.plan.context ? serializePageContext(turn.plan.context) : '',
    summary && !nativeResume ? `Summary (version ${summary.version}):\n${summary.text}` : '',
    conversation.decisionCorrections?.length ? `Decision corrections: ${JSON.stringify(conversation.decisionCorrections.filter(c => eligible.some(m => m.id === c.messageId)))}` : '',
    ...selected.map(m => `[${m.id}] ${m.role}:\n${m.text}`)].filter(Boolean).join('\n\n');
  const estimated = Buffer.byteLength(prompt, 'utf8') + selected.reduce((sum, m) => sum + m.attachments.reduce((n, a) => n + a.size, 0), 0);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(reserved) || reserved < 0 || estimated + reserved > limit) throw new TeamChatContextRequired('Bounded context requires summarization or a larger model window.');
  return { prompt, messages: selected, receipt: { digest: conversationPayloadDigest({ prompt, messageIds: selected.map(m => m.id) }),
    messageIds: selected.map(m => m.id), ...(binding ? { bindingId: binding.id } : {}), instructionVersion: participant.instructionVersion,
    ...(summary && !nativeResume ? { summaryId: summary.id } : {}), budget: { limit, reserved, estimated, method: 'utf8-bytes-upper-bound' } } };
}
