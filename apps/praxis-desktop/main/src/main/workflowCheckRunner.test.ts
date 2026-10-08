import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageDispatchContext, WorkflowCheckNode, WorkflowRun } from '@praxis/core';
import { readEvidenceBundle } from '@praxis/core';
import { runWorkflowCheck } from './workflowCheckRunner';

function check(script: string, overrides: Partial<WorkflowCheckNode> = {}): WorkflowCheckNode {
  return {
    type: 'check',
    id: 'check-build',
    name: 'Build',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [{ id: 'build-log', kind: 'log', required: true }],
    command: process.execPath,
    args: ['-e', script],
    ...overrides
  };
}

/** A run with one attempt already recorded, matching orchestrator state at dispatch time. */
function runContext(node: WorkflowCheckNode, worktreePath: string, signal?: AbortSignal): StageDispatchContext {
  const run: WorkflowRun = {
    schemaVersion: 1,
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowVersion: 1,
    projectId: 'proj-1',
    status: 'running',
    definition: {
      schemaVersion: 1,
      id: 'wf-1',
      name: 'wf',
      scope: 'project',
      projectId: 'proj-1',
      version: 1,
      nodes: [node],
      edges: [],
      entryNodeId: node.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    nodes: {
      [node.id]: {
        nodeId: node.id,
        outcome: 'running',
        attempts: [{ attempt: 1, outcome: 'running', startedAt: '2026-01-01T00:00:00.000Z' }],
        artifacts: []
      }
    },
    events: [],
    gateDecisions: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    worktreePath
  };
  return { run, worktreePath, ...(signal ? { signal } : {}) };
}

async function withTempDirs<T>(fn: (cwd: string, evidenceRoot: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'praxis-check-cwd-'));
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'praxis-check-evidence-'));
  try {
    return await fn(cwd, evidenceRoot);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

test('a successful check retains its output as a readable evidence bundle', async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check("console.log('build ok')");
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.artifacts?.length, 1);
    assert.equal(outcome.artifacts?.[0].contractId, 'build-log');

    const { bundle, issues } = await readEvidenceBundle(evidenceRoot, {
      projectId: 'proj-1',
      runId: 'run-1',
      nodeId: node.id,
      attempt: 1
    });
    assert.deepEqual(issues, []);
    assert.equal(bundle?.entries[0].presence, 'present');
    assert.deepEqual(bundle?.source, { kind: 'unknown' }); // cwd is not a git repository
    const content = await readFile(outcome.artifacts![0].path!, 'utf8');
    assert.match(content, /build ok/);
  });
});

test('a failing check retains its output; nothing pretends the check succeeded', async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check("console.error('missing dependency left-pad'); process.exit(1);");
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.artifacts?.length, 1);
    const content = await readFile(outcome.artifacts![0].path!, 'utf8');
    assert.match(content, /missing dependency left-pad/);
  });
});

test('a timed-out command retains its emitted output and states the timeout reason', { timeout: 10_000 }, async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check(
      "process.on('SIGTERM', () => {}); console.log('partial output before timeout'); setInterval(() => {}, 100);"
    );
    node.timeoutMs = 300;
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /timed out after 300ms/);
    // The marker it emitted before being killed must be retained, not discarded.
    assert.equal(outcome.artifacts?.length, 1);
    const content = await readFile(outcome.artifacts![0].path!, 'utf8');
    assert.match(content, /partial output before timeout/);

    const { bundle } = await readEvidenceBundle(evidenceRoot, { projectId: 'proj-1', runId: 'run-1', nodeId: node.id, attempt: 1 });
    assert.equal(bundle?.entries[0].presence, 'present');
  });
});

test('a spawn failure is visible as missing evidence with a stated reason, not silently empty', async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check('', { command: join(cwd, 'this-command-does-not-exist'), args: [] });
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.error && outcome.error.length > 0);
    // A spawn failure produced nothing to reference — unlike a real (even empty) run.
    assert.deepEqual(outcome.artifacts, []);

    const { bundle } = await readEvidenceBundle(evidenceRoot, { projectId: 'proj-1', runId: 'run-1', nodeId: node.id, attempt: 1 });
    assert.equal(bundle?.entries[0].presence, 'missing');
    assert.ok(bundle?.entries[0].missingReason && bundle.entries[0].missingReason.length > 0);
  });
});

