import * as assert from 'assert';
import { resolveBackendModeContextState } from '@ticket-manager/core';

suite('backend mode context', () => {
  test('treats configured Jira MCP connections as configured without a stored workspace mode', () => {
    assert.deepStrictEqual(resolveBackendModeContextState(undefined, false, true), {
      mode: 'jiracloud',
      configured: true
    });
  });

  test('keeps Jira MCP unconfigured when no connection details exist', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('jiracloud', false, false), {
      mode: 'jiracloud',
      configured: false
    });
  });

  test('treats configured Jira MCP mode as configured', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('jiracloud', false, true), {
      mode: 'jiracloud',
      configured: true
    });
  });

  test('keeps explicit non-Jira modes configured', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('demo', false, false), {
      mode: 'demo',
      configured: true
    });
  });

  test('keeps explicit hosted modes visible but unconfigured', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('gitlab', false, false), {
      mode: 'gitlab',
      configured: false
    });
    assert.deepStrictEqual(resolveBackendModeContextState('github', false, false), {
      mode: 'github',
      configured: false
    });
  });
});
