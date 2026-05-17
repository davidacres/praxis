import * as assert from 'assert';
import { resolveBackendModeContextState } from '../ui/backendModeContext';

suite('backend mode context', () => {
  test('treats configured Jira Cloud connections as configured without a stored workspace mode', () => {
    assert.deepStrictEqual(resolveBackendModeContextState(undefined, false, true), {
      mode: 'jiraapi',
      configured: true
    });
  });

  test('keeps Jira Cloud unconfigured when no connection details exist', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('jiraapi', false, false), {
      mode: 'jiraapi',
      configured: false
    });
  });

  test('treats configured Jira API mode as configured', () => {
    assert.deepStrictEqual(resolveBackendModeContextState('jiraapi', false, true), {
      mode: 'jiraapi',
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