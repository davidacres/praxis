import assert from 'node:assert/strict';
import test from 'node:test';
import { GADGET_KINDS } from './contracts';
import { buildExpiredGadgetFixture, buildGadgetFailureFixtures, buildGadgetFixtures } from './fixtures';
import { GadgetService } from './gadgetService';
import { coerceGadgetBlock } from './validation';

const OPTIONS = {
  scope: { hostId: 'host-1', projectId: 'project-1', sessionId: 'session-1', workId: 'FX-1' },
  issuedAt: '2026-09-13T10:00:00.000Z'
};

test('the catalogue covers every declared gadget kind exactly once', () => {
  // If a kind is added to the contract without a fixture, the e2e suite would
  // silently stop covering it — so the catalogue is checked against the source
  // of truth rather than maintained by hand.
  const kinds = buildGadgetFixtures(OPTIONS).map(block =>
    block.type === 'gadget' ? (block.gadget as { kind: string }).kind : undefined
  );
  assert.deepEqual([...kinds].sort(), [...GADGET_KINDS].sort());
});

test('every valid fixture survives validation and renders as a gadget', () => {
  for (const block of buildGadgetFixtures(OPTIONS)) {
    if (block.type !== 'gadget') continue;
    const coerced = coerceGadgetBlock(block.gadget, block.blockId ?? 'b');
    assert.equal(
      coerced.type,
      'gadget',
      `${block.blockId} was refused: ${coerced.type === 'fallback' ? coerced.reason?.message : ''}`
    );
    // The contract promises a text representation for every gadget.
    if (coerced.type === 'gadget') assert.ok(coerced.gadget.fallbackText.trim().length > 0);
  }
});

test('every failure fixture degrades to a visible fallback, never to nothing', () => {
  const expectedCodes: Record<string, string> = {
    'fixture-unknown-kind': 'unsupported-kind',
    'fixture-future-version': 'unsupported-version',
    'fixture-oversized': 'payload-too-large',
    'fixture-schema-invalid': 'schema-invalid',
    'fixture-ungated-mutation': 'gate-required',
    'fixture-traversal': 'schema-invalid'
  };
  for (const block of buildGadgetFailureFixtures(OPTIONS)) {
    if (block.type !== 'gadget') continue;
    const coerced = coerceGadgetBlock(block.gadget, block.blockId ?? 'b');
    assert.equal(coerced.type, 'fallback', `${block.blockId} was unexpectedly accepted`);
    if (coerced.type !== 'fallback') continue;
    assert.equal(coerced.reason?.code, expectedCodes[block.blockId ?? ''], block.blockId);
    assert.ok(coerced.text.trim().length > 0, `${block.blockId} produced empty fallback text`);
  }
});

test('publishing the whole catalogue through the service yields one block each', () => {
  const service = new GadgetService({ hostId: 'host-1', now: () => '2026-09-13T10:00:01.000Z' });
  const valid = buildGadgetFixtures(OPTIONS);
  const failures = buildGadgetFailureFixtures(OPTIONS);
  const blocks = service.publish('session-1', [...valid, ...failures]);

  assert.equal(blocks.length, valid.length + failures.length);
  assert.equal(blocks.filter(block => block.type === 'gadget').length, valid.length);
  assert.equal(blocks.filter(block => block.type === 'fallback').length, failures.length);
});

test('the expired fixture is inert by the time it is read', () => {
  const service = new GadgetService({ hostId: 'host-1', now: () => '2026-09-13T11:00:00.000Z' });
  service.publish('session-1', [buildExpiredGadgetFixture(OPTIONS)]);
  const [block] = service.getBlocks('session-1');
  assert.equal(block.type === 'gadget' && block.gadget.state, 'expired');
});
