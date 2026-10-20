import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTicketsToScheduledRun,
  armScheduledRun,
  createScheduledRun,
  dueScheduledRuns,
  holdScheduledRun,
  moveEntryInScheduledRun,
  nextScheduledRun,
  reconcileScheduledRunOnLaunch,
  removeEntryFromScheduledRun,
  renameScheduledRun,
  rescheduleScheduledRun,
  resolveMissedScheduledRun,
  type ScheduledRun,
  type ScheduledTicketRef
} from './scheduledRun';
import { assessScheduledRunReadiness, type ScheduledTicketProbe } from './scheduledRunReadiness';
import { instantToZonedParts, zonedTimeToInstant } from './scheduledRunTime';

const NOW = '2026-10-20T10:00:00.000Z';
const LATER = '2026-10-21T21:00:00.000Z';

function ref(key: string, connectionId = 'c1'): ScheduledTicketRef {
  return { connectionId, issueKey: key, title: `Title ${key}` };
}

function draft(keys: string[] = ['PRX-1', 'PRX-2', 'PRX-3']): ScheduledRun {
  return createScheduledRun({ name: 'Nightly', scheduledStartAt: LATER, timezone: 'Europe/London', tickets: keys.map(key => ref(key)), at: NOW });
}

const keys = (run: ScheduledRun) => run.entries.map(entry => entry.ticket.issueKey);
const sequences = (run: ScheduledRun) => run.entries.map(entry => entry.sequence);

test('a new schedule is a draft with a contiguous 1-based queue in the order given', () => {
  const run = draft();
  assert.equal(run.status, 'draft');
  assert.deepEqual(keys(run), ['PRX-1', 'PRX-2', 'PRX-3']);
  assert.deepEqual(sequences(run), [1, 2, 3]);
  assert.equal(run.policy.mode, 'sequential');
  assert.deepEqual(run.attempts, []);
  assert.equal(new Set(run.entries.map(entry => entry.id)).size, 3);
});

test('empty and single-ticket schedules are valid definitions', () => {
  assert.deepEqual(draft([]).entries, []);
  const single = draft(['PRX-9']);
  assert.deepEqual(sequences(single), [1]);
});

test('creation validates the name, start and timezone', () => {
  const base = { scheduledStartAt: LATER, timezone: 'Europe/London', at: NOW };
  assert.throws(() => createScheduledRun({ ...base, name: '   ' }), /needs a name/);
  assert.throws(() => createScheduledRun({ ...base, name: 'x', scheduledStartAt: 'not a date' }), /not a valid date/);
  assert.throws(() => createScheduledRun({ ...base, name: 'x', timezone: 'Mars/Olympus' }), /not a known timezone/);
});

test('duplicate tickets collapse, keyed by connection and key', () => {
  const run = createScheduledRun({
    name: 'x', scheduledStartAt: LATER, timezone: 'UTC', at: NOW,
    tickets: [ref('PRX-1'), ref('PRX-1'), ref('PRX-1', 'c2')]
  });
  assert.equal(run.entries.length, 2);
});

test('reordering renumbers and keeps entry ids stable', () => {
  const run = draft();
  const ids = run.entries.map(entry => entry.id);
  const moved = moveEntryInScheduledRun(run, ids[2], 0, NOW);
  assert.deepEqual(keys(moved), ['PRX-3', 'PRX-1', 'PRX-2']);
  assert.deepEqual(sequences(moved), [1, 2, 3]);
  assert.deepEqual(moved.entries.map(entry => entry.id), [ids[2], ids[0], ids[1]]);
  assert.equal(moved.events.at(-1)?.kind, 'reordered');
  // The original is untouched.
  assert.deepEqual(keys(run), ['PRX-1', 'PRX-2', 'PRX-3']);
});

