import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredAgent, DiscoveredAgentProfile } from '../ai/agentRuntime';
import { preflightStage } from './workflowPreflight';
import type { WorkflowAgentTaskNode } from './workflowTypes';

const host: DiscoveredAgent = {
  manifest: { schemaVersion: 1, id: 'claude-acp', name: 'Claude ACP', type: 'acp', entry: 'claude' },
  manifestPath: '/hosts/claude-acp/agent.json',
  rootPath: '/hosts/claude-acp',
  scope: 'global',
  trusted: true,
  errors: []
};

const profile: DiscoveredAgentProfile = {
  profile: { id: 'reviewer', name: 'Reviewer', instructions: 'Review independently.' },
  profilePath: '/profiles/reviewer/AGENT.md',
  rootPath: '/profiles/reviewer',
  fingerprint: 'profile-sha',
  scope: 'global',
  trusted: true,
  legacy: false
};

function node(): WorkflowAgentTaskNode {
  return {
    type: 'agent-task',
    id: 'review',
    name: 'Review',
    x: 0,
    y: 0,
    inputs: [],
    agent: {
      agentId: 'claude-acp',
      profileId: 'reviewer',
      hostId: 'claude-acp',
      providerId: 'anthropic',
      scope: 'global',
      toolMode: 'read-only'
    },
    instructions: 'Review.',
    outputs: [],
    mutatesWorktree: false
  };
}

test('preflight binds profile provider and runtime host independently', () => {
  const result = preflightStage(node(), {
    agents: [host],
    runtimeHosts: [host],
    profiles: [profile],
    skills: [],
    capabilities: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.binding?.profileId, 'reviewer');
  assert.equal(result.binding?.hostId, 'claude-acp');
  assert.equal(result.binding?.providerId, 'anthropic');
  assert.equal(result.binding?.profileInstructions, 'Review independently.');
});

test('preflight fails closed when an explicit profile is missing', () => {
  const result = preflightStage(node(), {
    agents: [host],
    runtimeHosts: [host],
    profiles: [],
    skills: [],
    capabilities: {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.kind, 'profile-not-found');
});
