import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getBundledAgentManifests,
  mirrorBundledAgents,
  BUNDLED_AGENT_DEFINITIONS
} from './bundledAgents';
import { discoverAgents } from './discovery';

test('TASK-247: getBundledAgentManifests returns trusted global agents', () => {
  const bundled = getBundledAgentManifests();
  assert.strictEqual(bundled.length, 5);

  const ids = bundled.map(a => a.manifest.id).sort();
  assert.deepStrictEqual(ids, [
    'praxis-addon-builder',
    'praxis-implementer',
    'praxis-planner',
    'praxis-reviewer',
    'praxis-security-analyst'
  ]);

  for (const agent of bundled) {
    assert.strictEqual(agent.scope, 'global');
    assert.strictEqual(agent.trusted, true);
    assert.strictEqual(agent.errors.length, 0);
  }
});

test('TASK-247: discoverAgents on clean directory discovers bundled agents with trust', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-bundled-test-'));
  try {
    const discovered = await discoverAgents({
      userAgentsPath: tmp,
      includeBundled: true
    });

    assert.ok(discovered.length >= 4);
    const planner = discovered.find(d => d.manifest.id === 'praxis-planner');
    assert.ok(planner);
    assert.strictEqual(planner.trusted, true);
    assert.strictEqual(planner.scope, 'global');

    const reviewer = discovered.find(d => d.manifest.id === 'praxis-reviewer');
    assert.ok(reviewer);
    assert.strictEqual(reviewer.trusted, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('TASK-247: user-supplied agent overrides bundled agent with matching id', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-user-agent-test-'));
  try {
    const customReviewerDir = path.join(tmp, 'praxis-reviewer');
    await fs.mkdir(customReviewerDir, { recursive: true });
    await fs.writeFile(
      path.join(customReviewerDir, 'agent.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'praxis-reviewer',
        name: 'Custom User Reviewer',
        type: 'acp',
        entry: 'custom-entry'
      }),
      'utf8'
    );

    const discovered = await discoverAgents({
      userAgentsPath: tmp,
      includeBundled: true
    });

    const reviewer = discovered.find(d => d.manifest.id === 'praxis-reviewer');
    assert.ok(reviewer);
    assert.strictEqual(reviewer.manifest.name, 'Custom User Reviewer');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('TASK-247: mirrorBundledAgents writes manifests and is idempotent', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mirror-test-'));
  try {
    const expectedCount = Object.keys(BUNDLED_AGENT_DEFINITIONS).length;
    const firstRun = await mirrorBundledAgents(tmp);
    assert.strictEqual(firstRun.length, expectedCount);

    for (const id of Object.keys(BUNDLED_AGENT_DEFINITIONS)) {
      const manifestPath = path.join(tmp, id, 'agent.json');
      const stat = await fs.stat(manifestPath);
      assert.ok(stat.isFile());

      const content = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      assert.strictEqual(content.id, id);
    }

    // Second run is idempotent
    const secondRun = await mirrorBundledAgents(tmp);
    assert.strictEqual(secondRun.length, expectedCount);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
