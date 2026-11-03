import type { ConversationSummary, DurableConversation } from './assistantTypes';
import { conversationPayloadDigest } from './teamChatTransitions';

/** Immutable source provenance. The full source survives summary supersession. */
export function appendConversationSummary(conversation: DurableConversation, summary: ConversationSummary): void {
  const source = conversation.messages.filter(m => summary.sourceMessageIds ? summary.sourceMessageIds.includes(m.id) : m.sequence >= summary.sourceStart && m.sequence <= summary.sourceEnd);
  if (!source.length || conversationPayloadDigest(source) !== summary.sourceDigest || conversation.summaries.some(s => s.id === summary.id) ||
      summary.version !== (conversation.summaries.at(-1)?.version ?? 0) + 1 ||
      (summary.supersedesId && !conversation.summaries.some(s => s.id === summary.supersedesId))) throw new Error('Invalid summary provenance.');
  conversation.summaries.push(structuredClone(summary));
}
export function latestValidConversationSummary(conversation: DurableConversation, eligibleIds: ReadonlySet<string>): ConversationSummary | undefined {
  return [...conversation.summaries].reverse().find(summary => {
    const source = conversation.messages.filter(m => summary.sourceMessageIds ? summary.sourceMessageIds.includes(m.id) : m.sequence >= summary.sourceStart && m.sequence <= summary.sourceEnd);
    return source.length > 0 && source.every(m => eligibleIds.has(m.id)) && conversationPayloadDigest(source) === summary.sourceDigest;
  });
}
export function pinConversationDecision(conversation: DurableConversation, messageId: string, supersedesMessageId?: string): void {
  const message = conversation.messages.find(m => m.id === messageId);
  const superseded = conversation.messages.find(m => m.id === supersedesMessageId);
  if (!message || (supersedesMessageId && (!superseded || superseded.sequence >= message.sequence))) throw new Error('Invalid pinned decision source.');
  if (!conversation.pinnedMessageIds.includes(messageId)) conversation.pinnedMessageIds.push(messageId);
  if (supersedesMessageId) {
    conversation.decisionCorrections ??= [];
    if (!conversation.decisionCorrections.some(c => c.messageId === messageId && c.supersedesMessageId === supersedesMessageId)) conversation.decisionCorrections.push({ messageId, supersedesMessageId });
    // Retain both verbatim sources; the explicit relation disambiguates them.
    if (!conversation.pinnedMessageIds.includes(supersedesMessageId)) conversation.pinnedMessageIds.push(supersedesMessageId);
  }
}
