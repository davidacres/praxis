import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '../workflows/workflowTypes';
import { workflowForScheduledEntry } from './scheduledRunWorkflow';

test('only the final sequential schedule entry keeps the workflow merge stage', () => {
  const workflow = {
    id: 'delivery',
    name: 'Delivery',
    version: 1,
    nodes: [
      { id: 'implement', name: 'Implement', type: 'agent-task' },
      { id: 'approve', name: 'Approve', type: 'approval' },
      { id: 'merge', name: 'Merge to main', type: 'merge' }
    ],
    edges: [
      { id: 'e-implement-approve', from: 'implement', to: 'approve', on: 'success', required: true },
      { id: 'e-approve-merge', from: 'approve', to: 'merge', on: 'success', required: true }
    ],
    entryNodeId: 'implement'
  } as unknown as WorkflowDefinition;

  const intermediate = workflowForScheduledEntry(workflow, false);
  assert.deepEqual(intermediate.nodes.map(node => node.id), ['implement', 'approve']);
  assert.deepEqual(intermediate.edges.map(edge => edge.id), ['e-implement-approve']);
  assert.equal(workflowForScheduledEntry(workflow, true), workflow);
});
