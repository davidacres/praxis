import { appendConversationSummary, pinConversationDecision } from './teamChatSummaries';
import { conversationPayloadDigest } from './teamChatTransitions';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { prepareTeamChatContext, TeamChatContextRequired } from './teamChatContext';
import type { DurableConversation, ConversationTurn, ConversationMessage } from './assistantTypes';
import { makeParticipant } from './teamChatCoordinator';
import { resolveTeamChatBinding, type TeamChatConfiguration } from './teamChatBindings';
const participant = makeParticipant('lead');
const replacementConfig: TeamChatConfiguration = { conversationId: 'chat', participantId: participant.id, providerRuntime: 'acp', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: '1', canonicalFolder: '/project', executionMode: 'chat', toolPolicy: 'read-only', permissionPolicy: 'manual' };
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

test('provider replacement reconstructs an early pinned decision, its later correction and other members\' replies, excluding queued future input', () => {
  const conversation = fixture();
  conversation.participants.push(makeParticipant('qa'));
  // m0 is the early pinned decision; m5 corrects it; m7 is another member's reply.
  conversation.messages[5] = { ...conversation.messages[5], role: 'dev', text: 'Correction: use the second option' };
  conversation.messages[7] = { ...conversation.messages[7], role: 'qa', text: 'QA reply on the decision' };
  pinConversationDecision(conversation, 'm5', 'm0');
  const old = resolveTeamChatBinding(conversation.bindings, { ...replacementConfig, providerRuntime: 'old-cli' }, 'old');
  old.deliveredMessageIds = conversation.messages.slice(0, 19).map(m => m.id);
  const replacement = resolveTeamChatBinding(conversation.bindings, { ...replacementConfig, providerRuntime: 'new-api' }, 'new');
  assert.equal(old.status, 'invalid');
  assert.deepEqual(replacement.deliveredMessageIds, []);
  // A fresh binding has delivered nothing, so even a native-resume prompt is a full reconstruction.
  for (const nativeResume of [false, true]) {
    const prepared = prepareTeamChatContext(conversation, turn, participant, replacement, nativeResume);
    for (const id of ['m0', 'm5', 'm7', 'current']) assert.ok(prepared.receipt.messageIds.includes(id), id);
    assert.ok(!prepared.receipt.messageIds.includes('future'));
    assert.ok(prepared.prompt.includes('Early decision'));
    assert.ok(prepared.prompt.includes('Correction: use the second option'));
    assert.ok(prepared.prompt.includes('QA reply on the decision'));
    assert.ok(prepared.prompt.includes('supersedesMessageId'));
    assert.ok(!prepared.prompt.includes('Queued input'));
    assert.equal(prepared.receipt.bindingId, 'new');
  }
});

function delivered(conversation: DurableConversation, ids: string[], own: string[] = []) {
  return { id: 'b', conversationId: 'chat', participantId: participant.id, providerRuntime: 'acp', compatibilityDigest: '', status: 'valid' as const, deliveredMessageIds: ids, nativeOutputMessageIds: own, summarizedMessageIds: [] };
}

test('TASK-481 AC1: native continuation omits own reply and delivered history, and sends other replies and the intervening turn once', () => {
  const conversation = fixture();
  conversation.messages = [
    { id: 'u1', turnId: 'old', role: 'user', text: 'First question', createdAt: '', sequence: 1, attachments: [] },
    { id: 'own1', turnId: 'old', role: 'lead', text: 'OWN-REPLY', createdAt: '', sequence: 2, attachments: [] },
    { id: 'peer1', turnId: 'old', role: 'qa', text: 'PEER-REPLY', createdAt: '', sequence: 3, attachments: [] },
    { id: 'u2', turnId: 'mid', role: 'user', text: 'INTERVENING-TURN', createdAt: '', sequence: 4, attachments: [] },
    { id: 'current', turnId: 'turn', role: 'user', text: 'Current input', createdAt: '', sequence: 5, attachments: [] }
  ];
  conversation.pinnedMessageIds = [];
  const t: ConversationTurn = { ...turn, acceptedSequence: 5 };
  conversation.turns = [{ ...t, id: 'old', state: 'completed' }, { ...t, id: 'mid', state: 'completed' }, t];
  const prepared = prepareTeamChatContext(conversation, t, participant, delivered(conversation, ['u1'], ['own1']), true);
  assert.deepEqual(prepared.receipt.messageIds, ['peer1', 'u2', 'current']);
  for (const text of ['PEER-REPLY', 'INTERVENING-TURN', 'Current input']) assert.equal(prepared.prompt.split(text).length - 1, 1, text);
  assert.ok(!prepared.prompt.includes('OWN-REPLY'));
  assert.ok(!prepared.prompt.includes('First question'));
});

