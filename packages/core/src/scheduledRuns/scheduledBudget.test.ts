import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProviderForEntry, providerHeadroom } from './scheduledBudget';

test('headroom is the highest window, and unknown when nothing is reported', () => {
  assert.equal(providerHeadroom([0.2, 0.7, undefined]), 0.7);
  assert.equal(providerHeadroom([undefined]), undefined);
  assert.equal(providerHeadroom(undefined), undefined);
});

test('a known provider under the threshold carries on', () => {
  const decision = decideProviderForEntry({ active: 'claude', usable: ['claude', 'codex'], used: { claude: 0.5, codex: 0.1 } });
  assert.equal(decision.kind, 'ok');
  assert.equal(decision.kind === 'ok' && decision.provider, 'claude');
});

test('exactly 95% hands over; just under does not', () => {
  assert.equal(decideProviderForEntry({ active: 'claude', usable: ['claude', 'codex'], used: { claude: 0.949, codex: 0.1 } }).kind, 'ok');
  const decision = decideProviderForEntry({ active: 'claude', usable: ['claude', 'codex'], used: { claude: 0.95, codex: 0.1 } });
  assert.equal(decision.kind, 'handover');
  assert.equal(decision.kind === 'handover' && decision.provider, 'codex');
});

test('hand-over prefers the provider with the most room', () => {
  const decision = decideProviderForEntry({ active: 'a', usable: ['a', 'b', 'c'], used: { a: 0.99, b: 0.6, c: 0.2 } });
  assert.equal(decision.kind === 'handover' && decision.provider, 'c');
});

test('an unknown provider is never a place to move work to', () => {
  const decision = decideProviderForEntry({ active: 'claude', usable: ['claude', 'copilot'], used: { claude: 0.97 } });
  assert.equal(decision.kind, 'pause');
  assert.equal(decision.kind === 'pause' && decision.why, 'budget');
});

test('an active provider that reports nothing still runs, flagged as unchecked', () => {
  const decision = decideProviderForEntry({ active: 'copilot', usable: ['copilot', 'codex'], used: { codex: 0.1 } });
  assert.equal(decision.kind, 'ok');
  assert.equal(decision.kind === 'ok' && decision.allowanceKnown, false);
});

test('with no active provider the best known one starts', () => {
  const decision = decideProviderForEntry({ usable: ['a', 'b'], used: { a: 0.8, b: 0.3 } });
  assert.equal(decision.kind === 'handover' && decision.provider, 'b');
});

test('no usable provider pauses for no-provider', () => {
  const decision = decideProviderForEntry({ active: 'claude', usable: [], used: {} });
  assert.equal(decision.kind === 'pause' && decision.why, 'no-provider');
});

test('an active provider that is not usable is replaced', () => {
  const decision = decideProviderForEntry({ active: 'gone', usable: ['codex'], used: { codex: 0.2 } });
  assert.equal(decision.kind === 'handover' && decision.provider, 'codex');
});
