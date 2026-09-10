import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  collectDependencyTokens,
  discoverPlanFolders,
  discoverRepositoryFolders,
  parsePlanFolder,
  resolvePlanDependencyKeys
} from './markdownPlanParser';

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

test('a stories/ folder under an unmatched feature parent is not promoted to its own board', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-phantom-board-'));
  try {
    // A real plans root, so the walk has something legitimate to find first.
    await writeFeature(path.join(dir, 'docs', 'plans'), 'Main plan');

    // A second tree, shaped like an issue-mirror export: every feature folder
    // carries `feature-issues.md` (not `feature.md`), so it never matches as a
    // feature root, and only one of its two stories happens to carry a
    // recognized `**Type:**` line — same as a real multi-AI mirror export.
    const feature = path.join(dir, 'docs', 'issues', 'features', 'fx-bf-999-example');
    const storyA = path.join(feature, 'stories', 'fx-be-001-untyped');
    const storyB = path.join(feature, 'stories', 'fx-be-002-typed');
    await mkdir(storyA, { recursive: true });
    await mkdir(storyB, { recursive: true });
    await writeFile(path.join(feature, 'feature-issues.md'), '# Example feature issues\n');
    await writeFile(path.join(storyA, 'issue.md'), '# FX-BE-001\n\n**Status:** Complete\n');
    await writeFile(path.join(storyB, 'issue.md'), '# FX-BE-002\n\n**Type:** Story\n**Status:** Complete\n');

    const roots = (await discoverPlanFolders(dir)).map(match => match.plansRootPath);
    assert.equal(roots.length, 1, `expected only the real plans root, got: ${roots.join(', ')}`);
    assert.ok(roots[0].endsWith(path.join('docs', 'plans')), roots[0]);
    assert.ok(
      !roots.some(root => root.includes('stories')),
      `a stories/ folder must not become its own board: ${roots.join(', ')}`
    );

    // Pointing a connection root directly at the stories folder is still the
    // supported way to track it standalone — only *discovering* it by walking
    // down from an enclosing folder is refused.
    const direct = (await discoverPlanFolders(path.join(feature, 'stories'))).map(match => match.plansRootPath);
    assert.equal(direct.length, 1, direct.join(', '));
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

test('a legacy basename shared by more than one record resolves to nothing, not to whichever record loaded last', () => {
  // The nested feature/story layout gives every story its own story.md, so
  // two unrelated stories both carry the filename-derived name "story".
  const storyA = { featureId: 1, sequence: 1, issueType: 'Story', filename: 'story.md', depTokens: [] };
  const storyB = { featureId: 2, sequence: 1, issueType: 'Story', filename: 'story.md', depTokens: [] };
  const task = { featureId: 1, sequence: 1, issueType: 'Task', filename: 'task-01-01-check.md', depTokens: ['story'] };
  const parsed = { features: [], childItems: [storyA, storyB, task] } as unknown as Parameters<typeof resolvePlanDependencyKeys>[0];
  const resolved = resolvePlanDependencyKeys(parsed, 'PRAXIS');
  assert.equal(resolved.get('PRAXIS-T01-1'), undefined);
});

test('a multi-segment local id is never truncated to its trailing segment, for any prefix', () => {
  const feature = { featureId: 42, dirName: 'demo', depTokens: [] };
  const story = { featureId: 42, sequence: 1, issueType: 'Story', filename: 'story.md', depTokens: ['FX-XY-042'] };
  const parsed = { features: [{ ...feature, planningId: 'FX-XY-042' }], childItems: [story] } as unknown as Parameters<typeof resolvePlanDependencyKeys>[0];
  const resolved = resolvePlanDependencyKeys(parsed, 'PRAXIS');
  assert.deepEqual(resolved.get('PRAXIS-S42-1'), ['PRAXIS-F42']);
});

test('a dependency declared only in the flow-style frontmatter array is still collected', () => {
  // Matches the actual shape of ~120 pre-existing plan docs: a `## Dependencies`
  // heading is present (from the template-upgrade pass) but left blank, and the
  // only real declaration is the frontmatter array.
  const content = [
    '---',
    'id: TASK-045',
    'dependencies: [TASK-044, FX-BF-003]',
    '---',
    '',
    '# TASK-045: Example',
    '',
    '## Dependencies',
    '',
    '',
    '## Comments'
  ].join('\n');
  assert.deepEqual(collectDependencyTokens(content), ['TASK-044', 'FX-BF-003']);
});

test('frontmatter-only dependencies resolve to real board keys end to end', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-plan-frontmatter-deps-'));
  const feature = path.join(root, 'features', 'fx-bf-003-demo');
  const story = path.join(feature, 'stories', 'fx-be-005-demo');
  await mkdir(story, { recursive: true });
  try {
    await writeFile(path.join(feature, 'feature.md'), '---\nid: FX-BF-003\n---\n# Demo feature\n');
    await writeFile(
      path.join(story, 'story.md'),
      '---\ntype: Story\nid: FX-BE-005\ndependencies: [FX-BF-003]\n---\n# Demo story\n\n## Dependencies\n\n\n## Comments\n'
    );
    const parsed = await parsePlanFolder(root);
    const storyItem = parsed.childItems.find(item => item.issueType === 'Story');
    assert.deepEqual(storyItem?.depTokens, ['FX-BF-003']);
    const resolved = resolvePlanDependencyKeys(parsed, 'PRAXIS');
    assert.deepEqual(resolved.get('PRAXIS-S03-5'), ['PRAXIS-F03']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
