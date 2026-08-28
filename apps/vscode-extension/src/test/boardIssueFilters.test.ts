import * as assert from 'node:assert';
import { filterBoardIssues } from '@praxis/core';
import type { BoardColumnPreferences, IssueSummary } from '@praxis/core';

function prefs(overrides: Partial<BoardColumnPreferences> = {}): BoardColumnPreferences {
  return {
    workflowStatuses: [],
    orderedStatuses: [],
    ...overrides
  };
}

function issue(key: string, updated?: string): IssueSummary {
  return {
    key,
    summary: key,
    status: 'To Do',
    issueType: 'Task',
    projectKey: 'TEST',
    updated
  };
}

suite('boardIssueFilters', () => {
  test('allows stale issues by default', () => {
    const result = filterBoardIssues(
      [issue('OLD', '2000-01-01T00:00:00.000Z'), issue('UNKNOWN')],
      prefs()
    );

    assert.deepStrictEqual(result.map(i => i.key), ['OLD', 'UNKNOWN']);
  });

  test('hides stale updated issues when max age is enabled', () => {
    const result = filterBoardIssues(
      [issue('OLD', '2000-01-01T00:00:00.000Z'), issue('UNKNOWN')],
      prefs({ maxAgeWeeks: 2 })
    );

    assert.deepStrictEqual(result.map(i => i.key), ['UNKNOWN']);
  });
});