test('moving clamps out-of-range positions and ignores a no-op move', () => {
  const run = draft();
  const first = run.entries[0].id;
  assert.deepEqual(keys(moveEntryInScheduledRun(run, first, 99, NOW)), ['PRX-2', 'PRX-3', 'PRX-1']);
  assert.deepEqual(keys(moveEntryInScheduledRun(moveEntryInScheduledRun(run, first, 99, NOW), first, -5, NOW)), ['PRX-1', 'PRX-2', 'PRX-3']);
  assert.equal(moveEntryInScheduledRun(run, first, 0, NOW), run);
  assert.throws(() => moveEntryInScheduledRun(run, 'nope', 0, NOW), /not in this schedule/);
});

test('removing renumbers; adding appends and skips tickets already queued', () => {
  let run = draft();
  run = removeEntryFromScheduledRun(run, run.entries[1].id, NOW);
  assert.deepEqual(keys(run), ['PRX-1', 'PRX-3']);
  assert.deepEqual(sequences(run), [1, 2]);

  const added = addTicketsToScheduledRun(run, [ref('PRX-3'), ref('PRX-4'), ref('PRX-5')], NOW);
  assert.deepEqual(keys(added), ['PRX-1', 'PRX-3', 'PRX-4', 'PRX-5']);
  assert.deepEqual(sequences(added), [1, 2, 3, 4]);
  assert.equal(addTicketsToScheduledRun(added, [ref('PRX-4')], NOW), added);
});

test('the board is never consulted: order lives only on the schedule', () => {
  // The model has no board input at all; a move changes only the schedule's own sequence.
  const before = draft();
  const run = moveEntryInScheduledRun(before, before.entries[0].id, 2, NOW);
  assert.deepEqual(Object.keys(run.entries[0]).sort(), ['id', 'sequence', 'ticket']);
  assert.deepEqual(keys(run), ['PRX-2', 'PRX-3', 'PRX-1']);
});

test('rename and reschedule validate and record events', () => {
  let run = renameScheduledRun(draft(), '  Sprint 42  ', NOW);
  assert.equal(run.name, 'Sprint 42');
  assert.throws(() => renameScheduledRun(run, ' ', NOW), /needs a name/);
  run = rescheduleScheduledRun(run, '2026-11-01T09:00:00Z', 'America/New_York', NOW);
  assert.equal(run.scheduledStartAt, '2026-11-01T09:00:00.000Z');
  assert.equal(run.timezone, 'America/New_York');
  assert.equal(run.events.at(-1)?.kind, 'rescheduled');
  assert.throws(() => rescheduleScheduledRun(run, 'junk', 'UTC', NOW), /not a valid date/);
});

test('arming needs a ticket and a future start; hold reverses it', () => {
  assert.throws(() => armScheduledRun(draft([]), NOW), /at least one ticket/);
  const past = createScheduledRun({ name: 'x', scheduledStartAt: '2026-10-19T00:00:00Z', timezone: 'UTC', tickets: [ref('PRX-1')], at: NOW });
  assert.throws(() => armScheduledRun(past, NOW), /already passed/);

  const armed = armScheduledRun(draft(), NOW);
  assert.equal(armed.status, 'scheduled');
  assert.equal(armScheduledRun(armed, NOW), armed);
  assert.equal(holdScheduledRun(armed, NOW).status, 'draft');
});

test('only draft and scheduled runs can be edited', () => {
  const missed = reconcileScheduledRunOnLaunch(armScheduledRun(draft(), NOW), '2026-10-22T00:00:00Z');
  assert.equal(missed.status, 'missed');
  assert.throws(() => renameScheduledRun(missed, 'x', NOW), /can no longer be edited/);
  assert.throws(() => addTicketsToScheduledRun(missed, [ref('PRX-9')], NOW), /can no longer be edited/);
});

