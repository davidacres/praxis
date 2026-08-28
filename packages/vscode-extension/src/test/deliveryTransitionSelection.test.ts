import * as assert from 'node:assert';
import { selectNextDeliveryTransition } from '../extension';
import type { WorkflowTransition } from '@ticket-manager/core';

function selectFrom(transitions: WorkflowTransition[]): WorkflowTransition | undefined {
  return selectNextDeliveryTransition({
    status: 'In Progress',
    statusCategory: 'indeterminate',
    transitions
  });
}

suite('deliveryTransitionSelection', () => {
  test('prefers an intermediate forward state over done', () => {
    const selected = selectFrom([
      { id: 'done', name: 'Done', toStatus: 'Done' },
      { id: 'review', name: 'Send to Review', toStatus: 'In Review' }
    ]);

    assert.strictEqual(selected?.id, 'review');
  });

  test('prefers done over blocked when those are the only transitions', () => {
    const selected = selectFrom([
      { id: 'done', name: 'Done', toStatus: 'Done' },
      { id: 'block', name: 'Block', toStatus: 'Blocked' }
    ]);

    assert.strictEqual(selected?.id, 'done');
  });

  test('returns undefined when only non-progress transitions are available', () => {
    const selected = selectFrom([
      { id: 'block', name: 'Block', toStatus: 'Blocked' },
      { id: 'resume', name: 'Resume', toStatus: 'In Progress' }
    ]);

    assert.strictEqual(selected, undefined);
  });
});