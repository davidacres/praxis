import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parsePlanFolder } from './markdownPlanParser';

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
