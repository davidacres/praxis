import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMobileCommandLedger, admitMobileCommand, completeMobileCommand, markMobileCommandUnknown } from './mobileCommandLedger';

test('admits once and replays identical command IDs', () => {
  const ledger = new InMemoryMobileCommandLedger();
  const first = admitMobileCommand(ledger, 'cmd-1', 'digest-a', '2026-09-09T12:00:00.000Z');
  const second = admitMobileCommand(ledger, 'cmd-1', 'digest-a', '2026-09-09T12:00:01.000Z');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.replay, true);
});

test('rejects conflicting reuse and records unknown reconciliation', () => {
  const ledger = new InMemoryMobileCommandLedger();
  admitMobileCommand(ledger, 'cmd-2', 'digest-a', '2026-09-09T12:00:00.000Z');
  const conflict = admitMobileCommand(ledger, 'cmd-2', 'digest-b', '2026-09-09T12:00:01.000Z');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'duplicate-command');
  assert.equal(markMobileCommandUnknown(ledger, 'cmd-2', '2026-09-09T12:00:02.000Z')?.state, 'unknown');
  assert.equal(completeMobileCommand(ledger, 'cmd-2', { accepted: true }, '2026-09-09T12:00:03.000Z')?.state, 'completed');
});

test('replays events after a cursor with a bounded page', () => {
  const ledger = new InMemoryMobileCommandLedger();
  for (const sequence of [1, 2, 3]) ledger.appendEvent({ protocolVersion: 1, eventId: `event-${sequence}`, sequence, emittedAt: '2026-09-09T12:00:00.000Z', target: { hostId: 'host-mac' }, event: { sequence } });
  assert.deepEqual(ledger.replay(1, 1).map(event => event.sequence), [2]);
});
