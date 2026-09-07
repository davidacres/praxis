import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { discoverPlanFolders, discoverRepositoryFolders, parsePlanFolder, resolvePlanDependencyKeys } from './markdownPlanParser';

/** Minimal plans root: one feature folder with a typed markdown file. */
async function writeFeature(plansRoot: string, title: string): Promise<void> {
  const featureDir = path.join(plansRoot, 'features', 'feature-01-demo');
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(
    path.join(featureDir, 'feature.md'),
    `# ${title}

**Type:** Feature
**Status:** Backlog
`,
    'utf8'
  );
}

test('recursively discovers nested planning documents from front matter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-plan-parser-'));
  const feature = path.join(root, 'features', 'arbitrary-feature-folder');
  const story = path.join(feature, 'stories', 'arbitrary-story-folder');
  const tasks = path.join(story, 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(path.join(feature, 'feature.md'), [
    '---', 'id: FX-BF-042', 'type: Feature', 'status: proposed', '---', '',
    '# Agent feature', '', '## Description', '', 'Feature body.'
  ].join('\n'));
  await writeFile(path.join(story, 'story.md'), [
    '---', 'id: FX-BE-101', 'type: Story', 'feature: FX-BF-042', 'status: in-progress', '---', '',
    '# Nested story', '', '## Description', '', 'Story body.'
  ].join('\n'));
  await writeFile(path.join(tasks, 'implementation.md'), [
    '---', 'id: TASK-202', 'type: Task', 'status: complete', '---', '',
    '# Nested task', '', '## Description', '', 'Task body.'
  ].join('\n'));
  try {
    const parsed = await parsePlanFolder(root);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].featureId).toBe(42);
    expect(parsed.stories).toHaveLength(1);
    expect(parsed.stories[0].title).toBe('Nested story');
    expect(parsed.childItems).toHaveLength(2);
    expect(parsed.childItems.map(item => item.issueType)).toEqual(['Story', 'Task']);
    expect(parsed.childItems.every(item => item.featureId === 42)).toBe(true);
    expect(parsed.childItems.map(item => item.planStatus)).toEqual(['In Progress', 'Done']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function expect(value: unknown) {
  return {
    toBe(expected: unknown) { if (value !== expected) throw new Error(`Expected ${String(value)} to be ${String(expected)}`); },
    toHaveLength(expected: number) { if (!value || (value as { length?: number }).length !== expected) throw new Error(`Expected length ${expected}`); },
    toEqual(expected: unknown) { if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(value)} to equal ${JSON.stringify(expected)}`); }
  };
}

test('discovery stops at nested git checkouts so a worktree cannot duplicate its repo plans', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-worktree-'));
  try {
    // A repository with plans, holding a worktree of itself that has the same
    // plans on another branch, plus a genuinely separate nested clone.
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFeature(path.join(dir, 'docs', 'plans'), 'Main plan');

    const worktree = path.join(dir, '.worktrees', 'branch-x');
    await fs.mkdir(worktree, { recursive: true });
    // A worktree's `.git` is a FILE pointing at the parent repo.
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(dir, '.git', 'worktrees', 'branch-x')}\n`, 'utf8');
    await writeFeature(path.join(worktree, 'docs', 'plans'), 'Main plan');

    const nestedClone = path.join(dir, 'vendor', 'other-repo');
    await fs.mkdir(path.join(nestedClone, '.git'), { recursive: true });
    await writeFeature(path.join(nestedClone, 'docs', 'plans'), 'Vendor plan');

    const roots = (await discoverPlanFolders(dir)).map(match => match.plansRootPath);
    assert.equal(roots.length, 1, `expected only the repo's own plans, got: ${roots.join(', ')}`);
    assert.ok(roots[0].includes('docs'), roots[0]);
    assert.ok(!roots.some(root => root.includes('.worktrees')), 'a worktree must not contribute plans');
    assert.ok(!roots.some(root => root.includes('vendor')), 'a nested clone must not contribute plans');

    // Pointing straight at the worktree still works — that is how you get a
    // board for one branch's state.
    const fromWorktree = (await discoverPlanFolders(worktree)).map(match => match.plansRootPath);
    assert.equal(fromWorktree.length, 1, fromWorktree.join(', '));

    // The import wizard offers the clone, never the worktree.
    const repos = await discoverRepositoryFolders(dir);
    assert.ok(repos.some(repo => repo.includes('vendor')), `nested clone missing: ${repos.join(', ')}`);
    assert.ok(!repos.some(repo => repo.includes('.worktrees')), `worktree offered: ${repos.join(', ')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('canonical planning dependencies resolve to board keys without partial FX identifiers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-plan-dependencies-'));
  const feature = path.join(root, 'features', 'delivery');
  const story = path.join(feature, 'stories', 'diagnose');
  const tasks = path.join(story, 'tasks');
  await mkdir(tasks, { recursive: true });
  try {
    await writeFile(path.join(feature, 'feature.md'), '---\nid: FX-BF-042\ntype: Feature\n---\n# Delivery\n');
    await writeFile(path.join(story, 'story.md'), '---\nid: FX-BE-101\ntype: Story\n---\n# Diagnose\n\n## Dependencies\n- FX-BF-042\n');
    await writeFile(path.join(tasks, 'first.md'), '---\nid: TASK-202\ntype: Task\n---\n# Evidence\n\n## Dependencies\n- FX-BE-101\n');
    await writeFile(path.join(tasks, 'second.md'), '---\nid: TASK-203\ntype: Task\n---\n# Repair\n\n## Dependencies\n- TASK-202\n- KAMAI-4\n- TASK-203\n');
    const parsed = await parsePlanFolder(root);
    assert.deepEqual(parsed.childItems.find(item => item.sequence === 101)?.depTokens, ['FX-BF-042']);
    assert.deepEqual(parsed.childItems.find(item => item.sequence === 202)?.depTokens, ['FX-BE-101']);
    const resolved = resolvePlanDependencyKeys(parsed, 'PRAXIS');
    assert.deepEqual(resolved.get('PRAXIS-S42-101'), ['PRAXIS-F42']);
    assert.deepEqual(resolved.get('PRAXIS-T42-202'), ['PRAXIS-S42-101']);
    assert.deepEqual(resolved.get('PRAXIS-T42-203'), ['PRAXIS-T42-202', 'KAMAI-4']);
    // Changing the board key changes local references, not external tracker keys.
    assert.deepEqual(resolvePlanDependencyKeys(parsed, 'OTHER').get('OTHER-T42-203'), ['OTHER-T42-202', 'KAMAI-4']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy filename dependencies and external issue keys remain supported', () => {
  const feature = { featureId: 1, dirName: 'feature-01-demo', depTokens: [] };
  const story = { featureId: 1, sequence: 2, issueType: 'Story', filename: 'story-01-02-work.md', depTokens: ['feature-01-demo', 'KAMAI-4'] };
  const task = { featureId: 1, sequence: 3, issueType: 'Task', filename: 'task-01-03-check.md', depTokens: ['story-01-02-work'] };
  const parsed = { features: [feature], childItems: [story, task] } as unknown as Parameters<typeof resolvePlanDependencyKeys>[0];
  const resolved = resolvePlanDependencyKeys(parsed, 'PRAXIS');
  assert.deepEqual(resolved.get('PRAXIS-S01-2'), ['PRAXIS-F01', 'KAMAI-4']);
  assert.deepEqual(resolved.get('PRAXIS-T01-3'), ['PRAXIS-S01-2']);
});
