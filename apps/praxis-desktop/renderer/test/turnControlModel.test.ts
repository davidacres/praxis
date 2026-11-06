import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationAttempt, ConversationTurn, DurableConversation } from '@praxis/core';
import {
  TURN_CONTROL_KEY_HINTS,
  TURN_KEY_BINDINGS,
  activeParticipant,
  describeTurnCard,
  describeTurnCards,
  hasReconciliationEvidence,
  resolveTurnKeyBinding,
  isEditingSurface
} from '../src/assistant/turnControlModel.ts';

/* TASK-484: the queue/recovery controls, their accessible names, test ids, gating and commands. */

const participant = (role: 'dev' | 'qa' | 'lead') => ({ id: `part-${role}`, role, instructionVersion: '1', instructions: '', defaults: {} });

const attempt = (overrides: Partial<ConversationAttempt> = {}): ConversationAttempt => ({
  id: 'a1',
  turnId: 't1',
  participantId: 'part-dev',
  ordinal: 1,
  coordinatorEpoch: 'epoch-1',
  state: 'running',
  contextReceipt: { digest: 'd', messageIds: [] },
  createdAt: '2026-11-01T10:00:00.000Z',
  usageReferences: [],
  toolEvidenceReferences: [],
  ...overrides
} as ConversationAttempt);

const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: 't1',
  commandId: 'cmd-1',
  payloadDigest: 'digest-1',
  userMessageId: 'm1',
  acceptedSequence: 1,
  plan: { participants: [participant('dev'), participant('qa')], runtimeOptions: {} },
  state: 'running',
  completedParticipantIds: [],
  attempts: [attempt()],
  ...overrides
} as ConversationTurn);

const conversation = (turns: ConversationTurn[], revision = 7): DurableConversation => ({
  id: 'conv-1',
  schemaVersion: 2,
  revision,
  title: 'Test',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  coordinatorEpoch: 'epoch-1',
  participants: [participant('dev')],
  messages: [],
  turns,
  bindings: [],
  summaries: [],
  pinnedMessageIds: [],
  commandReceipts: []
} as unknown as DurableConversation);

/** Each card description mints exactly one command id; tests assert it, so start fresh per test. */
const commandIds = () => { let n = 0; return { commandId: () => `cmd-${++n}` }; };

test('a running turn offers a labelled, enabled Stop fenced by conversation, revision, turn and attempt', () => {
  const controls = describeTurnCard(conversation([turn()]), turn(), 1, {}, commandIds()).controls;
  assert.deepEqual(controls.map(control => control.kind), ['stop']);
  const stop = controls[0];
  assert.equal(stop.label, 'Stop');
  assert.equal(stop.ariaLabel, 'Stop');
  assert.equal(stop.testId, 'assistant-turn-stop');
  assert.equal(stop.disabled, false);
  assert.equal(stop.disabledReason, undefined);
  assert.equal(stop.keyHint, TURN_CONTROL_KEY_HINTS.stop);
  assert.deepEqual(stop.command, {
    method: 'cancelTurn',
    payload: { conversationId: 'conv-1', commandId: 'cmd-1', expectedRevision: 7, turnId: 't1', attemptId: 'a1' }
  });
});

test('a queued turn offers only cancellation of that queued turn, and the card names its position', () => {
  const card = describeTurnCard(conversation([turn({ state: 'queued', attempts: [] })]), turn({ state: 'queued', attempts: [] }), 2, {}, commandIds());
  assert.equal(card.heading, 'Queued 2');
  assert.equal(card.ariaLabel, 'Queued turn 2');
  assert.equal(card.needsAttention, false);
  assert.deepEqual(card.controls.map(control => [control.kind, control.testId, control.label]), [['cancel-queued', 'assistant-turn-cancel-queued', 'Cancel queued turn']]);
  assert.equal(card.controls[0].command!.method, 'cancelTurn');
});

