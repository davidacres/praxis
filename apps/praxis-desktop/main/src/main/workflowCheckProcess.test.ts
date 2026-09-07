import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowCheckNode } from '@praxis/core';
import { spawnCheck } from './workflowCheckProcess';

function check(script: string): WorkflowCheckNode {
  return { type: 'check', id: 'check', name: 'Check', x: 0, y: 0, inputs: [], outputs: [], command: process.execPath, args: ['-e', script] };
}

test('an already cancelled check never launches', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await spawnCheck(check('throw new Error("must not run")'), tmpdir(), controller.signal);
  assert.equal(result.error, 'Check cancelled.');
  assert.equal(result.output, '');
});

test('cancellation terminates an active check that ignores SIGTERM', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-check-'));
  const controller = new AbortController();
  const marker = join(dir, 'ready');
  const result = spawnCheck(check(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 100);`), dir, controller.signal);
  try {
    for (let i = 0; i < 100; i++) {
      if (await readFile(marker, 'utf8').catch(() => '') === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(marker, 'utf8'), 'ready');
    controller.abort();
    assert.equal((await result).error, 'Check cancelled.');
  } finally {
    controller.abort();
    await result;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a check timeout resolves only after the process has stopped', { timeout: 10_000 }, async () => {
  const node = check("process.on('SIGTERM', () => {}); setInterval(() => {}, 100);");
  node.timeoutMs = 200;
  const result = await spawnCheck(node, tmpdir());
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});
