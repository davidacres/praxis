import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getBundledAgentManifests,
  mirrorBundledAgents,
  mirrorBundledSkills,
  AVAILABLE_SKILL_DEFINITIONS,
  BUNDLED_SKILL_NAMES,
  BUNDLED_AGENT_DEFINITIONS
} from './bundledAgents';
import { discoverAgents } from './discovery';
import { discoverSkills } from './skillRegistry';
import { discoverAgentProfiles } from './profileRegistry';
import { parseReviewFindings } from '../aiReviewService';

test('TASK-247: getBundledAgentManifests returns trusted global agents', () => {
  const bundled = getBundledAgentManifests();
  assert.strictEqual(bundled.length, 9);

  const ids = bundled.map(a => a.manifest.id).sort();
  assert.deepStrictEqual(ids, [
    'praxis-addon-builder',
    'praxis-human-reviewer',
    'praxis-implementer',
    'praxis-planner',
    'praxis-reviewer',
    'praxis-scheduler',
    'praxis-security-analyst',
    'praxis-skeptic',
    'praxis-test-author'
  ]);

  for (const agent of bundled) {
    assert.strictEqual(agent.scope, 'global');
    assert.strictEqual(agent.trusted, true);
    assert.strictEqual(agent.errors.length, 0);
  }
});

test('praxis planner defines the canonical Praxis plan-file specification', () => {
  const brief = BUNDLED_AGENT_DEFINITIONS['praxis-planner'].brief;

  assert.match(brief, /You define and enforce the Praxis plan-file standard\./);
  assert.match(brief, /Existing plans provide delivery context only/);
  assert.match(brief, /features\/<feature-id>\/feature\.md/);
  assert.match(brief, /stories\/<story-id>\/story\.md/);
  assert.match(brief, /tasks\/<task-id>\.md/);
  assert.match(brief, /Declare its `id`, `type`/);
  assert.match(brief, /IDs must be unique\s+across the entire plans tree/);
  assert.match(brief, /Use the board's declared workflow stage names for statuses/);
  assert.match(brief, /`## Dependencies` section/);
  assert.match(brief, /parseable by a Praxis board/);
  assert.doesNotMatch(brief, /Follow repository planning conventions/);
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
      const profilePath = path.join(tmp, id, 'AGENT.md');
      const stat = await fs.stat(manifestPath);
      const profileStat = await fs.stat(profilePath);
      assert.ok(stat.isFile());
      assert.ok(profileStat.isFile());

      const content = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const profile = await fs.readFile(profilePath, 'utf8');
      assert.strictEqual(content.id, id);
      assert.match(profile, new RegExp(`^---\\n(?:.|\\n)*id: ${id}`, 'm'));
      assert.ok(profile.includes(BUNDLED_AGENT_DEFINITIONS[id].brief.trim()));
    }

    // Second run is idempotent
    const secondRun = await mirrorBundledAgents(tmp);
    assert.strictEqual(secondRun.length, expectedCount);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('FX-BE-164: the skeptic\'s verdicts parse onto the findings they judge, keeping their fingerprints', () => {
  const review = parseReviewFindings('```json\n{"findings":[{"file":"src/a.ts","line":3,"message":"Null deref","severity":"high","category":"bug"}]}\n```');
  const skeptic = parseReviewFindings('Checked.\n```json\n{"findings":[{"file":"src/a.ts","line":3,"message":"Null deref","severity":"high","category":"bug","verdict":"refuted","verdictReason":"Guarded on line 2."}]}\n```');
  assert.equal(skeptic.findings.findings[0].fingerprint, review.findings.findings[0].fingerprint);
  assert.equal(skeptic.findings.findings[0].verdict, 'refuted');
  assert.equal(skeptic.findings.findings[0].verdictReason, 'Guarded on line 2.');
  assert.equal(review.findings.findings[0].verdict, undefined);
  assert.match(BUNDLED_AGENT_DEFINITIONS['praxis-skeptic'].brief, /Copy file, line, ruleId and message exactly/);
});

test('the scheduled-run skill is installed for everyone, updated by version, and keeps same-version edits', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-skill-mirror-'));
  try {
    assert.ok(BUNDLED_SKILL_NAMES.includes('praxis-scheduled-runs'));
    assert.deepStrictEqual(await mirrorBundledSkills(tmp), [...BUNDLED_SKILL_NAMES]);
    const file = path.join(tmp, 'praxis-scheduled-runs', 'SKILL.md');
    const written = await fs.readFile(file, 'utf8');
    assert.strictEqual(written, AVAILABLE_SKILL_DEFINITIONS['praxis-scheduled-runs'].instructions);
    assert.match(written, /praxis\.scheduledRunRequest/);
    assert.ok(!written.includes('\\`'), 'template escapes must not leak into the skill text');
    const [discovered] = await discoverSkills([tmp]);
    assert.strictEqual(discovered.metadata.name, 'praxis-scheduled-runs');
    assert.strictEqual(discovered.metadata.title, 'Scheduled Run Authoring');

    const edited = written.replace('# Scheduled Run Authoring', '# Scheduled Run Authoring (edited)');
    await fs.writeFile(file, edited);
    await mirrorBundledSkills(tmp);
    assert.strictEqual(await fs.readFile(file, 'utf8'), edited);

    await fs.writeFile(file, edited.replace('version: 1.0.0', 'version: 0.9.0'));
    await mirrorBundledSkills(tmp);
    assert.strictEqual(await fs.readFile(file, 'utf8'), written);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('the Praxis Scheduler agent uses the scheduled-run skill, in its mirrored profile and its built-in one', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-scheduler-agent-'));
  try {
    await mirrorBundledAgents(tmp);
    const [mirrored] = (await discoverAgentProfiles([tmp])).filter(entry => entry.profile.id === 'praxis-scheduler');
    assert.ok(mirrored, 'the scheduler profile is mirrored');
    assert.strictEqual(mirrored.profile.name, 'Praxis Scheduler');
    assert.deepStrictEqual(mirrored.profile.preferredSkills, ['praxis-scheduled-runs']);
    assert.ok(AVAILABLE_SKILL_DEFINITIONS['praxis-scheduled-runs'], 'its skill ships with Praxis');

    const builtIn = (await discoverAgentProfiles([], [], true)).find(entry => entry.profile.id === 'praxis-scheduler');
    assert.deepStrictEqual(builtIn?.profile.preferredSkills, ['praxis-scheduled-runs']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