test('cancelling relabels and disables Stop with the reason a stop is already in flight', () => {
  const stop = describeTurnCard(conversation([turn({ state: 'cancelling' })]), turn({ state: 'cancelling' }), 1, {}, commandIds()).controls[0];
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.label, 'Stopping…');
  assert.equal(stop.disabled, true);
  assert.equal(stop.disabledReason, 'A stop command is already in flight.');
});

test('a failed turn retries its member, naming the member who has not completed', () => {
  const failed = turn({ state: 'failed', completedParticipantIds: ['part-dev'], attempts: [attempt({ id: 'a2', participantId: 'part-qa', state: 'failed', error: 'provider refused' })] });
  const card = describeTurnCard(conversation([failed]), failed, 1, {}, commandIds());
  assert.equal(card.heading, 'qa: failed');
  assert.equal(card.ariaLabel, 'Turn for qa: failed');
  assert.equal(card.alert, 'provider refused');
  assert.equal(card.needsAttention, true);
  assert.deepEqual(card.controls.map(control => control.kind), ['retry', 'stop']);
  const retry = card.controls[0];
  assert.equal(retry.label, 'Retry qa');
  assert.equal(retry.ariaLabel, 'Retry qa');
  assert.equal(retry.testId, 'assistant-turn-retry');
  assert.equal(retry.disabled, false);
  assert.deepEqual(retry.command, {
    method: 'retryParticipant',
    payload: { conversationId: 'conv-1', commandId: 'cmd-1', expectedRevision: 7, turnId: 't1', attemptId: 'a2', participantId: 'part-qa' }
  });
});

test('an interrupted turn with no attempt to retry disables Retry and says why', () => {
  const interrupted = turn({ state: 'interrupted', attempts: [] });
  const retry = describeTurnCard(conversation([interrupted]), interrupted, 1, {}, commandIds()).controls.find(control => control.kind === 'retry')!;
  assert.equal(retry.disabled, true);
  assert.equal(retry.disabledReason, 'This turn has no attempt to retry.');
});

test('context_required offers Recheck context as a resume-context control and surfaces the reason', () => {
  const blocked = turn({ state: 'context_required', contextRequiredReason: 'Pinned source is missing.', attempts: [] });
  const card = describeTurnCard(conversation([blocked]), blocked, 1, {}, commandIds());
  assert.equal(card.alert, undefined);
  assert.equal(card.contextAlert, 'Pinned source is missing.');
  assert.equal(card.needsAttention, true);
  const recheck = card.controls[0];
  assert.equal(recheck.kind, 'recheck-context');
  assert.equal(recheck.label, 'Recheck context');
  assert.equal(recheck.testId, 'assistant-turn-recheck-context');
  assert.deepEqual(recheck.command, { method: 'control', payload: { conversationId: 'conv-1', commandId: 'cmd-1', expectedRevision: 7, turnId: 't1', action: 'resume-context' } });
});