test('a start that passed while closed becomes missed, and only a choice resolves it', () => {
  const armed = armScheduledRun(draft(), NOW);
  assert.equal(reconcileScheduledRunOnLaunch(armed, '2026-10-21T20:59:59Z'), armed);

  const missed = reconcileScheduledRunOnLaunch(armed, '2026-10-22T08:00:00Z');
  assert.equal(missed.status, 'missed');
  assert.equal(missed.events.at(-1)?.kind, 'missed');
  assert.deepEqual(dueScheduledRuns([missed], '2026-10-22T08:00:00Z'), []);

  const skipped = resolveMissedScheduledRun(missed, 'skip', '2026-10-22T08:01:00Z');
  assert.equal(skipped.status, 'cancelled');

  const late = resolveMissedScheduledRun(missed, 'start-now', '2026-10-22T08:01:00Z');
  assert.equal(late.status, 'scheduled');
  assert.equal(late.scheduledStartAt, '2026-10-22T08:01:00.000Z');
  assert.deepEqual(dueScheduledRuns([late], '2026-10-22T08:01:00Z').map(run => run.id), [late.id]);

  assert.throws(() => resolveMissedScheduledRun(armed, 'skip', NOW), /Only a missed run/);
});

test('due and next runs ignore drafts and sort soonest first', () => {
  const a = armScheduledRun(createScheduledRun({ name: 'a', scheduledStartAt: '2026-10-22T10:00:00Z', timezone: 'UTC', tickets: [ref('A-1')], at: NOW }), NOW);
  const b = armScheduledRun(createScheduledRun({ name: 'b', scheduledStartAt: '2026-10-21T10:00:00Z', timezone: 'UTC', tickets: [ref('B-1')], at: NOW }), NOW);
  const c = createScheduledRun({ name: 'c', scheduledStartAt: '2026-10-20T11:00:00Z', timezone: 'UTC', tickets: [ref('C-1')], at: NOW });
  assert.equal(nextScheduledRun([a, b, c])?.name, 'b');
  assert.deepEqual(dueScheduledRuns([a, b, c], '2026-10-22T12:00:00Z').map(run => run.name), ['b', 'a']);
  assert.equal(nextScheduledRun([c]), undefined);
});

// ---- readiness -------------------------------------------------------------

function ready(run: ScheduledRun, probes: Record<string, ScheduledTicketProbe> = {}, usableProviderCount = 2) {
  return assessScheduledRunReadiness(run, {
    now: NOW,
    usableProviderCount,
    probe: ticket => probes[ticket.issueKey] ?? { state: 'found', hasFolder: true, hasWorkflow: true, hasAcceptanceCriteria: true }
  });
}

test('a healthy schedule is ready with no issues', () => {
  assert.deepEqual(ready(draft()), { ready: true, issues: [] });
});

test('blockers make a schedule not ready and name the ticket', () => {
  const run = draft();
  const result = ready(run, {
    'PRX-1': { state: 'missing' },
    'PRX-2': { state: 'moved' },
    'PRX-3': { state: 'found', closed: true, hasFolder: false, hasWorkflow: false }
  });
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.issues.map(issue => issue.code),
    ['ticket-missing', 'ticket-moved', 'ticket-closed', 'no-folder', 'no-workflow']
  );
  assert.equal(result.issues[0].entryId, run.entries[0].id);
  assert.match(result.issues[0].message, /PRX-1 no longer exists/);
});

