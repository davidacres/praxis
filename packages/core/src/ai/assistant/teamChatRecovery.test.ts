import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { beginConversationEpoch } from './teamChatTransitions';
import type { ConversationAttempt, DurableConversation } from './assistantTypes';

for (const dispatched of [false, true]) for (const capability of ['text', 'tools', 'opaque'] as const) {
  test('startup recovery matrix: dispatched=' + dispatched + ', capability=' + capability, () => {
    const attempt: ConversationAttempt = { id: 'a', turnId: 't', participantId: 'p', ordinal: 1,
      coordinatorEpoch: 'origin', state: dispatched ? 'running' : 'prepared',
      ...(dispatched ? { dispatchIntent: 'now' } : {}), createdAt: 'now',
      contextReceipt: { digest: 'context', messageIds: [] }, usageReferences: [], toolEvidenceReferences: [],
      recoveryEvidence: capability === 'opaque' ? [] : [{ id: 'runtime', conversationId: 'c', turnId: 't',
        participantId: 'p', attemptId: 'a', coordinatorEpoch: 'origin', kind: 'runtime_identity',
        observedAt: 'now', provenance: 'adapter', data: { toolCapable: capability === 'tools' } }] };
    const conversation: DurableConversation = { id: 'c', schemaVersion: 2, title: 'test', createdAt: 'now',
      updatedAt: 'now', revision: 1, coordinatorEpoch: 'origin', participants: [], messages: [], bindings: [],
      summaries: [], pinnedMessageIds: [], commandReceipts: [], turns: [{ id: 't', commandId: 'cmd',
        payloadDigest: 'digest', userMessageId: 'u', acceptedSequence: 1, state: 'running',
        plan: { participants: [], runtimeOptions: {} }, completedParticipantIds: [], attempts: [attempt] }] };
    const recovered = beginConversationEpoch(conversation, 1, 'observer', 'later');
    assert.equal(recovered.turns[0].state, dispatched && capability !== 'text' ? 'outcome_unknown' : 'interrupted');
    assert.equal(recovered.turns[0].attempts[0].coordinatorEpoch, 'origin');
    assert.equal(conversation.turns[0].attempts[0].state, attempt.state);
  });
}
