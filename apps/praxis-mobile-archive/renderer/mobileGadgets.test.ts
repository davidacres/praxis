import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnyGadgetEnvelope, FormGadgetPayload, MobileGadgetView } from '@praxis/core';
import {
  answerNeedsIdentity,
  canDrawGadget,
  chartBars,
  formActionValue,
  gadgetIdempotencyKey,
  inertGadgetReason,
  initialFormValues,
  isGadgetAnswerable,
  validateFormValues,
} from './mobileGadgets';

const choice: AnyGadgetEnvelope = {
  version: 1, gadgetId: 'msg-1-1', kind: 'choice', scope: { hostId: 'h', sessionId: 's' }, issuedAt: '2026-09-24T10:00:00.000Z', fallbackText: 'Pick',
  payload: { question: 'Which?', options: [{ value: 'a', label: 'A' }] }, actions: [{ actionId: 'answer', label: 'Answer', effect: 'informational' }],
};
const view = (overrides: Partial<MobileGadgetView> = {}): MobileGadgetView => ({ gadget: choice, state: 'active', ...overrides });

test('a gadget is answerable only while active and unanswered', () => {
  assert.equal(isGadgetAnswerable(view()), true);
  assert.equal(isGadgetAnswerable(view({ state: 'expired' })), false);
  assert.equal(isGadgetAnswerable(view({ result: { status: 'completed', message: 'Recorded: A.' } })), false);
  // A rejected attempt leaves it answerable, as on the desktop.
  assert.equal(isGadgetAnswerable(view({ result: { status: 'rejected' } })), true);
  assert.equal(inertGadgetReason(view({ result: { status: 'completed', message: 'Recorded: A.' } })), 'Recorded: A.');
  assert.equal(inertGadgetReason(view({ state: 'superseded' })), 'A newer question replaced this one.');
  assert.equal(inertGadgetReason(view()), undefined);
});

test('unknown kinds and versions fall back to text', () => {
  assert.equal(canDrawGadget(choice), true);
  assert.equal(canDrawGadget({ kind: 'choice', version: 2 }), false);
  assert.equal(canDrawGadget({ kind: 'hologram' as never, version: 1 }), false);
});

test('approving, changing or dangerous answers need the person to confirm it is them', () => {
  assert.equal(answerNeedsIdentity({ effect: 'informational' }), false);
  assert.equal(answerNeedsIdentity({ effect: 'approval' }), true);
  assert.equal(answerNeedsIdentity({ effect: 'mutating' }), true);
  assert.equal(answerNeedsIdentity({ effect: 'informational', danger: true }), true);
  assert.equal(answerNeedsIdentity(undefined), false);
});

const form: FormGadgetPayload = {
  title: 'Details',
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 10 },
    { name: 'count', label: 'Count', type: 'number', min: 1, max: 5, defaultValue: 2 },
    { name: 'urgent', label: 'Urgent', type: 'boolean' },
    { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'bug', label: 'Bug' }] },
  ],
};

test('forms open on their defaults, validate each field, and answer in declared types', () => {
  const values = initialFormValues(form);
  assert.deepEqual(values, { title: '', count: '2', urgent: false, kind: '' });
  assert.deepEqual(Object.keys(validateFormValues(form, values)), ['title']);
  assert.match(validateFormValues(form, { ...values, title: 'x', count: '9' }).count, /at most 5/);
  assert.match(validateFormValues(form, { ...values, title: 'x', kind: 'feature' }).kind, /Choose a kind/);
  assert.deepEqual(validateFormValues(form, { ...values, title: 'Fix it', kind: 'bug' }), {});
  assert.deepEqual(formActionValue(form, { title: ' Fix it ', count: '3', urgent: true, kind: '' }), { kind: 'form', fields: { title: 'Fix it', count: 3, urgent: true } });
});

test('chart bars scale to the largest value and say how many were left off', () => {
  const bars = chartBars({ chartKind: 'bar', series: [{ label: 'Runs', points: [{ x: 'Mon', y: 2 }, { x: 'Tue', y: 4 }, { x: 'Wed', y: 1 }] }] }, 2);
  assert.deepEqual(bars.bars.map(bar => bar.fraction), [0.5, 1]);
  assert.equal(bars.more, 1);
});

test('the same answer gets the same idempotency key; a different answer does not', () => {
  const first = gadgetIdempotencyKey('g', 'answer', { kind: 'choice', selected: 'a' });
  assert.equal(first, gadgetIdempotencyKey('g', 'answer', { kind: 'choice', selected: 'a' }));
  assert.notEqual(first, gadgetIdempotencyKey('g', 'answer', { kind: 'choice', selected: 'b' }));
});
