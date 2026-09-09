import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciEvidenceKey, importCiRunAsEvidence, type ImportCiRunInput } from './ciEvidenceImport';
import { readEvidenceBundle, writeEvidenceBundle } from '../workflows/workflowEvidence';
import type { CiEvidenceProvider, CiJobLogResult, CiJobSummary, CiRunSummary } from './ciEvidenceProvider';

function run(overrides: Partial<CiRunSummary> = {}): CiRunSummary {
  return {
    runId: '999',
    attempt: 1,
    source: { kind: 'commit', sha: 'deadbeef' },
    conclusion: 'failure',
    htmlUrl: 'https://github.com/acme/demo/actions/runs/999',
    createdAt: '2026-09-08T00:00:00.000Z',
    workflowName: 'CI',
    ...overrides
  };
}

function job(overrides: Partial<CiJobSummary> = {}): CiJobSummary {
  return { jobId: '42', name: 'build', conclusion: 'failure', htmlUrl: 'https://github.com/acme/demo/actions/runs/999/job/42', ...overrides };
}

function fakeProvider(log: CiJobLogResult | (() => Promise<CiJobLogResult>)): CiEvidenceProvider {
  return {
    kind: 'github-actions',
    listFailedRuns: async () => ({ runs: [], hasMore: false }),
    listJobs: async () => [],
    getJobLog: async () => (typeof log === 'function' ? log() : log)
  };
}

test('ciEvidenceKey namespaces CI imports separately from local workflow runs', () => {
  const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');
  assert.equal(key.projectId, 'proj-1');
  assert.equal(key.runId, 'ci-github-actions-999');
  assert.equal(key.nodeId, '42');
  assert.equal(key.attempt, 1);
});

test('importCiRunAsEvidence builds a bundle carrying the run source and job source link', async () => {
  const provider = fakeProvider({ content: 'FAIL: expected 1 to equal 2', expired: false });
  const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');
  const result = await importCiRunAsEvidence({ provider, run: run(), job: job(), key, at: '2026-09-08T00:05:00.000Z' });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.bundle.source, { kind: 'commit', sha: 'deadbeef' });
  assert.equal(result.bundle.sourceUrl, job().htmlUrl);
  assert.equal(result.bundle.entries[0].presence, 'present');
  assert.equal(result.content, 'FAIL: expected 1 to equal 2');
});

test('an expired provider log becomes explicit missing evidence, not an error', async () => {
  const provider = fakeProvider({ content: '', expired: true });
  const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');
  const result = await importCiRunAsEvidence({ provider, run: run(), job: job(), key, at: '2026-09-08T00:05:00.000Z' });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.entries[0].presence, 'missing');
  assert.match(result.bundle.entries[0].missingReason ?? '', /expired/i);
});

test('a provider error is preserved verbatim, not swallowed into a generic failure', async () => {
  const provider: CiEvidenceProvider = {
    kind: 'github-actions',
    listFailedRuns: async () => ({ runs: [], hasMore: false }),
    listJobs: async () => [],
    getJobLog: async () => {
      throw new Error('No permission to read this job’s log (HTTP 403). The token needs actions:read.');
    }
  };
  const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');
  const result = await importCiRunAsEvidence({ provider, run: run(), job: job(), key, at: '2026-09-08T00:05:00.000Z' });

  assert.deepEqual(result, { ok: false, error: 'No permission to read this job’s log (HTTP 403). The token needs actions:read.' });
});

test('importing an older attempt never resolves to the same evidence key as the latest attempt', () => {
  const older = ciEvidenceKey('proj-1', 'github-actions', run({ attempt: 1 }), '42');
  const latest = ciEvidenceKey('proj-1', 'github-actions', run({ attempt: 2 }), '42');
  assert.notDeepEqual(older, latest);
});

test('retrying an import overwrites the same bundle rather than duplicating it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-ci-evidence-'));
  try {
    const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');

    const first = await importCiRunAsEvidence({
      provider: fakeProvider({ content: 'first attempt output', expired: false }),
      run: run(),
      job: job(),
      key,
      at: '2026-09-08T00:05:00.000Z'
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await writeEvidenceBundle(root, first.bundle, new Map([[first.bundle.entries[0].label, first.content!]]));

    const retried = await importCiRunAsEvidence({
      provider: fakeProvider({ content: 'second attempt output', expired: false }),
      run: run(),
      job: job(),
      key,
      at: '2026-09-08T00:06:00.000Z'
    });
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    assert.equal(retried.bundle.bundleId, first.bundle.bundleId); // same deterministic id
    await writeEvidenceBundle(root, retried.bundle, new Map([[retried.bundle.entries[0].label, retried.content!]]));

    const read = await readEvidenceBundle(root, key);
    assert.equal(read.bundle?.entries.length, 1); // overwritten, not appended
    assert.equal(read.bundle?.createdAt, '2026-09-08T00:06:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation is forwarded to the provider and surfaces as the provider\'s own abort error', async () => {
  const controller = new AbortController();
  const provider: CiEvidenceProvider = {
    kind: 'github-actions',
    listFailedRuns: async () => ({ runs: [], hasMore: false }),
    listJobs: async () => [],
    getJobLog: async (_jobId, signal) => {
      assert.equal(signal, controller.signal);
      signal?.throwIfAborted();
      return { content: 'unreachable', expired: false };
    }
  };
  controller.abort();
  const key = ciEvidenceKey('proj-1', 'github-actions', run(), '42');
  const result = await importCiRunAsEvidence({ provider, run: run(), job: job(), key, at: '2026-09-08T00:05:00.000Z', signal: controller.signal });
  assert.equal(result.ok, false);
});
