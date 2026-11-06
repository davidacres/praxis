import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateFeatureStoryTable, writeStatusToMarkdownFile } from './markdownStatusWriter';
import { extractStatusRaw } from './markdownPlanParser';

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

test('writeStatusToMarkdownFile moves a front-matter status as well as the **Status:** line', async () => {
  // The shape the template upgrade leaves: **Status:** injected inside an existing YAML block.
  // The parser reads `status:` first, so writing only the bold line read back as "To Do" forever.
  const doc = ['---', '**Status:** 🔄 In Progress', '**Type:** Story', 'id: FX-BE-184', 'status: To Do', 'priority: High', '---', '', '# FX-BE-184: Release proof', '', 'status: prose that is not front matter', ''].join('\n');
  await withFeatureFile(doc, async file => {
    assert.equal(await writeStatusToMarkdownFile(file, 'Done'), true);
    const written = await readFile(file, 'utf8');
    assert.match(written, /^\*\*Status:\*\* ✅ Complete$/m);
    assert.match(written, /^status: Done$/m);
    assert.match(written, /^status: prose that is not front matter$/m);
    assert.equal(extractStatusRaw(written), 'Done');
  });
});

test('writeStatusToMarkdownFile keeps a quoted front-matter status quoted', async () => {
  await withFeatureFile(['---', 'status: "To Do"', '---', '**Status:** 📋 To Do', ''].join('\n'), async file => {
    assert.equal(await writeStatusToMarkdownFile(file, 'In Progress'), true);
    assert.match(await readFile(file, 'utf8'), /^status: "In Progress"$/m);
  });
});

test('writeStatusToMarkdownFile adds no front-matter status to a file without one', async () => {
  await withFeatureFile(['---', 'id: X', '---', '**Status:** 📋 To Do', ''].join('\n'), async file => {
    assert.equal(await writeStatusToMarkdownFile(file, 'Done'), true);
    assert.doesNotMatch(await readFile(file, 'utf8'), /^status:/m);
  });
});
