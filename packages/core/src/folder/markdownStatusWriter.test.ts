import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateFeatureStoryTable } from './markdownStatusWriter';

async function withFeatureFile(content: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'praxis-status-writer-'));
  try {
    const file = path.join(dir, 'feature.md');
    await writeFile(file, content, 'utf8');
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('updateFeatureStoryTable matches a story name containing regex characters literally', async () => {
  const table = ['| Story | Name | Status |', '| --- | --- | --- |', '| 01.2 | Fix (legacy) parser+ | 📋 Proposed |', ''].join('\n');
  await withFeatureFile(table, async file => {
    assert.equal(await updateFeatureStoryTable(file, 2, 'Fix (legacy) parser+', 'Done'), true);
    assert.match(await readFile(file, 'utf8'), /\| 01\.2 \| Fix \(legacy\) parser\+ \| ✅ Complete \|/);
  });
});

test('updateFeatureStoryTable leaves a row alone when the name only matches as a pattern', async () => {
  // Unescaped, "a.c" would match "abc" and rewrite the wrong story's row.
  const table = ['| Story | Name | Status |', '| --- | --- | --- |', '| 01.2 | abc | 📋 Proposed |', ''].join('\n');
  await withFeatureFile(table, async file => {
    assert.equal(await updateFeatureStoryTable(file, 2, 'a.c', 'Done'), false);
    assert.match(await readFile(file, 'utf8'), /📋 Proposed/);
  });
});