test('outcome_unknown gates its retry on a recorded reconciliation and an accepted duplicate-action risk', () => {
  const unknown = turn({ state: 'outcome_unknown' });
  const conv = conversation([unknown]);
  const card = (state: Parameters<typeof describeTurnCard>[3]) => describeTurnCard(conv, unknown, 1, state, commandIds());

  const gated = card({});
  assert.deepEqual(gated.controls.map(control => control.kind), ['reconciliation-note', 'record-reconciliation', 'resolve-confirmed', 'resolve-retry', 'resolve-cancel']);
  const note = gated.controls[0];
  assert.equal(note.ariaLabel, 'What did you check before retrying?');
  assert.equal(note.testId, 'assistant-turn-reconciliation-note');
  assert.equal(note.field?.kind, 'text');
  assert.equal(gated.controls[1].label, 'Record reconciliation');
  assert.equal(gated.controls[1].disabled, true, 'nothing recorded yet');
  const checkbox = gated.controls[2];
  assert.equal(checkbox.testId, 'assistant-turn-acknowledge-risk');
  assert.equal(checkbox.field?.kind, 'checkbox');
  assert.equal(checkbox.field?.checked, false);
  const retry = gated.controls[3];
  assert.equal(retry.testId, 'assistant-turn-resolve-retry');
  assert.equal(retry.disabled, true);
  assert.match(retry.disabledReason!, /Record what you checked/);

  // A note typed in the panel enables recording, but not the retry.
  const noted = card({ reconciliationNote: 'Checked the provider log: no mutation ran.' });
  const record = noted.controls[1];
  assert.equal(record.disabled, false);
  assert.deepEqual(record.command, {
    method: 'resolveAttempt',
    payload: { conversationId: 'conv-1', commandId: 'cmd-1', expectedRevision: 7, turnId: 't1', attemptId: 'a1', resolution: 'reconcile', reconciliationNote: 'Checked the provider log: no mutation ran.' }
  });
  assert.equal(noted.controls[3].disabled, true, 'a typed note is not yet recorded evidence');
  assert.match(noted.controls[3].disabledReason!, /Record what you checked/);

  // Acknowledgement alone is not enough either.
  assert.equal(card({ acknowledged: true }).controls[3].disabled, true);
});

test('recorded reconciliation evidence unlocks the retry once the risk is acknowledged, carrying the evidence id', () => {
  const reconciled = attempt({ recoveryEvidence: [{ id: 'ev-1', kind: 'reconciliation' } as never] });
  const unknown = turn({ state: 'outcome_unknown', attempts: [reconciled] });
  assert.equal(hasReconciliationEvidence(unknown, 'a1'), true);
  const card = describeTurnCard(conversation([unknown]), unknown, 1, { acknowledged: true }, commandIds());
  const retry = card.controls.find(control => control.kind === 'resolve-retry')!;
  assert.equal(retry.disabled, false);
  assert.equal(retry.disabledReason, undefined);
  assert.deepEqual(retry.command, {
    method: 'resolveAttempt',
    payload: { conversationId: 'conv-1', commandId: 'cmd-1', expectedRevision: 7, turnId: 't1', attemptId: 'a1', resolution: 'retry', acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: 'ev-1' }
  });
  const stop = card.controls.find(control => control.kind === 'resolve-cancel')!;
  assert.equal(stop.label, 'Stop');
  assert.equal(stop.disabled, false, 'an unknown outcome can still be stopped, leaving it unresolved');
});

test('reconciliation evidence on an earlier attempt does not unlock a newer one', () => {
  const unknown = turn({ state: 'outcome_unknown', attempts: [attempt({ id: 'a1', recoveryEvidence: [{ id: 'ev-1', kind: 'reconciliation' } as never] }), attempt({ id: 'a2', participantId: 'part-dev' })] });
  assert.equal(hasReconciliationEvidence(unknown, 'a2'), false);
  const card = describeTurnCard(conversation([unknown]), unknown, 1, { acknowledged: true }, commandIds());
  const retry = card.controls.find(control => control.kind === 'resolve-retry')!;
  assert.equal(retry.disabled, true);
  assert.match(retry.disabledReason!, /Record what you checked/);
});

test('the panel shows one card per unsettled turn, oldest first, and hides settled ones', () => {
  const running = turn();
  const queued = turn({ id: 't2', state: 'queued', attempts: [] });
  const done = turn({ id: 't3', state: 'completed' });
  const cancelled = turn({ id: 't4', state: 'cancelled' });
  const cards = describeTurnCards(conversation([running, queued, done, cancelled]), () => ({}), commandIds());
  assert.deepEqual(cards.map(entry => [entry.turn.id, entry.card.heading]), [['t1', 'dev: running'], ['t2', 'Queued 2']]);
  assert.deepEqual(cards.map(entry => entry.card.needsAttention), [false, false]);
});

