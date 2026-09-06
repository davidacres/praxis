import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { ProjectManager } from './projectManager';
import type { ProjectRecord } from '@praxis/core';

/**
 * `PROJECT.md` generation (FX-BE-047).
 *
 * The rule these tests exist to hold: **Praxis rewrites only a file it wrote.**
 * The original implementation "adopted" a marker-less file by rewriting the
 * sections it recognised, and the first full e2e run after that change
 * overwrote this repository's own PROJECT.md with a fixture project's
 * two-stage workflow and an empty purpose. The `wx` flag it replaced was crude,
 * but "never touch an existing file" was a real safety property.
 */

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'Praxis',
    key: 'PRAXIS',
    type: 'software',
    purpose: 'Ship a planning tool.',
    brief: {},
    createdAt: '2026-08-31T22:27:04.012Z',
    updatedAt: '2026-08-31T22:27:04.012Z',
    workflowStages: [
      { id: '1', name: 'Backlog', category: 'todo' },
      { id: '2', name: 'In Progress', category: 'indeterminate' },
      { id: '3', name: 'Done', category: 'done' }
    ],
    workItems: [],
    linkedBoards: [],
    storage: 'folder',
    defaultAiToolMode: 'full',
    ...overrides
  } as ProjectRecord;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-snapshot-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const manager = () => new ProjectManager({} as never);
const read = (dir: string) => fs.readFile(path.join(dir, 'PROJECT.md'), 'utf8');

test('a new PROJECT.md is generated inside markers, from the effective workflow', async () => {
  await withTempDir(async dir => {
    await manager().refreshProjectFile(project({ workspaceFolder: dir }));
    const body = await read(dir);
    assert.match(body, /praxis:begin/);
    assert.match(body, /praxis:end/);
    assert.match(body, /## Workflow\n\n- Backlog\n- In Progress\n- Done/);
    assert.match(body, /Ship a planning tool\./);
  });
});

test('regenerating replaces only the marked block; prose outside it survives', async () => {
  await withTempDir(async dir => {
    await manager().refreshProjectFile(project({ workspaceFolder: dir }));
    await fs.appendFile(path.join(dir, 'PROJECT.md'), '\n## Team notes\n\nKeep this.\n');

    await manager().refreshProjectFile(
      project({
        workspaceFolder: dir,
        purpose: 'Changed.',
        workflowStages: [
          { id: '1', name: 'Icebox', category: 'todo' },
          { id: '2', name: 'Shipped', category: 'done' }
        ]
      })
    );

    const body = await read(dir);
    assert.match(body, /Keep this\./, 'user prose outside the block must survive');
    assert.match(body, /- Icebox\n- Shipped/, 'the generated block must be refreshed');
    assert.doesNotMatch(body, /- In Progress/, 'the old workflow must be gone');
    assert.match(body, /Changed\./);
  });
});

test('a PROJECT.md Praxis did not write is never modified', async () => {
  await withTempDir(async dir => {
    // Exactly the shape of this repository's own file: no markers, a real
    // purpose, and a workflow that is not the project record's.
    const handWritten = [
      '# praxis',
      '',
      '- Key: PRAXIS',
      '',
      '## Purpose',
      '',
      'A desktop workspace that keeps planning, tickets and agents in one place.',
      '',
      '## Workflow',
      '',
      '- Backlog',
      '- To Do',
      '- In Progress',
      '- Blocked',
      '- Done',
      ''
    ].join('\n');
    await fs.writeFile(path.join(dir, 'PROJECT.md'), handWritten, 'utf8');

    const status = await manager().refreshProjectFile(
      project({ workspaceFolder: dir, purpose: 'Someone else’s purpose.' })
    );

    assert.equal(await read(dir), handWritten, 'a marker-less file must be byte-identical afterwards');
    assert.equal(status, undefined, 'refreshProjectFile resolves without reporting a write');
  });
});

test('a project with no folder is a no-op rather than an error', async () => {
  await assert.doesNotReject(() => manager().refreshProjectFile(project({ workspaceFolder: undefined })));
});