test('TASK-481 AC2: a fresh binding gets instructions, pinned decision, summary version, recent messages and current turn once; future turns excluded', () => {
  const conversation = fixture();
  pinConversationDecision(conversation, 'm0');
  appendConversationSummary(conversation, { id: 's7', version: 1, sourceStart: 1, sourceEnd: 10, sourceDigest: conversationPayloadDigest(conversation.messages.slice(0, 10)), text: 'SUMMARY-TEXT', attemptId: 'sa', provider: 'fixture' });
  const fresh = delivered(conversation, []);
  const prepared = prepareTeamChatContext(conversation, turn, participant, fresh, false);
  const count = (s: string) => prepared.prompt.split(s).length - 1;
  assert.equal(count(participant.instructions), 1);
  assert.equal(count('Summary (version 1)'), 1);
  assert.equal(count('SUMMARY-TEXT'), 1);
  assert.equal(count('Early decision'), 1);
  assert.equal(count('Current input'), 1);
  assert.equal(count('[m15]'), 1, 'recent message after the summary window');
  assert.ok(!prepared.prompt.includes('Queued input'));
  assert.equal(prepared.receipt.summaryId, 's7');
  assert.equal(new Set(prepared.receipt.messageIds).size, prepared.receipt.messageIds.length);
});

test('TASK-481 AC3: long fixture beyond legacy limits keeps the pinned decision and the correction with source ids', () => {
  const conversation = fixture();
  conversation.messages[10] = { ...conversation.messages[10], text: 'Correction: choose B' };
  pinConversationDecision(conversation, 'm10', 'm0');
  appendConversationSummary(conversation, { id: 's1', version: 1, sourceStart: 1, sourceEnd: 19, sourceMessageIds: conversation.messages.slice(0, 19).map(m => m.id), sourceDigest: conversationPayloadDigest(conversation.messages.slice(0, 19)), text: 'Condensed', attemptId: 'sa', provider: 'fixture' });
  const summary = conversation.summaries[0];
  assert.ok(conversation.messages.length > 12 && conversation.messages.reduce((n, m) => n + m.text.length, 0) > 3000);
  assert.equal(summary.sourceMessageIds?.length, 19);
  const prepared = prepareTeamChatContext(conversation, turn, participant);
  assert.ok(prepared.prompt.includes('[m0] user:\nEarly decision'));
  assert.ok(prepared.prompt.includes('[m10] user:\nCorrection: choose B'));
  assert.ok(prepared.prompt.includes('"messageId":"m10"') && prepared.prompt.includes('"supersedesMessageId":"m0"'));
});

test('TASK-481 AC4: oversized pinned context, missing pinned source and unresolved attachments require context instead of dispatch', () => {
  assert.throws(() => prepareTeamChatContext(fixture(), turn, participant, undefined, false, 2000, 0), (e: unknown) => e instanceof TeamChatContextRequired && e.reason === 'budget');
  const missing = fixture();
  missing.pinnedMessageIds = ['gone'];
  assert.throws(() => prepareTeamChatContext(missing, turn, participant), (e: unknown) => e instanceof TeamChatContextRequired && e.reason === 'missing_source');
  const attached = fixture();
  attached.messages[19].attachments = [{ id: 'a', name: 'f', mimeType: 'text/plain', size: 1 } as never];
  assert.throws(() => prepareTeamChatContext(attached, turn, participant), (e: unknown) => e instanceof TeamChatContextRequired && e.reason === 'attachments');
});