test('every control carries a distinct data-testid the specs can select', () => {
  const states: ConversationTurn[] = [
    turn(),
    turn({ id: 't2', state: 'queued', attempts: [] }),
    turn({ id: 't3', state: 'failed' }),
    turn({ id: 't4', state: 'context_required', attempts: [] }),
    turn({ id: 't5', state: 'outcome_unknown' }),
    turn({ id: 't6', state: 'cancelling' })
  ];
  const cards = describeTurnCards(conversation(states), () => ({}), commandIds());
  const ids = cards.flatMap(entry => entry.card.controls.map(control => `${entry.turn.id}:${control.testId}`));
  assert.equal(new Set(ids).size, ids.length, ids.join(','));
  for (const expected of ['assistant-turn-stop', 'assistant-turn-cancel-queued', 'assistant-turn-retry', 'assistant-turn-recheck-context', 'assistant-turn-resolve-retry', 'assistant-turn-record-reconciliation', 'assistant-turn-reconciliation-note', 'assistant-turn-acknowledge-risk', 'assistant-turn-resolve-cancel']) {
    assert.ok(ids.some(id => id.endsWith(expected)), `missing ${expected}`);
  }
});

test('⌘/Ctrl+. stops the turn in flight and ⌘/Ctrl+Shift+R retries the most recent retryable attempt', () => {
  const running = turn();
  const failed = turn({ id: 't2', state: 'failed', attempts: [attempt({ id: 'a9', participantId: 'part-qa' })] });
  const cards = describeTurnCards(conversation([running, failed]), () => ({}), commandIds());
  const mod = { ctrlKey: true, metaKey: false };
  const stop = resolveTurnKeyBinding({ key: '.', ...mod }, cards.map(entry => entry.card))!;
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.command!.payload.turnId, 't1');
  // ⌘/Ctrl+R alone is the reload chord and is never claimed, retry or not.
  assert.equal(resolveTurnKeyBinding({ key: 'r', ...mod }, cards.map(entry => entry.card)), undefined);
  const retry = resolveTurnKeyBinding({ key: 'R', ...mod, shiftKey: true }, cards.map(entry => entry.card))!;
  assert.equal(retry.kind, 'retry');
  assert.equal(retry.command!.payload.turnId, 't2');
  // The macOS spelling resolves to the same control.
  assert.equal(resolveTurnKeyBinding({ key: '.', ctrlKey: false, metaKey: true }, cards.map(entry => entry.card))!.kind, 'stop');
});

test('⌘/Ctrl+Enter records the reconciliation only while it is the single enabled recovery action', () => {
  const unknown = turn({ state: 'outcome_unknown' });
  const card = describeTurnCard(conversation([unknown]), unknown, 1, { reconciliationNote: 'Checked.' }, commandIds());
  const cards = [card];
  const mod = { ctrlKey: true, metaKey: false };
  const resolved = resolveTurnKeyBinding({ key: 'Enter', ...mod }, cards)!;
  assert.equal(resolved.kind, 'record-reconciliation');
  // A second recovery action (the retry, once unlocked) means Enter must not fire: too ambiguous.
  const reconciled = turn({ id: 't2', state: 'outcome_unknown', attempts: [attempt({ id: 'a3', recoveryEvidence: [{ id: 'ev-1', kind: 'reconciliation' } as never] })] });
  const both = describeTurnCards(conversation([unknown, reconciled]), () => ({ reconciliationNote: 'Checked.', acknowledged: true }), commandIds());
  assert.equal(resolveTurnKeyBinding({ key: 'Enter', ...mod }, both.map(entry => entry.card)), undefined);
});

