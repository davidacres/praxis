import * as assert from 'node:assert';
import { buildJiraCloudApiBaseUrl } from '../jira/jiraCloudOAuthService';

suite('jiraCloudOAuthService', () => {
  test('builds Atlassian Jira Cloud API base URL from cloud id', () => {
    assert.strictEqual(
      buildJiraCloudApiBaseUrl('1324a887-45db-1bf4-1e99-ef0ff456d421'),
      'https://api.atlassian.com/ex/jira/1324a887-45db-1bf4-1e99-ef0ff456d421'
    );
  });

  test('requires a selected cloud id', () => {
    assert.throws(() => buildJiraCloudApiBaseUrl('   '), /No Jira Cloud site is selected/);
  });
});