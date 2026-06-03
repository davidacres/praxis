import * as assert from 'node:assert';
import {
  normalizeLinkedIssueReferences,
  resolveBoardWorkflowStatusOrder,
  shouldFallbackToLegacySearch
} from '../jira/jiraCloudService';

suite('jiraCloudService', () => {
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

  test('merges classic issue links with remote links', () => {
    const links = normalizeLinkedIssueReferences(
      {
        issuelinks: [
          {
            type: {
              outward: 'code implemented in'
            },
            outwardIssue: {
              key: 'APP-77',
              fields: {
                summary: 'Implement delivery workflow',
                issuetype: { name: 'Task' },
                status: { name: 'Done' }
              }
            }
          }
        ]
      },
      [
        {
          relationship: 'resolved in',
          object: {
            title: 'APP-88 Release package update',
            summary: 'Release package update',
            url: 'https://jira.example.com/browse/APP-88'
          }
        }
      ],
      'https://jira.example.com'
    );

    assert.deepStrictEqual(links, [
      {
        key: 'APP-77',
        summary: 'Implement delivery workflow',
        issueType: 'Task',
        status: 'Done',
        relationship: 'code implemented in',
        browseUrl: 'https://jira.example.com/browse/APP-77',
        raw: {
          type: {
            outward: 'code implemented in'
          },
          outwardIssue: {
            key: 'APP-77',
            fields: {
              summary: 'Implement delivery workflow',
              issuetype: { name: 'Task' },
              status: { name: 'Done' }
            }
          }
        }
      },
      {
        key: 'APP-88',
        summary: 'Release package update',
        status: undefined,
        relationship: 'resolved in',
        browseUrl: 'https://jira.example.com/browse/APP-88',
        raw: {
          relationship: 'resolved in',
          object: {
            title: 'APP-88 Release package update',
            summary: 'Release package update',
            url: 'https://jira.example.com/browse/APP-88'
          }
        }
      }
    ]);
  });

  test('falls back to classic search when enhanced Jira search is rejected for auth or scope reasons', () => {
    assert.strictEqual(
      shouldFallbackToLegacySearch(new Error('403 Forbidden: OAuth 2.0 scopes are insufficient for this resource.')),
      true
    );
    assert.strictEqual(
      shouldFallbackToLegacySearch('401 Unauthorized'),
      true
    );
  });

  test('does not fall back to classic search for unrelated Jira query errors', () => {
    assert.strictEqual(
      shouldFallbackToLegacySearch(new Error('Invalid JQL: Expecting operator but got ORDER.')),
      false
    );
  });
});