test('⌘/Ctrl+Enter typed in the composer sends the message only; it never records a reconciliation', () => {
  const unknown = turn({ state: 'outcome_unknown' });
  const cards = [describeTurnCard(conversation([unknown]), unknown, 1, { reconciliationNote: 'Checked.' }, commandIds())];
  const mod = { ctrlKey: true, metaKey: false };
  assert.equal(resolveTurnKeyBinding({ key: 'Enter', ...mod }, cards)!.kind, 'record-reconciliation');
  assert.equal(resolveTurnKeyBinding({ key: 'Enter', ...mod, fromEditingSurface: true }, cards), undefined);
  assert.equal(resolveTurnKeyBinding({ key: 'Enter', ctrlKey: false, metaKey: true, fromEditingSurface: true }, cards), undefined);
  // Retry is not reachable from a text field either; Stop stays reachable so a runaway turn can be halted.
  const failed = describeTurnCards(conversation([turn({ state: 'failed' })]), () => ({}), commandIds()).map(entry => entry.card);
  assert.equal(resolveTurnKeyBinding({ key: 'R', ...mod, shiftKey: true, fromEditingSurface: true }, failed), undefined);
  const running = describeTurnCards(conversation([turn()]), () => ({}), commandIds()).map(entry => entry.card);
  assert.equal(resolveTurnKeyBinding({ key: '.', ...mod, fromEditingSurface: true }, running)!.kind, 'stop');
});

test('editing surfaces are inputs, textareas, selects and contenteditable elements', () => {
  assert.equal(isEditingSurface({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditingSurface({ tagName: 'input' }), true);
  assert.equal(isEditingSurface({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditingSurface({ tagName: 'BUTTON' }), false);
  assert.equal(isEditingSurface(null), false);
});

test('a plain key press, an alt-modified one, or a binding with nothing enabled is not ours', () => {
  const running = turn();
  const cards = describeTurnCards(conversation([running]), () => ({}), commandIds()).map(entry => entry.card);
  assert.equal(resolveTurnKeyBinding({ key: 'r', ctrlKey: false, metaKey: false }, cards), undefined);
  assert.equal(resolveTurnKeyBinding({ key: '.', ctrlKey: true, metaKey: false, altKey: true }, cards), undefined);
  assert.equal(resolveTurnKeyBinding({ key: '.', ctrlKey: true, metaKey: false, shiftKey: true }, cards), undefined);
  assert.equal(resolveTurnKeyBinding({ key: 'z', ctrlKey: true, metaKey: false }, cards), undefined);
  const cancelling = describeTurnCards(conversation([turn({ state: 'cancelling' })]), () => ({}), commandIds()).map(entry => entry.card);
  assert.equal(resolveTurnKeyBinding({ key: '.', ctrlKey: true, metaKey: false }, cancelling), undefined);
});

test('each documented binding names what it does, and every recovery control has a key hint', () => {
  assert.deepEqual(TURN_KEY_BINDINGS.map(binding => binding.key), ['.', 'r', 'Enter']);
  for (const binding of TURN_KEY_BINDINGS) {
    assert.ok(binding.description.length > 10);
    assert.equal(binding.combo, 'mod');
  }
  const card = describeTurnCard(conversation([turn({ state: 'failed' })]), turn({ state: 'failed' }), 1, {}, commandIds());
  assert.ok(card.controls.filter(control => control.recovery).every(control => Boolean(control.keyHint)));
});

test('the member a turn is waiting on is the first planned participant that has not completed', () => {
  assert.equal(activeParticipant(turn())?.role, 'dev');
  assert.equal(activeParticipant(turn({ completedParticipantIds: ['part-dev'] }))?.role, 'qa');
  assert.equal(activeParticipant(turn({ completedParticipantIds: ['part-dev', 'part-qa'] })), undefined);
  // With nobody identifiable the card says "Team" rather than inventing a member.
  const card = describeTurnCard(conversation([turn({ state: 'failed', completedParticipantIds: ['part-dev', 'part-qa'] })]), turn({ state: 'failed', completedParticipantIds: ['part-dev', 'part-qa'] }), 1, {}, commandIds());
  assert.equal(card.heading, 'Team: failed');
  assert.equal(card.ariaLabel, 'Turn for the team: failed');
});
