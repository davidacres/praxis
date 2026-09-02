import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverAgents } from './discovery';
import { discoverSkills } from './skillRegistry';

async function agentDir(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent.json'), JSON.stringify(manifest));
}

async function skillDir(root: string, name: string, body: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
}

test('discoverAgents tags user-root agents global and project-root agents project', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-agents-'));
  const userRoot = path.join(base, 'user');
  const projectRoot = path.join(base, 'project');
  await agentDir(userRoot, 'alpha', { schemaVersion: 1, id: 'alpha', name: 'Alpha', type: 'acp', entry: 'run.js' });
  await agentDir(projectRoot, 'beta', { schemaVersion: 1, id: 'beta', name: 'Beta', type: 'acp', entry: 'run.js' });

  const agents = await discoverAgents({ userAgentsPath: userRoot, projectAgentsPath: projectRoot, allowProjectAgents: true });

  const alpha = agents.find(agent => agent.manifest.id === 'alpha');
  const beta = agents.find(agent => agent.manifest.id === 'beta');
  assert.equal(alpha?.scope, 'global');
  assert.equal(alpha?.trusted, true);
  assert.equal(beta?.scope, 'project');
  assert.equal(beta?.trusted, false, 'project agents are never auto-trusted');
});

test('discoverAgents keeps a global invalid manifest visible but untrusted', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-agents-'));
  const userRoot = path.join(base, 'user');
  await agentDir(userRoot, 'broken', { schemaVersion: 1, id: 'broken', name: 'Broken', type: 'nope', entry: 'run.js' });

  const [agent] = await discoverAgents({ userAgentsPath: userRoot });
  assert.equal(agent.scope, 'global');
  assert.equal(agent.trusted, false);
  assert.ok(agent.errors.length > 0);
});

test('the first root wins when an id appears in both scopes', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-agents-'));
  const userRoot = path.join(base, 'user');
  const projectRoot = path.join(base, 'project');
  await agentDir(userRoot, 'dup', { schemaVersion: 1, id: 'dup', name: 'User Dup', type: 'acp', entry: 'run.js' });
  await agentDir(projectRoot, 'dup2', { schemaVersion: 1, id: 'dup', name: 'Project Dup', type: 'acp', entry: 'run.js' });

  const agents = await discoverAgents({ userAgentsPath: userRoot, projectAgentsPath: projectRoot, allowProjectAgents: true });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].scope, 'global');
  assert.equal(agents[0].manifest.name, 'User Dup');
});

test('discoverSkills tags scope from the discovery root', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-skills-'));
  const userRoot = path.join(base, 'user');
  const projectRoot = path.join(base, 'project');
  await skillDir(userRoot, 'audit', '---\nname: audit\ndescription: audits things\n---\nbody');
  await skillDir(projectRoot, 'local', '---\nname: local\ndescription: local skill\n---\nbody');

  const skills = await discoverSkills([userRoot, projectRoot], [userRoot]);
  const audit = skills.find(skill => skill.metadata.name === 'audit');
  const local = skills.find(skill => skill.metadata.name === 'local');
  assert.equal(audit?.scope, 'global');
  assert.equal(audit?.trusted, true);
  assert.equal(local?.scope, 'project');
  assert.equal(local?.trusted, false);
});