test('cancellation retains whatever the process emitted before it was stopped', { timeout: 10_000 }, async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const dir = cwd;
    const marker = join(dir, 'ready');
    const node = check(
      `process.on('SIGTERM', () => {}); console.log('running before cancel'); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 100);`
    );
    const controller = new AbortController();
    const outcomePromise = runWorkflowCheck(node, runContext(node, cwd, controller.signal), undefined, evidenceRoot);

    for (let i = 0; i < 100; i++) {
      if ((await readFile(marker, 'utf8').catch(() => '')) === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();
    const outcome = await outcomePromise;

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /Check cancelled\./);
    assert.equal(outcome.artifacts?.length, 1);
    const content = await readFile(outcome.artifacts![0].path!, 'utf8');
    assert.match(content, /running before cancel/);
  });
});

test('an evidence persistence failure is surfaced, not masqueraded as complete evidence', async () => {
  await withTempDirs(async (cwd, evidenceRootParent) => {
    // A file where the evidence store expects to create a directory: every
    // write beneath it fails.
    const evidenceRoot = join(evidenceRootParent, 'not-a-directory');
    await writeFile(evidenceRoot, 'this is a file, not a directory');

    const node = check("console.log('build ok')");
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /evidence/i);
    assert.deepEqual(outcome.artifacts, []);
  });
});

test('a check with no working directory fails without attempting to run', async () => {
  const node = check("console.log('unreachable')");
  const { run } = runContext(node, '/tmp');
  const contextWithoutWorktree: StageDispatchContext = { run: { ...run, worktreePath: undefined } };
  const outcome = await runWorkflowCheck(node, contextWithoutWorktree, undefined, '/tmp');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /working directory/);
});

test('a check with no command fails without spawning anything', async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check('', { command: '' });
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /no command/);
  });
});

test('a secret echoed by a check is redacted before it becomes evidence, on disk and in the error text', async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const node = check("console.error('API_KEY=sk_live_abcdef1234567890'); process.exit(1);");
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.doesNotMatch(outcome.error ?? '', /sk_live_abcdef1234567890/);
    assert.match(outcome.error ?? '', /API_KEY=\[REDACTED\]/);

    const stored = await readFile(outcome.artifacts![0].path!, 'utf8');
    assert.doesNotMatch(stored, /sk_live_abcdef1234567890/);
    assert.match(stored, /API_KEY=\[REDACTED\]/);

    const { bundle } = await readEvidenceBundle(evidenceRoot, { projectId: 'proj-1', runId: 'run-1', nodeId: node.id, attempt: 1 });
    assert.equal(bundle?.entries[0].redacted, true);
  });
});

/** A stand-in `npm` that prints `output` and exits with `code`, so a check runs the real classifier against it. */
async function fakeNpm(dir: string, output: string, code: number): Promise<string> {
  const path = join(dir, 'npm');
  await writeFile(path, `#!/bin/sh\ncat <<'PRAXIS_EOF'\n${output}\nPRAXIS_EOF\nexit ${code}\n`, { mode: 0o755 });
  return path;
}

test('an npm audit parsed into findings fails with them when it finds a high advisory', { skip: process.platform === 'win32' }, async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const report = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { lodash: { name: 'lodash', severity: 'high', range: '<4.17.21', fixAvailable: true } } }, null, 2);
    const node = check('', {
      command: await fakeNpm(cwd, report, 1),
      args: ['audit', '--audit-level=high', '--json'],
      adapter: 'npm-audit',
      outputs: [{ id: 'security-findings', kind: 'findings', required: true }]
    });
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.pause, undefined);
    assert.equal(outcome.findings?.findings[0].severity, 'high');
  });
});

test('an npm audit against a registry with no audit endpoint pauses, even with the npm-audit adapter attached', { skip: process.platform === 'win32' }, async () => {
  await withTempDirs(async (cwd, evidenceRoot) => {
    const output = `npm warn audit 404 Not Found - POST https://npm.pkg.github.com/-/npm/v1/security/advisories/bulk
{
  "error": {
    "code": null,
    "summary": "audit endpoint returned an error",
    "detail": ""
  }
}`;
    const node = check('', {
      command: await fakeNpm(cwd, output, 1),
      args: ['audit', '--audit-level=high', '--json'],
      adapter: 'npm-audit',
      outputs: [{ id: 'security-findings', kind: 'findings', required: true }]
    });
    const outcome = await runWorkflowCheck(node, runContext(node, cwd), undefined, evidenceRoot);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.pause, 'environment', outcome.error);
    assert.match(outcome.error ?? '', /does not support security audits/);
  });
});
