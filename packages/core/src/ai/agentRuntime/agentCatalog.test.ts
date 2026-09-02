import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentStartBlockedReason,
  describeCapabilities,
  eligibleAgentsForSkill,
  groupCatalog,
  skillActivateBlockedReason,
  agentHostStarted
} from './agentCatalog';
import type { DiscoveredAgent } from './manifest';
import type { DiscoveredSkill } from './skillRegistry';

function agent(id: string, overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    manifest: { schemaVersion: 1, id, name: id, type: 'acp', entry: 'run.js' },
    manifestPath: `/agents/${id}/agent.json`,
    rootPath: `/agents/${id}`,
    scope: 'global',
    trusted: true,
    errors: [],
    ...overrides
  };
}

function skill(name: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    metadata: { name, description: `${name} skill`, triggers: [] },
    skillPath: `/skills/${name}`,
    instructionsPath: `/skills/${name}/SKILL.md`,
    fingerprint: 'abc',
    scope: 'global',
    trusted: true,
    ...overrides
  };
}

test('groupCatalog splits by scope and drops empty groups', () => {
  const groups = groupCatalog({
    agents: [agent('a'), agent('b', { scope: 'project', trusted: false })],
    skills: [skill('s')]
  });
  assert.deepEqual(groups.map(group => group.scope), ['global', 'project']);
  assert.deepEqual(groups[0].agents.map(a => a.manifest.id), ['a']);
  assert.deepEqual(groups[0].skills.map(s => s.metadata.name), ['s']);
  assert.deepEqual(groups[1].agents.map(a => a.manifest.id), ['b']);

  const onlyGlobal = groupCatalog({ agents: [agent('a')], skills: [] });
  assert.equal(onlyGlobal.length, 1);
});

test('agentStartBlockedReason fails closed for invalid or untrusted agents', () => {
  assert.equal(agentStartBlockedReason(agent('ok')), undefined);
  assert.match(
    agentStartBlockedReason(agent('bad', { errors: [{ path: 'type', message: 'nope' }] }))!,
    /Manifest is invalid/
  );
  assert.match(
    agentStartBlockedReason(agent('proj', { scope: 'project', trusted: false }))!,
    /approval-required/i
  );
});

test('skillActivateBlockedReason requires a usable agent and a valid trusted skill', () => {
  assert.equal(skillActivateBlockedReason(skill('s'), [agent('a')]), undefined);
  assert.match(skillActivateBlockedReason(skill('s', { error: 'broken' }), [agent('a')])!, /invalid/i);
  assert.match(skillActivateBlockedReason(skill('s', { trusted: false }), [agent('a')])!, /Approval-required/i);
  assert.match(
    skillActivateBlockedReason(skill('s'), [agent('a', { errors: [{ path: 'x', message: 'y' }] })])!,
    /No trusted, valid agent/
  );
});

test('eligibleAgentsForSkill returns only startable agents', () => {
  const agents = [agent('good'), agent('bad', { trusted: false }), agent('broken', { errors: [{ path: 'x', message: 'y' }] })];
  assert.deepEqual(eligibleAgentsForSkill(skill('s'), agents).map(a => a.manifest.id), ['good']);
  assert.deepEqual(eligibleAgentsForSkill(skill('s', { error: 'x' }), agents), []);
});

test('describeCapabilities is undefined until a host reports, then lists enabled features', () => {
  assert.equal(describeCapabilities(undefined), undefined);
  assert.deepEqual(
    describeCapabilities({
      supportsSkills: true,
      supportsTools: false,
      supportsMemory: true,
      supportsResume: false,
      supportsStreaming: false,
      model: 'claude-sonnet-5'
    }),
    { features: ['skills', 'memory'], model: 'claude-sonnet-5' }
  );
});

test('agentHostStarted reflects whether capabilities were reported', () => {
  assert.equal(agentHostStarted({ capabilities: {} }, 'a'), false);
  assert.equal(
    agentHostStarted(
      { capabilities: { a: { supportsSkills: false, supportsTools: false, supportsMemory: false, supportsResume: false, supportsStreaming: false } } },
      'a'
    ),
    true
  );
});
