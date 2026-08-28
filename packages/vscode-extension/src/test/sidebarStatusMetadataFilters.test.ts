import * as assert from 'assert';
import type { IssueFilters } from '@ticket-manager/core';
import { buildEpicStatusMetadataFilters } from '../views/epicsSidebarViewProvider';
import { buildIssueStatusMetadataFilters } from '../views/issuesSidebarViewProvider';

function createFilters(): IssueFilters {
  return {
    projectKeys: ['APP'],
    statuses: ['Blocked'],
    issueTypes: ['Story'],
    searchText: 'auth',
    assigneeMode: 'me',
    parentKey: 'APP-1',
    grouping: 'status'
  };
}

suite('Sidebar status metadata filters', () => {
  test('issue status metadata ignores search and broadens assignee scope', () => {
    const result = buildIssueStatusMetadataFilters(createFilters());

    assert.deepStrictEqual(result.projectKeys, ['APP']);
    assert.deepStrictEqual(result.statuses, []);
    assert.deepStrictEqual(result.issueTypes, []);
    assert.strictEqual(result.searchText, '');
    assert.strictEqual(result.assigneeMode, 'all');
    assert.strictEqual(result.parentKey, 'APP-1');
    assert.strictEqual(result.grouping, 'status');
  });

  test('epic status metadata ignores issue-only filters and widens assignee scope', () => {
    const result = buildEpicStatusMetadataFilters(createFilters());

    assert.deepStrictEqual(result.projectKeys, ['APP']);
    assert.deepStrictEqual(result.statuses, []);
    assert.deepStrictEqual(result.issueTypes, []);
    assert.strictEqual(result.searchText, '');
    assert.strictEqual(result.assigneeMode, 'all');
    assert.strictEqual(result.parentKey, undefined);
    assert.strictEqual(result.grouping, 'status');
  });
});
