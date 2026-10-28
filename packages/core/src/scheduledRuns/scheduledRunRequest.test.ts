import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSummary } from '../types';
import {
  ScheduledRunRequestError,
  isScheduledRunRequestFile,
  parseScheduledRunRequest,
  resolveScheduledRunRequest,
  scheduledRunRequestRunId,
  scheduledRunRequestStatusFile
} from './scheduledRunRequest';

function issue(key: string, planningId: string, dependsOn: string[] = [], statusCategory = 'To Do'): IssueSummary {
  return { key, planningId, summary: `${planningId}: Title`, status: 'To Do', statusCategory, issueType: 'Task', projectKey: 'PRX', ...(dependsOn.length ? { dependsOn } : {}) };
}

const BOARD = [
  issue('PRX-1', 'TASK-1'),
  issue('PRX-2', 'TASK-2', ['PRX-1']),
  issue('PRX-3', 'TASK-3', ['PRX-2']),
  issue('PRX-0', 'TASK-0', [], 'done')
];

function request(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'praxis.scheduledRunRequest',
    name: 'Night run',
    date: '2026-11-01',
    time: '22:00',
    timezone: 'Europe/London',
    tickets: ['TASK-1', 'TASK-2'],
    ...extra
  });
}

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ScheduledRunRequestError);
    return error.problems;
  }
  assert.fail('expected a ScheduledRunRequestError');
}

test('parse accepts a minimal request and defaults order to as-listed', () => {
  const parsed = parseScheduledRunRequest(request());
  assert.equal(parsed.order, 'as-listed');
  assert.deepEqual(parsed.tickets, ['TASK-1', 'TASK-2']);
  assert.deepEqual(parsed.satisfiedDependencies, []);
});

test('parse reports every shape problem at once', () => {
  const found = problems(() => parseScheduledRunRequest(JSON.stringify({ schemaVersion: 2, kind: 'x', date: '1/11/2026', time: '10pm', tickets: [] })));
  assert.ok(found.length >= 6, found.join('\n'));
  assert.deepEqual(problems(() => parseScheduledRunRequest('{ nope')).length, 1);
});

test('resolve matches plan IDs and board keys and keeps the listed order', () => {
  const resolved = resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-1', 'PRX-2', 'TASK-3'] })), BOARD, 'project:p1');
  assert.deepEqual(resolved.tickets.map(ticket => ticket.issueKey), ['PRX-1', 'PRX-2', 'PRX-3']);
  assert.equal(resolved.tickets[0].connectionId, 'project:p1');
  assert.deepEqual(resolved.entries.map(entry => entry.planningId), ['TASK-1', 'TASK-2', 'TASK-3']);
});

test('as-listed rejects a ticket placed before its dependency', () => {
  const found = problems(() => resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-2', 'TASK-1'] })), BOARD, 'c'));
  assert.match(found.join(' '), /TASK-2 \(PRX-2\) is listed before its dependency TASK-1/);
});

test('dependencies order sorts stably and detects cycles', () => {
  const sorted = resolveScheduledRunRequest(parseScheduledRunRequest(request({ order: 'dependencies', tickets: ['TASK-3', 'TASK-2', 'TASK-1'] })), BOARD, 'c');
  assert.deepEqual(sorted.tickets.map(ticket => ticket.issueKey), ['PRX-1', 'PRX-2', 'PRX-3']);
  const cyclic = [issue('A-1', 'T-A', ['A-2']), issue('A-2', 'T-B', ['A-1'])];
  const found = problems(() => resolveScheduledRunRequest(parseScheduledRunRequest(request({ order: 'dependencies', tickets: ['T-A', 'T-B'] })), cyclic, 'c'));
  assert.match(found.join(' '), /cycle/);
});

test('an unqueued dependency must be done or declared satisfied', () => {
  const found = problems(() => resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-2'] })), BOARD, 'c'));
  assert.match(found.join(' '), /depends on TASK-1 \(PRX-1\), which is not in the queue/);
  const ok = resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-2'], satisfiedDependencies: ['TASK-1'] })), BOARD, 'c');
  assert.deepEqual(ok.tickets.map(ticket => ticket.issueKey), ['PRX-2']);
  const board = [issue('PRX-1', 'TASK-1', [], 'done'), issue('PRX-2', 'TASK-2', ['PRX-1'])];
  assert.equal(resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-2'] })), board, 'c').tickets.length, 1);
});

test('resolve rejects unknown, duplicate and ambiguous references and warns about done tickets', () => {
  const ambiguous = [...BOARD, issue('PRX-9', 'TASK-1')];
  const found = problems(() => resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-1', 'NOPE', 'PRX-0', 'PRX-0'] })), ambiguous, 'c'));
  const text = found.join('\n');
  assert.match(text, /TASK-1 matches more than one board item/);
  assert.match(text, /NOPE was not found/);
  assert.match(text, /listed more than once/);
  const warned = resolveScheduledRunRequest(parseScheduledRunRequest(request({ tickets: ['TASK-0'] })), BOARD, 'c');
  assert.match(warned.warnings[0], /already done/);
});

test('file naming helpers', () => {
  assert.equal(isScheduledRunRequestFile('night.json'), true);
  assert.equal(isScheduledRunRequestFile('night.status.json'), false);
  assert.equal(isScheduledRunRequestFile('.night.json'), false);
  assert.equal(scheduledRunRequestStatusFile('night.json'), 'night.status.json');
  assert.equal(scheduledRunRequestRunId('p1', 'night.json'), scheduledRunRequestRunId('p1', 'night.json'));
  assert.notEqual(scheduledRunRequestRunId('p1', 'night.json'), scheduledRunRequestRunId('p2', 'night.json'));
});
