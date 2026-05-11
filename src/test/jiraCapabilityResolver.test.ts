import * as assert from 'node:assert';
import { resolveJiraCapabilities } from '../mcp/jiraCapabilityResolver';

suite('jiraCapabilityResolver', () => {
  test('detects Atlassian cloud Jira tool names and accessible resource discovery', () => {
    const result = resolveJiraCapabilities([
      { name: 'mcp_com_atlassian_getAccessibleAtlassianResources' },
      { name: 'mcp_com_atlassian_getVisibleJiraProjects' },
      { name: 'mcp_com_atlassian_searchJiraIssuesUsingJql' },
      { name: 'mcp_com_atlassian_getJiraIssue' },
      { name: 'mcp_com_atlassian_getTransitionsForJiraIssue' },
      { name: 'mcp_com_atlassian_createJiraIssue' }
    ]);

    assert.ok(result.capabilities);
    assert.strictEqual(result.capabilities?.contract, 'atlassian-cloud');
    assert.strictEqual(
      result.capabilities?.accessibleResources,
      'mcp_com_atlassian_getAccessibleAtlassianResources'
    );
    assert.strictEqual(result.capabilities?.getProjects, 'mcp_com_atlassian_getVisibleJiraProjects');
    assert.strictEqual(
      result.capabilities?.searchIssues,
      'mcp_com_atlassian_searchJiraIssuesUsingJql'
    );
    assert.strictEqual(result.capabilities?.transitionIssue, undefined);
    assert.deepStrictEqual(result.missing, []);
  });
});