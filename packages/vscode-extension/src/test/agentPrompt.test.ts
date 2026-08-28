import * as assert from 'assert';
import { buildSystemPrompt, buildWorktreeName } from '@ticket-manager/core';
import type { AgentTaskDefinition } from '@ticket-manager/core';

suite('agentPrompt', () => {
  test('buildWorktreeName prefixes the issue key and normalizes the suffix', () => {
    const worktreeName = buildWorktreeName({
      key: 'ABC-123',
      summary: 'Fix Login Flow!!!',
      branch: undefined
    });
    assert.strictEqual(worktreeName, 'ABC-123-fix-login-flow');
  });

  test('buildSystemPrompt includes ticket-based worktree and MSI naming rules', () => {
    const taskDefinition: AgentTaskDefinition = {
      goal: 'Implement feature',
      scope: 'src/',
      definitionOfDone: 'Tests pass'
    };
    const prompt = buildSystemPrompt(taskDefinition, {
      key: 'ABC-9',
      projectKey: 'ABC',
      summary: 'Add endpoint',
      issueType: 'Story',
      status: 'To Do',
      description: 'Details'
    });
    assert.ok(prompt.includes('ABC-9'));
    assert.ok(prompt.includes('worktree'));
    assert.ok(prompt.includes('MSI'));
    assert.ok(prompt.includes('autonomous coding agent'));
  });
});
