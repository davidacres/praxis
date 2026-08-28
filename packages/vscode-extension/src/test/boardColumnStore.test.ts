import * as assert from 'node:assert';
import { repairLegacyBacklogStatusPreferences } from '@ticket-manager/core';
import type { BoardColumnPreferences } from '@ticket-manager/core';

suite('boardColumnStore', () => {
  test('realigns legacy backlog-first workflow preferences to current workflow order', () => {
    const prefs: BoardColumnPreferences = {
      workflowStatuses: ['Backlog', 'Selected for Development', 'In Progress', 'Review', 'Done'],
      orderedStatuses: []
    };

    const repaired = repairLegacyBacklogStatusPreferences(prefs, [
      'Selected for Development',
      'In Progress',
      'Review',
      'Done',
      'Backlog'
    ]);

    assert.deepStrictEqual(repaired.workflowStatuses, []);
  });

  test('realigns arbitrary stale backlog-first permutations to the current workflow order', () => {
    const prefs: BoardColumnPreferences = {
      workflowStatuses: [],
      orderedStatuses: ['Backlog', 'In Progress', 'Done', 'Review', 'To Do']
    };

    const repaired = repairLegacyBacklogStatusPreferences(prefs, [
      'To Do',
      'In Progress',
      'Review',
      'Done',
      'Backlog'
    ]);

    assert.deepStrictEqual(repaired.orderedStatuses, []);
  });

  test('realigns legacy backlog-first ordered statuses for existing boards', () => {
    const prefs: BoardColumnPreferences = {
      workflowStatuses: [],
      orderedStatuses: ['Backlog', 'In Progress', 'Done']
    };

    const repaired = repairLegacyBacklogStatusPreferences(prefs, [
      'Selected for Development',
      'In Progress',
      'Review',
      'Done',
      'Backlog'
    ]);

    assert.deepStrictEqual(repaired.orderedStatuses, ['In Progress', 'Done', 'Backlog']);
  });
});