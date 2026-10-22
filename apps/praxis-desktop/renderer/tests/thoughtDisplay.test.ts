import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_REASON_COPY, thoughtEmptyReasonFor } from '../src/ui/thoughtDisplay.ts';

test('an opaque route explains that the model hides its reasoning', () => {
  // OpenAI's HTTP API returns reasoning items as opaque and only reports their
  // token count, so gpt-6-* shows thoughts through a CLI agent and none here.
  assert.equal(thoughtEmptyReasonFor('opaque'), 'unsupported');
});

test('a session that opted out is told so, rather than blamed on the model', () => {
  assert.equal(thoughtEmptyReasonFor('not-requested'), 'not-requested');
});

test('a route that does return reasoning shows no empty state', () => {
  // Reasoning may simply not have arrived yet. Claiming "no reasoning was
  // returned" at the start of a turn that will return some would flash on
  // every single turn.
  assert.equal(thoughtEmptyReasonFor('text'), undefined);
});

test('a record with no availability stamp shows no empty state', () => {
  // Sessions persisted before the host began stamping availability must not
  // start announcing a reason they cannot know.
  assert.equal(thoughtEmptyReasonFor(undefined), undefined);
});

test('every empty reason has copy, so the block never renders blank', () => {
  for (const reason of ['unsupported', 'not-requested', 'unknown'] as const) {
    assert.ok(EMPTY_REASON_COPY[reason].trim().length > 0, reason);
  }
});
