import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledTicketTransition } from './scheduledTicketStatus';
import { categoryOfStatus } from '../projects/projectWorkflow';
import type { ProjectWorkflowStage } from '../projects/projectTypes';

const moves = (...statuses: string[]) => statuses.map((status, index) => ({ id: `t${index}`, name: `Move to ${status}`, toStatus: status }));

test('a ticket starts in the first in-flight stage, preferring it over Blocked', () => {
  const transitions = moves('Blocked', 'In Progress', 'Done');
  assert.equal(scheduledTicketTransition('Backlog', transitions, 'indeterminate')?.toStatus, 'In Progress');
  assert.equal(scheduledTicketTransition('In Progress', transitions, 'done')?.toStatus, 'Done');
});

test('stages are told apart by the project workflow\'s categories, whatever they are called', () => {
  const workflow: ProjectWorkflowStage[] = [
    { id: 'idea', name: 'Idea', category: 'todo' },
    { id: 'build', name: 'Building', category: 'indeterminate' },
    { id: 'ship', name: 'Shipped', category: 'done' }
  ];
  assert.equal(scheduledTicketTransition('Idea', moves('Building', 'Shipped'), 'indeterminate', workflow)?.toStatus, 'Building');
  assert.equal(scheduledTicketTransition('Building', moves('Idea', 'Shipped'), 'done', workflow)?.toStatus, 'Shipped');
});

test('never moves backwards, never to a stage it cannot place, and not when the board has none of the kind', () => {
  assert.equal(scheduledTicketTransition('Done', moves('In Progress'), 'indeterminate'), undefined);
  assert.equal(scheduledTicketTransition('In Progress', moves('Backlog', 'Done'), 'indeterminate'), undefined);
  assert.equal(scheduledTicketTransition('Backlog', moves('Architecture'), 'indeterminate'), undefined);
  const twoStages: ProjectWorkflowStage[] = [{ id: 'b', name: 'Backlog', category: 'todo' }, { id: 'd', name: 'Done', category: 'done' }];
  assert.equal(scheduledTicketTransition('Backlog', moves('Done'), 'indeterminate', twoStages), undefined);
  assert.equal(scheduledTicketTransition('Backlog', moves('Done'), 'done', twoStages)?.toStatus, 'Done');
});

test('a status with no category reads as unknown rather than guessed from its position', () => {
  assert.equal(categoryOfStatus('Architecture'), undefined);
  assert.equal(categoryOfStatus('Closed'), 'done');
  assert.equal(categoryOfStatus(''), undefined);
});
