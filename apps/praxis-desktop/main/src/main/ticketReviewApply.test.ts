import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAppliedChanges } from './ticketReviewApply';

/**
 * Pins a bug found live: a required apply-form field is often resubmitted
 * unchanged (the model had nothing new to say about it), and the result
 * banner must report what actually changed, not what the form merely sent —
 * "Applied: updated the summary and description" next to an unchanged
 * description reads as a lie about what just happened.
 */

const BEFORE = { summary: 'Sprint backlog item 9', description: 'Generated demo issue 9 so paging and filtering have data to chew on.' };

test('only the fields that actually differ are reported as updated', () => {
  const result = describeAppliedChanges(BEFORE, {
    summary: 'Seed demo data for paging and filtering testing',
    description: BEFORE.description
  });
  assert.equal(result.changedSummary, true);
  assert.equal(result.changedDescription, false);
  assert.equal(result.label, 'updated the summary');
});

test('both fields report when both actually differ', () => {
  const result = describeAppliedChanges(BEFORE, {
    summary: 'New summary',
    description: 'New description'
  });
  assert.equal(result.label, 'updated the summary and description');
});

test('resubmitting the exact current text for every field reports no change, not a false update', () => {
  const result = describeAppliedChanges(BEFORE, { summary: BEFORE.summary, description: BEFORE.description });
  assert.equal(result.changedSummary, false);
  assert.equal(result.changedDescription, false);
  assert.equal(result.label, undefined);
});

test('whitespace-only differences do not count as a change', () => {
  const result = describeAppliedChanges(BEFORE, {
    summary: `  ${BEFORE.summary}  `,
    description: `${BEFORE.description}\n`
  });
  assert.equal(result.label, undefined);
});

test('an empty field (not sent this round) never counts as a change even against an empty baseline', () => {
  const result = describeAppliedChanges({ summary: '', description: undefined }, { summary: '', description: '' });
  assert.equal(result.label, undefined);
});
