import * as assert from 'node:assert';
import { applyBoardColumnPreferences, getDefaultStatusColumnOrder } from '../views/boardColumnLayout';
import type { BoardDetails } from '../types';

function createBoardDetails(): BoardDetails {
  return {
    board: {
      id: 'board-1',
      name: 'Test Board',
      type: 'epic'
    },
    issues: [
      {
        key: 'KAMAI-39',
        summary: 'Clarify implementation plan',
        status: 'In Progress',
        issueType: 'Task',
        projectKey: 'KAMAI'
      }
    ],
    columns: [
      {
        id: 'status:Backlog',
        name: 'Backlog',
        issues: []
      },
      {
        id: 'status:In Progress',
        name: 'In Progress',
        issues: [
          {
            key: 'KAMAI-39',
            summary: 'Clarify implementation plan',
            status: 'In Progress',
            issueType: 'Task',
            projectKey: 'KAMAI'
          }
        ]
      }
    ],
    columnStatusOrder: ['Selected for Development', 'In Progress', 'Review', 'Done', 'Backlog']
  };
}

suite('boardColumnLayout', () => {
  test('uses the exact workflow order supplied by the board details', () => {
    const details = createBoardDetails();

    assert.deepStrictEqual(getDefaultStatusColumnOrder(details), [
      'Selected for Development',
      'In Progress',
      'Review',
      'Done',
      'Backlog'
    ]);
  });

  test('applies default workflow ordering without forcing backlog to the front', () => {
    const details = createBoardDetails();

    const result = applyBoardColumnPreferences(details, {
      workflowStatuses: [],
      orderedStatuses: []
    });

    assert.deepStrictEqual(result.columns.map(column => column.name), [
      'Selected for Development',
      'In Progress',
      'Review',
      'Done',
      'Backlog'
    ]);
  });
});