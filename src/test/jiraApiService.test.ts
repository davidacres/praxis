import * as assert from 'node:assert';
import { resolveBoardWorkflowStatusOrder } from '../jira/jiraApiService';

suite('jiraApiService', () => {
  test('uses exact agile board status order when board configuration is available', () => {
    const orderedStatuses = resolveBoardWorkflowStatusOrder(
      ['Selected for Development', 'In Progress', 'In Review', 'Done'],
      ['Backlog', 'Selected for Development', 'In Progress', 'In Review', 'Done', 'In Planning'],
      ['In Planning', 'Selected for Development']
    );

    assert.deepStrictEqual(orderedStatuses, [
      'Selected for Development',
      'In Progress',
      'In Review',
      'Done'
    ]);
  });

  test('falls back to workflow and issue statuses when board configuration is unavailable', () => {
    const orderedStatuses = resolveBoardWorkflowStatusOrder(
      [],
      ['Backlog', 'Selected for Development', 'In Progress', 'In Review', 'Done', 'Blocked'],
      ['QA Ready']
    );

    assert.deepStrictEqual(orderedStatuses, [
      'Backlog',
      'Selected for Development',
      'In Progress',
      'In Review',
      'Done',
      'Blocked',
      'QA Ready'
    ]);
  });
});