import { appendConversationSummary, pinConversationDecision } from './teamChatSummaries';
import { conversationPayloadDigest } from './teamChatTransitions';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { prepareTeamChatContext, TeamChatContextRequired } from './teamChatContext';
import type { DurableConversation, ConversationTurn, ConversationMessage } from './assistantTypes';
import { makeParticipant } from './teamChatCoordinator';
const participant = makeParticipant('lead');
const turn: ConversationTurn = { id: 'turn', commandId: 'command', payloadDigest: '', userMessageId: 'current', acceptedSequence: 20, plan: { participants: [participant], runtimeOptions: {} }, state: 'running', completedParticipantIds: [], attempts: [] };
function fixture(): DurableConversation {
  const messages: ConversationMessage[] = Array.from({ length: 19 }, (_, i) => ({ id: `m${i}`, turnId: 'old', role: 'user', text: i === 0 ? 'Early decision ' + 'x'.repeat(4000) : 'history', createdAt: '', sequence: i + 1, attachments: [] }));
  messages.push({ id: 'current', turnId: 'turn', role: 'user', text: 'Current input', createdAt: '', sequence: 20, attachments: [] }, { id: 'future', turnId: 'future', role: 'user', text: 'Queued input', createdAt: '', sequence: 21, attachments: [] });
  return { id: 'chat', title: '', createdAt: '', updatedAt: '', schemaVersion: 2, revision: 0, coordinatorEpoch: '', participants: [participant], messages, turns: [turn], bindings: [], summaries: [], pinnedMessageIds: ['m0'], commandReceipts: [] };
}
test('reconstruction preserves history beyond legacy limits and excludes future input', () => {
  const prepared = prepareTeamChatContext(fixture(), turn, participant);
  assert.equal(prepared.messages.length, 20);
  assert.ok(prepared.prompt.includes('Early decision'));
  assert.ok(!prepared.prompt.includes('Queued input'));
  assert.equal(prepared.receipt.budget?.method, 'utf8-bytes-upper-bound');
});
test('mandatory overflow prevents dispatch rather than clipping', () => {
  assert.throws(() => prepareTeamChatContext(fixture(), turn, participant, undefined, false, 10, 0), TeamChatContextRequired);
});
test('native coverage excludes delivered shared messages and own output', () => {
  const prepared = prepareTeamChatContext(fixture(), turn, participant, { id: 'binding', conversationId: 'chat', participantId: participant.id, providerRuntime: 'acp', compatibilityDigest: '', status: 'valid', deliveredMessageIds: ['m0'], nativeOutputMessageIds: ['m1'], summarizedMessageIds: ['m2'] }, true);
  assert.equal(prepared.messages.length, 17);
  assert.ok(!prepared.receipt.messageIds.includes('m0'));
  assert.ok(!prepared.receipt.messageIds.includes('m1'));
  assert.ok(!prepared.receipt.messageIds.includes('m2'));
});

test('summary sources are validated and pinned corrections remain verbatim', async () => {
  const conversation = fixture();
  pinConversationDecision(conversation, 'm1', 'm0');
  appendConversationSummary(conversation, { id: 'summary', version: 1, sourceStart: 1, sourceEnd: 19, sourceDigest: conversationPayloadDigest(conversation.messages.slice(0, 19)), text: 'Condensed history', attemptId: 'summary-attempt', provider: 'fixture' });
  const prepared = prepareTeamChatContext(conversation, turn, participant);
  assert.deepEqual(prepared.receipt.messageIds, ['m0', 'm1', 'current']);
  assert.ok(prepared.prompt.includes('supersedesMessageId'));
  conversation.messages[2].text = 'corrupted source';
  assert.equal(prepareTeamChatContext(conversation, turn, participant).receipt.summaryId, undefined);
});

test('an earlier turn reply committed after a queued input remains eligible', () => {
  const conversation = fixture();
  conversation.turns.unshift({ ...turn, id: 'old', state: 'completed' });
  conversation.messages.push({ id: 'late-prior-reply', turnId: 'old', role: 'lead', text: 'Prior turn result', createdAt: '', sequence: 22, attachments: [] });
  const prepared = prepareTeamChatContext(conversation, turn, participant);
  assert.ok(prepared.receipt.messageIds.includes('late-prior-reply'));
  assert.ok(!prepared.receipt.messageIds.includes('future'));
});
