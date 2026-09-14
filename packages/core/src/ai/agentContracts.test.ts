import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileContext, planSkillActivations, type AgentBinding, type AgentSkillRef } from './agentContracts';

const skill: AgentSkillRef = { id: 'review', instructions: 'Review carefully.', requiredTools: ['read'] };

test('uses native skill activation only when explicitly advertised', () => {
  assert.equal(planSkillActivations([skill], { supportsNativeSkills: true })[0].mode, 'native');
  assert.equal(planSkillActivations([skill], { supportsTools: true })[0].mode, 'tools');
  assert.equal(planSkillActivations([skill], {})[0].mode, 'context');
});

test('context fallback includes profile and non-native skill instructions', () => {
  const binding: AgentBinding = {
    profile: { id: 'reviewer', name: 'Reviewer', instructions: 'Act as reviewer.' },
    provider: { id: 'openai' },
    host: { id: 'gateway', name: 'Gateway', transport: 'gateway', entry: { url: 'https://example.test' } },
    skills: [skill],
    activations: [{ skillId: 'review', mode: 'context', reason: 'fallback', instructionsIncluded: true }]
  };
  const context = buildProfileContext(binding);
  assert.match(context, /Praxis agent profile: Reviewer/);
  assert.match(context, /Praxis skill: review \(context\)/);
  assert.match(context, /Review carefully/);
});
