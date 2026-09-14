import test from 'node:test';
import assert from 'node:assert/strict';
import { planNewAgentProfile, validateAgentProfileImport } from './agentAuthoring';

test('plans a standalone canonical AGENT.md profile', () => {
  const plan = planNewAgentProfile({
    scope: 'global',
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews changes',
    preferredSkills: ['code-review'],
    instructions: 'Review independently.'
  }, []);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.folder, 'reviewer');
  assert.match(plan.files[0]?.content ?? '', /id: reviewer/);
  assert.match(plan.files[0]?.content ?? '', /Review independently/);
  assert.equal(plan.files.some(file => file.path === 'agent.json'), false);
});

test('profile import validates AGENT.md independently of a host manifest', () => {
  const result = validateAgentProfileImport(`---
id: reviewer
name: Reviewer
---
Review independently.
`, []);
  assert.deepEqual(result.preview.errors, []);
  assert.equal(result.preview.kind, 'profile');
  assert.equal(result.preview.name, 'reviewer');
});
