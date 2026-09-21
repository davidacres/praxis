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

test('local workflow checks use unattended CI semantics with parallel desktop workers by default', async () => {
  const previous = process.env.CI;
  const previousWorkers = process.env.PRAXIS_E2E_WORKERS;
  delete process.env.CI;
  delete process.env.PRAXIS_E2E_WORKERS;
  try {
    const result = await spawnCheck(check("process.stdout.write(JSON.stringify({ ci: process.env.CI, workers: process.env.PRAXIS_E2E_WORKERS }))"), tmpdir());
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), { ci: '1', workers: '4' });
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
    if (previousWorkers === undefined) delete process.env.PRAXIS_E2E_WORKERS;
    else process.env.PRAXIS_E2E_WORKERS = previousWorkers;
  }
});

test('workflow checks preserve real CI serial defaults', async () => {
  const previous = process.env.CI;
  const previousWorkers = process.env.PRAXIS_E2E_WORKERS;
  process.env.CI = 'custom-ci';
  delete process.env.PRAXIS_E2E_WORKERS;
  try {
    const result = await spawnCheck(check("process.stdout.write(JSON.stringify({ ci: process.env.CI, workers: process.env.PRAXIS_E2E_WORKERS }))"), tmpdir());
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), { ci: 'custom-ci' });
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
    if (previousWorkers === undefined) delete process.env.PRAXIS_E2E_WORKERS;
    else process.env.PRAXIS_E2E_WORKERS = previousWorkers;
  }
});

test('workflow checks preserve an explicit worker choice', async () => {
  const previous = process.env.CI;
  const previousWorkers = process.env.PRAXIS_E2E_WORKERS;
  delete process.env.CI;
  process.env.PRAXIS_E2E_WORKERS = '2';
  try {
    const result = await spawnCheck(check("process.stdout.write(JSON.stringify({ ci: process.env.CI, workers: process.env.PRAXIS_E2E_WORKERS }))"), tmpdir());
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), { ci: '1', workers: '2' });
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
    if (previousWorkers === undefined) delete process.env.PRAXIS_E2E_WORKERS;
    else process.env.PRAXIS_E2E_WORKERS = previousWorkers;
  }
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