test('warnings do not block', () => {
  const result = ready(draft(), {
    'PRX-1': { state: 'found', hasFolder: true, hasWorkflow: true, hasAcceptanceCriteria: false, inOtherSchedule: 'Sprint 42' }
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues.map(issue => issue.code), ['no-acceptance-criteria', 'in-other-schedule']);
  assert.ok(result.issues.every(issue => issue.severity === 'warning'));
});

test('empty queue, a past start and no provider are blockers', () => {
  const past = createScheduledRun({ name: 'x', scheduledStartAt: '2026-10-19T00:00:00Z', timezone: 'UTC', at: NOW });
  const result = ready(past, {}, 0);
  assert.deepEqual(result.issues.map(issue => issue.code).sort(), ['no-provider', 'no-tickets', 'start-in-past']);
});

test('a scheduled run whose time has come is due, not flagged as late', () => {
  const armed = armScheduledRun(draft(), NOW);
  const result = assessScheduledRunReadiness(armed, { now: '2026-10-22T00:00:00Z', usableProviderCount: 1, probe: () => ({ state: 'found' }) });
  assert.ok(!result.issues.some(issue => issue.code === 'start-in-past'));
  assert.equal(result.ready, true);
});

test('a finished run is not flagged for a past start', () => {
  const missed = reconcileScheduledRunOnLaunch(armScheduledRun(draft(), NOW), '2026-10-22T00:00:00Z');
  const result = assessScheduledRunReadiness(missed, { now: '2026-10-22T00:00:00Z', usableProviderCount: 1, probe: () => ({ state: 'found' }) });
  assert.ok(!result.issues.some(issue => issue.code === 'start-in-past'));
});

// ---- timezone round trips --------------------------------------------------

test('wall time round-trips through an instant', () => {
  const instant = zonedTimeToInstant('2026-10-21', '22:00', 'Europe/London');
  assert.equal(instant, '2026-10-21T21:00:00.000Z'); // BST, UTC+1
  assert.deepEqual(instantToZonedParts(instant!, 'Europe/London'), { date: '2026-10-21', time: '22:00' });
  assert.deepEqual(instantToZonedParts(instant!, 'America/New_York'), { date: '2026-10-21', time: '17:00' });
  assert.equal(zonedTimeToInstant('2026-01-15', '09:30', 'Asia/Kolkata'), '2026-01-15T04:00:00.000Z');
});

test('a wall time skipped by clocks going forward has no instant', () => {
  assert.equal(zonedTimeToInstant('2027-03-28', '01:30', 'Europe/London'), undefined);
  assert.equal(zonedTimeToInstant('2027-03-28', '02:30', 'Europe/London'), '2027-03-28T01:30:00.000Z');
});

test('a wall time repeated by clocks going back resolves to the first occurrence', () => {
  // 25 Oct 2026: 02:00 BST falls back to 01:00 GMT, so 01:30 happens at 00:30Z and again at 01:30Z.
  assert.equal(zonedTimeToInstant('2026-10-25', '01:30', 'Europe/London'), '2026-10-25T00:30:00.000Z');
});

test('invalid dates, times and zones return undefined', () => {
  assert.equal(zonedTimeToInstant('2026-02-31', '10:00', 'UTC'), undefined);
  assert.equal(zonedTimeToInstant('2026-13-01', '10:00', 'UTC'), undefined);
  assert.equal(zonedTimeToInstant('2026-10-21', '25:00', 'UTC'), undefined);
  assert.equal(zonedTimeToInstant('2026-10-21', '10:00', 'Mars/Olympus'), undefined);
  assert.equal(zonedTimeToInstant('21/10/2026', '10:00', 'UTC'), undefined);
  assert.equal(instantToZonedParts('garbage', 'UTC'), undefined);
});

// ---- compose (what the editor submits) ------------------------------------

import { composeScheduledRun } from './scheduledRun';

const FORM = { name: 'Nightly', date: '2026-10-21', time: '22:00', timezone: 'Europe/London', arm: false, at: NOW };

test('composing a new schedule converts the wall time and keeps the ticket order', () => {
  const run = composeScheduledRun(undefined, { ...FORM, tickets: [ref('PRX-3'), ref('PRX-1'), ref('PRX-2')] });
  assert.equal(run.status, 'draft');
  assert.equal(run.scheduledStartAt, '2026-10-21T21:00:00.000Z');
  assert.deepEqual(keys(run), ['PRX-3', 'PRX-1', 'PRX-2']);
  assert.deepEqual(sequences(run), [1, 2, 3]);
});

test('composing with arm schedules it, and refuses an empty queue or a past start', () => {
  assert.equal(composeScheduledRun(undefined, { ...FORM, arm: true, tickets: [ref('PRX-1')] }).status, 'scheduled');
  assert.throws(() => composeScheduledRun(undefined, { ...FORM, arm: true, tickets: [] }), /at least one ticket/);
  assert.throws(() => composeScheduledRun(undefined, { ...FORM, arm: true, date: '2026-10-19', tickets: [ref('PRX-1')] }), /already passed/);
});

test('composing rejects a nonexistent wall time and an unknown zone with a readable message', () => {
  assert.throws(() => composeScheduledRun(undefined, { ...FORM, date: '2027-03-28', time: '01:30', tickets: [ref('PRX-1')] }), /not a valid time in Europe\/London/);
  assert.throws(() => composeScheduledRun(undefined, { ...FORM, timezone: 'Mars/Olympus', tickets: [ref('PRX-1')] }), /not a known timezone/);
});

test('editing keeps entry ids for surviving tickets and records what changed', () => {
  const first = composeScheduledRun(undefined, { ...FORM, tickets: [ref('PRX-1'), ref('PRX-2'), ref('PRX-3')] });
  const id = (run: ScheduledRun, key: string) => run.entries.find(entry => entry.ticket.issueKey === key)?.id;

  const edited = composeScheduledRun(first, { ...FORM, at: '2026-10-20T11:00:00.000Z', tickets: [ref('PRX-3'), ref('PRX-1'), ref('PRX-9')] });
  assert.deepEqual(keys(edited), ['PRX-3', 'PRX-1', 'PRX-9']);
  assert.equal(id(edited, 'PRX-1'), id(first, 'PRX-1'));
  assert.equal(id(edited, 'PRX-3'), id(first, 'PRX-3'));
  assert.equal(id(edited, 'PRX-2'), undefined);
  assert.deepEqual(edited.events.slice(first.events.length).map(event => event.kind), ['ticket-removed', 'tickets-added', 'reordered']);
  assert.equal(edited.id, first.id);
  assert.equal(edited.createdAt, first.createdAt);
});

test('an unchanged resubmission changes nothing', () => {
  const first = composeScheduledRun(undefined, { ...FORM, tickets: [ref('PRX-1'), ref('PRX-2')] });
  const again = composeScheduledRun(first, { ...FORM, tickets: [ref('PRX-1'), ref('PRX-2')] });
  assert.deepEqual(again, first);
});

test('editing an armed schedule can hold it, and a started one cannot be edited', () => {
  const armed = composeScheduledRun(undefined, { ...FORM, arm: true, tickets: [ref('PRX-1')] });
  assert.equal(composeScheduledRun(armed, { ...FORM, arm: false, tickets: [ref('PRX-1')] }).status, 'draft');
  assert.throws(() => composeScheduledRun({ ...armed, status: 'running' }, { ...FORM, tickets: [ref('PRX-1')] }), /can no longer be edited/);
});

test('moving an armed schedule to a past time is refused rather than quietly kept', () => {
  const armed = composeScheduledRun(undefined, { ...FORM, arm: true, tickets: [ref('PRX-1')] });
  assert.throws(
    () => composeScheduledRun(armed, { ...FORM, arm: true, date: '2026-10-19', tickets: [ref('PRX-1')] }),
    /already passed/
  );
});

test('a schedule remembers its project and keeps it through edits', () => {
  const first = composeScheduledRun(undefined, { ...FORM, projectId: 'p1', tickets: [ref('PRX-1')] });
  assert.equal(first.projectId, 'p1');
  const edited = composeScheduledRun(first, { ...FORM, projectId: 'other', name: 'Renamed', tickets: [ref('PRX-1'), ref('PRX-2')] });
  assert.equal(edited.projectId, 'p1');
  assert.equal(composeScheduledRun(undefined, { ...FORM, tickets: [] }).projectId, undefined);
});
