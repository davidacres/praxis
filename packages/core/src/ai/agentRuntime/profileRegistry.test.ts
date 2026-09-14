import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentProfile } from './profileRegistry';

test('parses canonical AGENT.md front matter independently of runtime hosts', () => {
  const result = parseAgentProfile(`---
id: reviewer
name: Reviewer
description: Reviews changes
skills: code-review, security
version: 1.0.0
---

Review the supplied change.`, 'fallback');
  assert.equal(result.error, undefined);
  assert.equal(result.profile.id, 'reviewer');
  assert.deepEqual(result.profile.preferredSkills, ['code-review', 'security']);
  assert.equal(result.profile.instructions, 'Review the supplied change.');
});

test('accepts a legacy brief as a profile using the folder id', () => {
  const result = parseAgentProfile('Implement the requested change.', 'implementer');
  assert.equal(result.error, undefined);
  assert.equal(result.profile.id, 'implementer');
  assert.equal(result.profile.name, 'implementer');
});
