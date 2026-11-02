import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseLedger, firstLine, formatWait, groupStops, runStops, stopKind, summarizeHandovers } from '../src/schedule/reportModel.ts';

/* The run report's consolidation, against the message shapes a real overnight run wrote. */

const ev = (at: string, kind: string, message: string, entryId?: string) => ({ at: `2026-11-01T${at}:00.000Z`, kind, message, ...(entryId ? { entryId } : {}) }) as never;
const entry = (id: string, issueKey: string) => ({ id, sequence: 1, ticket: { connectionId: 'c', issueKey, title: issueKey } }) as never;

test('each stop is sorted into the kind of decision it asked for', () => {
  assert.equal(stopKind(ev('09:54', 'paused', 'Needs a decision: Review still matches its loop back to Implement after 2 of 2 iterations.')), 'loop');
  assert.equal(stopKind(ev('10:03', 'entry-gate', 'PRX-T113-497 is waiting for approval: Approve.')), 'approval');
  assert.equal(stopKind(ev('00:13', 'paused', 'PRX-T113-496 could not be started: This project workflow needs local workspace trust.')), 'blocked');
  assert.equal(stopKind(ev('00:34', 'paused', 'PRX-T113-497 could not be started: 1 uncommitted file in this project is not in the last commit.')), 'blocked');
  assert.equal(stopKind(ev('04:10', 'paused', 'Implement failed: Implement made no changes: the branch is still at 62c4f83d.')), 'failure');
  assert.equal(stopKind(ev('16:43', 'paused', 'Implement failed: Interrupted — the app stopped while this stage was running.')), 'failure');
  assert.equal(stopKind(ev('12:00', 'paused', 'Paused by you.')), 'other');
});

test('a stop waits until the run resumes, ends, or its ticket moves on; one still open has no wait', () => {
  const stops = runStops([
    ev('09:00', 'paused', 'Needs a decision: Review still matches its loop back to Implement.', 'e1'),
    ev('09:45', 'resumed', 'Resumed.'),
    ev('10:03', 'entry-gate', 'PRX-2 is waiting for approval: Approve.', 'e2'),
    ev('10:17', 'entry-done', 'PRX-2 finished.', 'e2'),
    ev('11:00', 'paused', 'PRX-3 could not be started: needs workspace trust.')
  ], [entry('e1', 'PRX-1'), entry('e2', 'PRX-2')]);
  assert.deepEqual(stops.map(stop => [stop.kind, stop.waitedMs && stop.waitedMs / 60000, stop.issueKey]), [['loop', 45, 'PRX-1'], ['approval', 14, 'PRX-2'], ['blocked', undefined, 'PRX-3']]);
  const groups = groupStops(stops);
  assert.deepEqual(groups.map(group => [group.kind, group.count]), [['loop', 1], ['approval', 1], ['blocked', 1]]);
});

test('109 hand-overs fold into a few pairs and are flagged as bouncing', () => {
  const handovers = [
    ...Array.from({ length: 55 }, (_, i) => ({ at: `2026-11-01T11:${String(24 + (i % 30)).padStart(2, '0')}:00.000Z`, from: 'codex-cli', to: 'claude-code-cli', usedPercent: 95 })),
    ...Array.from({ length: 50 }, () => ({ at: '2026-11-01T13:00:00.000Z', from: 'claude-code-cli', to: 'codex-cli', usedPercent: 98 })),
    ...Array.from({ length: 4 }, () => ({ at: '2026-11-01T14:48:00.000Z', from: 'claude-code-cli', to: 'antigravity-cli', usedPercent: 99 }))
  ];
  const summary = summarizeHandovers(handovers);
  assert.equal(summary.total, 109);
  assert.equal(summary.bounced, true);
  assert.deepEqual(summary.pairs.map(pair => pair.count), [55, 50, 4]);
  // One ordinary switch, or a chain through every provider once, is not bouncing.
  assert.equal(summarizeHandovers([{ at: 't', from: 'codex-cli', to: 'claude-code-cli', usedPercent: 95 }]).bounced, false);
  assert.equal(summarizeHandovers([
    { at: 't', from: 'codex-cli', to: 'custom:minimax', usedPercent: 95 },
    { at: 't', from: 'codex-cli', to: 'z-ai', usedPercent: 95 },
    { at: 't', from: 'codex-cli', to: 'claude-code-cli', usedPercent: 95 }
  ]).bounced, false);
});

test('the raw ledger folds a burst of the same event into one line with a count', () => {
  const lines = collapseLedger([
    ev('11:24', 'provider-handover', 'PRX-T113-501: codex-cli → claude-code-cli at 95%, checkpoint 65541b9d.', 'e6'),
    ev('11:25', 'provider-handover', 'PRX-T113-501: codex-cli → claude-code-cli at 95%, checkpoint 982efb60.', 'e6'),
    ev('11:26', 'provider-handover', 'PRX-T113-501: codex-cli → claude-code-cli at 95%, checkpoint 2618bb0c.', 'e6'),
    ev('11:27', 'provider-handover', 'PRX-T113-501: claude-code-cli → codex-cli at 98%, checkpoint aaaa1111.', 'e6'),
    ev('11:28', 'entry-done', 'PRX-T113-501 finished.', 'e6')
  ]);
  // Alternating directions still fold: it is one burst of hand-overs on one ticket.
  assert.deepEqual(lines.map(line => line.count), [4, 1]);
  assert.equal(lines[0].lastAt, '2026-11-01T11:27:00.000Z');
  // A pause and its resume alternate, so they never fold together.
  const alternating = collapseLedger([ev('09:00', 'paused', 'Needs a decision.', 'e1'), ev('09:10', 'resumed', 'Running again.', 'e1'), ev('09:20', 'paused', 'Needs a decision.', 'e1')]);
  assert.equal(alternating.length, 3);
});

test('waits and long messages read short', () => {
  assert.equal(formatWait(541 * 60000), '9h 01m');
  assert.equal(formatWait(20000), 'under a minute');
  assert.equal(formatWait(0), '0m');
  assert.equal(firstLine('Implement failed: made no changes. It said: I have not edited files, run gates…'), 'Implement failed: made no changes.');
  assert.ok(firstLine('x'.repeat(300)).length <= 140);
});
