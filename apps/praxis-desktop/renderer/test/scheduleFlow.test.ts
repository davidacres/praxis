import test from 'node:test';
import assert from 'node:assert/strict';
import { autoDetectParallelSteps, flattenSteps, flowKey, type FlowSteps } from '../src/schedule/scheduleFlow.ts';
import type { Candidate } from '../src/schedule/ScheduleTickets.tsx';
import type { ScheduledTicketRef } from '@praxis/core';

const ticket = (key: string, connectionId = 'project:p1'): ScheduledTicketRef => ({
  connectionId,
  issueKey: key,
  title: `Ticket ${key}`
});

const candidate = (key: string, planningId?: string, dependsOn: string[] = [], connectionId = 'project:p1'): Candidate => ({
  connectionId,
  key,
  title: `Ticket ${key}`,
  status: 'To Do',
  issueType: 'Task',
  finished: false,
  container: false,
  planningId,
  dependsOn
});

test('autoDetectParallelSteps groups independent tickets up to maxConcurrency', () => {
  const tickets = [ticket('PRX-1'), ticket('PRX-2'), ticket('PRX-3'), ticket('PRX-4')];
  const candidates = [candidate('PRX-1'), candidate('PRX-2'), candidate('PRX-3'), candidate('PRX-4')];

  // With maxConcurrency 2: two steps of 2
  const steps2 = autoDetectParallelSteps(tickets, candidates, 2);
  assert.equal(steps2.length, 2);
  assert.deepEqual(steps2[0].map(t => t.issueKey), ['PRX-1', 'PRX-2']);
  assert.deepEqual(steps2[1].map(t => t.issueKey), ['PRX-3', 'PRX-4']);

  const flattened2 = flattenSteps(steps2);
  assert.deepEqual(flattened2.withPrevious, [flowKey(ticket('PRX-2')), flowKey(ticket('PRX-4'))]);

  // With maxConcurrency 3: step of 3 and step of 1
  const steps3 = autoDetectParallelSteps(tickets, candidates, 3);
  assert.equal(steps3.length, 2);
  assert.deepEqual(steps3[0].map(t => t.issueKey), ['PRX-1', 'PRX-2', 'PRX-3']);
  assert.deepEqual(steps3[1].map(t => t.issueKey), ['PRX-4']);

  // With maxConcurrency 1: each in own step
  const steps1 = autoDetectParallelSteps(tickets, candidates, 1);
  assert.equal(steps1.length, 4);
  assert.deepEqual(steps1.map(s => s[0].issueKey), ['PRX-1', 'PRX-2', 'PRX-3', 'PRX-4']);
  assert.deepEqual(flattened2.tickets.map(t => t.issueKey), ['PRX-1', 'PRX-2', 'PRX-3', 'PRX-4']);
});

test('autoDetectParallelSteps respects dependencies across board keys and planning IDs', () => {
  // PRX-1 (TASK-1)
  // PRX-2 (TASK-2) depends on TASK-1
  // PRX-3 (TASK-3) independent
  // PRX-4 (TASK-4) depends on PRX-3
  const tickets = [ticket('PRX-1'), ticket('PRX-2'), ticket('PRX-3'), ticket('PRX-4')];
  const candidates = [
    candidate('PRX-1', 'TASK-1'),
    candidate('PRX-2', 'TASK-2', ['TASK-1']),
    candidate('PRX-3', 'TASK-3'),
    candidate('PRX-4', 'TASK-4', ['PRX-3'])
  ];

  const steps = autoDetectParallelSteps(tickets, candidates, 2);
  assert.equal(steps.length, 2);
  // Step 0: PRX-1 and PRX-3 (both ready, no unplaced deps)
  assert.deepEqual(steps[0].map(t => t.issueKey), ['PRX-1', 'PRX-3']);
  // Step 1: PRX-2 (dep PRX-1 placed) and PRX-4 (dep PRX-3 placed)
  assert.deepEqual(steps[1].map(t => t.issueKey), ['PRX-2', 'PRX-4']);
});

test('autoDetectParallelSteps handles linear dependency chains by keeping single-ticket steps', () => {
  // PRX-1 -> PRX-2 -> PRX-3
  const tickets = [ticket('PRX-1'), ticket('PRX-2'), ticket('PRX-3')];
  const candidates = [
    candidate('PRX-1'),
    candidate('PRX-2', undefined, ['PRX-1']),
    candidate('PRX-3', undefined, ['PRX-2'])
  ];

  const steps = autoDetectParallelSteps(tickets, candidates, 2);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map(s => s[0].issueKey), ['PRX-1', 'PRX-2', 'PRX-3']);
});

test('autoDetectParallelSteps handles empty or single ticket lists', () => {
  assert.deepEqual(autoDetectParallelSteps([], [], 2), []);
  assert.deepEqual(autoDetectParallelSteps([ticket('PRX-1')], [], 2), [[ticket('PRX-1')]]);
});
