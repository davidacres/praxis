import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationAttempt, ConversationTurn, DurableConversation } from '@praxis/core';
import { resolveAssistantError, unresolvedSnapshotErrors } from '../src/assistant/assistantErrorState.ts';

/* TASK-484 AC-E: an error stays visible until it is resolved, not until a snapshot omits it. */

const attempt = (overrides: Partial<ConversationAttempt> = {}): ConversationAttempt => ({
  id: 'a1', turnId: 't1', participantId: 'part-dev', ordinal: 1, coordinatorEpoch: 'e', state: 'failed',
  contextReceipt: { digest: 'd', messageIds: [] }, createdAt: '2026-11-01T10:00:00.000Z',
  usageReferences: [], toolEvidenceReferences: [], ...overrides
} as ConversationAttempt);

const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: 't1', commandId: 'c', payloadDigest: 'd', userMessageId: 'm', acceptedSequence: 1,
  plan: { participants: [], runtimeOptions: {} }, state: 'failed', completedParticipantIds: [],
  attempts: [attempt({ error: 'Provider refused' })], ...overrides
} as ConversationTurn);

const conversation = (turns: ConversationTurn[]): DurableConversation => ({
  id: 'conv', schemaVersion: 2, revision: 1, title: 't', createdAt: '', updatedAt: '', coordinatorEpoch: 'e',
  participants: [], messages: [], turns, bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: []
} as unknown as DurableConversation);

test('a live failure stays visible while a later snapshot still carries it', () => {
  const snapshot = conversation([turn()]);
  assert.equal(resolveAssistantError({ previous: 'Provider refused', snapshot }), 'Provider refused');
  assert.deepEqual([...unresolvedSnapshotErrors(snapshot)], ['Provider refused']);
});

test('a snapshot that merely omits the error is not a resolution for an unattributable error', () => {
  // A command rejection or an apply refusal names no turn, so nothing in the snapshot settles it.
  const snapshot = conversation([]);
  assert.equal(resolveAssistantError({ previous: 'Return to the originating page to apply this proposal.', snapshot }), 'Return to the originating page to apply this proposal.');
});

test('no snapshot at all keeps the error: a reload or a chat switch cannot blank a live failure', () => {
  assert.equal(resolveAssistantError({ previous: 'ENOSPC: no space left on device' }), 'ENOSPC: no space left on device');
});

test('a settled turn resolves its own error', () => {
  const settled = conversation([turn({ state: 'completed', attempts: [attempt({ state: 'failed', error: 'Provider refused' })] })]);
  assert.deepEqual([...unresolvedSnapshotErrors(settled)], []);
  assert.equal(resolveAssistantError({ previous: 'Provider refused', snapshot: settled }), undefined);
});

test('a cancelled turn resolves its own error', () => {
  const cancelled = conversation([turn({ state: 'cancelled' })]);
  assert.equal(resolveAssistantError({ previous: 'Provider refused', snapshot: cancelled }), undefined);
});

test('a newer attempt supersedes the failed one, so its error resolves', () => {
  const retried = conversation([turn({ state: 'running', attempts: [attempt({ id: 'a1', error: 'Provider refused' }), attempt({ id: 'a2', state: 'running' })] })]);
  assert.equal(resolveAssistantError({ previous: 'Provider refused', snapshot: retried }), undefined);
});

test('a context-required reason stays until the turn moves on', () => {
  const blocked = conversation([turn({ state: 'context_required', contextRequiredReason: 'Pinned source is missing.', attempts: [] })]);
  assert.equal(resolveAssistantError({ previous: 'Pinned source is missing.', snapshot: blocked }), 'Pinned source is missing.');
  // The turn left `context_required`: the transition away from it is the resolution.
  const resumed = conversation([turn({ state: 'running', attempts: [attempt({ state: 'running' })] })]);
  assert.equal(resolveAssistantError({ previous: 'Pinned source is missing.', snapshot: resumed, previousSnapshot: blocked }), undefined);
  // With no history to judge against, an error naming no turn stays until dismissed.
  assert.equal(resolveAssistantError({ previous: 'Pinned source is missing.', snapshot: resumed }), 'Pinned source is missing.');
});

test('an incoming error replaces whatever was shown, resolved or not', () => {
  assert.equal(resolveAssistantError({ previous: 'Old failure', incomingError: 'New failure', snapshot: conversation([]) }), 'New failure');
  // An explicitly cleared incoming error (undefined) is not "no error": it changes nothing.
  assert.equal(resolveAssistantError({ previous: 'Old failure', incomingError: undefined, snapshot: conversation([]) }), 'Old failure');
});

test('the user can dismiss, and dismissal wins over a still-unresolved snapshot', () => {
  const snapshot = conversation([turn()]);
  assert.equal(resolveAssistantError({ previous: 'Provider refused', snapshot, userDismissed: true }), undefined);
  assert.equal(resolveAssistantError({ previous: undefined, snapshot, userDismissed: true }), undefined);
});

test('a submission whose acknowledgement was lost clears once it is acknowledged', () => {
  assert.equal(resolveAssistantError({ previous: 'Lost acceptance acknowledgement', submissionAcknowledged: true }), undefined);
  // Only for the conversation on screen: switching chats is a scope change, not an acknowledgement.
  assert.equal(resolveAssistantError({ previous: 'Lost acceptance acknowledgement', conversationChanged: true }), undefined);
});

test('switching to another conversation drops an error that belongs to the first one', () => {
  assert.equal(resolveAssistantError({ previous: 'Provider refused', conversationChanged: true, snapshot: conversation([turn()]) }), undefined);
});
