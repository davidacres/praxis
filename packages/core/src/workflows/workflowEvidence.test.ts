import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureEvidenceEntry,
  commitEvidenceSource,
  createEvidenceBundle,
  defaultEvidenceRetention,
  DEFAULT_EVIDENCE_MAX_BYTES,
  evidenceBundleDir,
  evidenceBundleId,
  isEvidenceExpired,
  legalHoldEvidenceRetention,
  parseEvidenceBundle,
  readEvidenceBundle,
  readEvidenceContent,
  serializeEvidenceBundle,
  unknownEvidenceSource,
  validateEvidenceBundle,
  withEvidenceEntry,
  writeEvidenceBundle,
  WORKFLOW_EVIDENCE_SCHEMA_VERSION,
  type WorkflowEvidenceBundle,
  type WorkflowEvidenceBundleKey
} from './workflowEvidence';

const KEY: WorkflowEvidenceBundleKey = { projectId: 'proj-1', runId: 'run-1', nodeId: 'check-build', attempt: 1 };

function baseBundle(): WorkflowEvidenceBundle {
  return createEvidenceBundle({
    key: KEY,
    source: commitEvidenceSource('abc1234'),
    createdAt: '2026-09-07T12:00:00.000Z'
  });
}

test('evidenceBundleId is deterministic from run, node and attempt — recapturing an attempt does not mint a new identity', () => {
  assert.equal(evidenceBundleId(KEY), 'run-1-check-build-1');
  assert.equal(evidenceBundleId(KEY), evidenceBundleId({ ...KEY }));
});

test('a valid bundle with a captured log entry passes validation', () => {
  const { entry } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: 'build failed: missing dependency'
  });
  const bundle = withEvidenceEntry(baseBundle(), entry);
  assert.deepEqual(validateEvidenceBundle(bundle), []);
});

// ── Missing vs. empty ───────────────────────────────────────────────────

test('a capture that never ran is "missing", not "empty" — and must say why', () => {
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: undefined,
    missingReason: 'The check process never started.'
  });
  assert.equal(entry.presence, 'missing');
  assert.equal(entry.path, undefined);
  assert.equal(content, undefined);
  assert.equal(entry.missingReason, 'The check process never started.');
});

test('a command that legitimately printed nothing is "empty", not "missing"', () => {
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: ''
  });
  assert.equal(entry.presence, 'empty');
  assert.equal(entry.path, undefined);
  assert.equal(content, undefined);
});

test('missing evidence without a reason fails validation — a gap must never be silent', () => {
  const bundle = withEvidenceEntry(baseBundle(), {
    evidenceId: 'x',
    kind: 'log',
    label: 'combined',
    presence: 'missing',
    capturedAt: '2026-09-07T12:00:01.000Z',
    truncated: false,
    redacted: false,
    retention: legalHoldEvidenceRetention()
    // missingReason omitted deliberately
  });
  const issues = validateEvidenceBundle(bundle);
  assert.ok(issues.some(issue => issue.path.endsWith('.missingReason')));
});

test('an entry marked missing or empty must not carry a stored path', () => {
  const bundle = withEvidenceEntry(baseBundle(), {
    evidenceId: 'x',
    kind: 'log',
    label: 'combined',
    presence: 'empty',
    capturedAt: '2026-09-07T12:00:01.000Z',
    path: 'combined.txt',
    truncated: false,
    redacted: false,
    retention: legalHoldEvidenceRetention()
  });
  const issues = validateEvidenceBundle(bundle);
  assert.ok(issues.some(issue => issue.path.endsWith('.path')));
});

// ── Unknown commit ────────────────────────────────────────────────────────

test('an unknown source commit is explicit, not an absent field, and is valid', () => {
  const bundle = createEvidenceBundle({ key: KEY, source: unknownEvidenceSource(), createdAt: '2026-09-07T12:00:00.000Z' });
  assert.deepEqual(bundle.source, { kind: 'unknown' });
  assert.deepEqual(validateEvidenceBundle(bundle), []);
});

test('a source that is neither a real commit sha nor explicitly unknown fails validation', () => {
  const bundle = { ...baseBundle(), source: { kind: 'commit', sha: '' } as unknown } as WorkflowEvidenceBundle;
  const issues = validateEvidenceBundle(bundle);
  assert.ok(issues.some(issue => issue.path === 'source'));
});

// ── Cross-project and path-traversal rejection ───────────────────────────

test('a bundle naming a different project than expected is rejected as a cross-project reference', () => {
  const bundle = baseBundle();
  const issues = validateEvidenceBundle(bundle, { projectId: 'some-other-project' });
  assert.ok(issues.some(issue => issue.path === 'projectId' && issue.message.includes('cross-project')));
});

test('a present entry whose path attempts traversal is rejected', () => {
  const bundle = withEvidenceEntry(baseBundle(), {
    evidenceId: 'x',
    kind: 'log',
    label: 'combined',
    presence: 'present',
    capturedAt: '2026-09-07T12:00:01.000Z',
    path: '../../etc/passwd',
    storedBytes: 10,
    truncated: false,
    redacted: false,
    retention: legalHoldEvidenceRetention()
  });
  const issues = validateEvidenceBundle(bundle);
  assert.ok(issues.some(issue => issue.path.endsWith('.path')));
});

test('evidenceBundleDir refuses a nodeId that attempts to escape the storage root', () => {
  assert.throws(() => evidenceBundleDir('/tmp/evidence', { ...KEY, nodeId: '../../escape' }), /Unsafe evidence nodeId/);
});

// ── Truncation ────────────────────────────────────────────────────────────

test('content under the byte cap is stored whole and not marked truncated', () => {
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: 'short log line'
  });
  assert.equal(entry.truncated, false);
  assert.equal(entry.storedBytes, entry.originalBytes);
  assert.equal(content, 'short log line');
});

test('content over the byte cap is truncated, keeping the tail, and records both sizes', () => {
  const big = 'x'.repeat(DEFAULT_EVIDENCE_MAX_BYTES + 500);
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: big
  });
  assert.equal(entry.truncated, true);
  assert.ok(entry.originalBytes! > entry.storedBytes!);
  assert.equal(entry.originalBytes, DEFAULT_EVIDENCE_MAX_BYTES + 500);
  assert.ok(content!.endsWith('x'));
  assert.ok(content!.startsWith('…'));
});

test('truncation never splits a multi-byte UTF-8 character', () => {
  // Every character here is a 3-byte UTF-8 sequence; a byte-boundary cut in the
  // middle of one would produce an invalid/garbled string.
  const content = '€'.repeat(1000);
  const { entry, content: stored } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'log',
    label: 'combined',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content,
    maxBytes: 100
  });
  assert.equal(entry.truncated, true);
  // Every remaining character must be a whole €, never a partial byte sequence.
  const body = stored!.replace(/^…/, '');
  assert.ok(body.length > 0);
  for (const ch of body) assert.equal(ch, '€');
});

test('a truncated entry inconsistent about its sizes fails validation', () => {
  const bundle = withEvidenceEntry(baseBundle(), {
    evidenceId: 'x',
    kind: 'log',
    label: 'combined',
    presence: 'present',
    capturedAt: '2026-09-07T12:00:01.000Z',
    path: 'combined.txt',
    storedBytes: 100,
    originalBytes: 50, // smaller than stored — nonsensical for a truncation
    truncated: true,
    redacted: false,
    retention: legalHoldEvidenceRetention()
  });
  const issues = validateEvidenceBundle(bundle);
  assert.ok(issues.some(issue => issue.path.endsWith('.truncated')));
});

// ── Retention ─────────────────────────────────────────────────────────────

test('default retention expires after the configured window; legal hold never expires', () => {
  const retention = defaultEvidenceRetention('2026-01-01T00:00:00.000Z', 30);
  assert.equal(isEvidenceExpired(retention, '2026-02-01T00:00:00.001Z'), true);
  assert.equal(isEvidenceExpired(retention, '2026-01-15T00:00:00.000Z'), false);
  assert.equal(isEvidenceExpired(legalHoldEvidenceRetention(), '2099-01-01T00:00:00.000Z'), false);
});

// ── Round trip ────────────────────────────────────────────────────────────

test('a bundle round-trips through serialize/parse unchanged', () => {
  const { entry } = captureEvidenceEntry({
    bundleId: evidenceBundleId(KEY),
    kind: 'test-results',
    label: 'junit',
    capturedAt: '2026-09-07T12:00:01.000Z',
    content: '<testsuite/>'
  });
  const bundle = withEvidenceEntry(baseBundle(), entry);
  const { bundle: roundTripped, issues } = parseEvidenceBundle(JSON.parse(serializeEvidenceBundle(bundle)));
  assert.deepEqual(issues, []);
  assert.deepEqual(roundTripped, bundle);
});

test('parseEvidenceBundle fails closed on a malformed payload rather than guessing', () => {
  const { bundle, issues } = parseEvidenceBundle({ not: 'a bundle' });
  assert.equal(bundle, undefined);
  assert.ok(issues.length > 0);
});

test('parseEvidenceBundle rejects a schema version it does not understand', () => {
  const future = { ...baseBundle(), schemaVersion: WORKFLOW_EVIDENCE_SCHEMA_VERSION + 1 };
  const { bundle, issues } = parseEvidenceBundle(future);
  assert.equal(bundle, undefined);
  assert.ok(issues.some(issue => issue.path === 'schemaVersion'));
});

// ── Storage ───────────────────────────────────────────────────────────────

test('writeEvidenceBundle then readEvidenceBundle/readEvidenceContent round-trip through disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-evidence-'));
  try {
    const { entry, content } = captureEvidenceEntry({
      bundleId: evidenceBundleId(KEY),
      kind: 'log',
      label: 'combined',
      capturedAt: '2026-09-07T12:00:01.000Z',
      content: 'exit code 1: missing dependency "left-pad"'
    });
    const bundle = withEvidenceEntry(baseBundle(), entry);

    await writeEvidenceBundle(root, bundle, new Map([['combined', content!]]));

    const read = await readEvidenceBundle(root, KEY);
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.bundle, bundle);

    const storedContent = await readEvidenceContent(root, KEY, read.bundle!.entries[0]);
    assert.equal(storedContent, content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reading a bundle that was never written comes back as undefined, not an error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-evidence-'));
  try {
    const read = await readEvidenceBundle(root, KEY);
    assert.equal(read.bundle, undefined);
    assert.deepEqual(read.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeEvidenceBundle refuses an invalid bundle before touching disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-evidence-'));
  try {
    const invalid = { ...baseBundle(), bundleId: 'not-the-derived-id' };
    await assert.rejects(() => writeEvidenceBundle(root, invalid, new Map()), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeEvidenceBundle for one attempt does not disturb another attempt of the same node', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'praxis-evidence-'));
  try {
    const attempt1Key = { ...KEY, attempt: 1 };
    const attempt2Key = { ...KEY, attempt: 2 };
    const b1 = createEvidenceBundle({ key: attempt1Key, source: commitEvidenceSource('aaa1111'), createdAt: '2026-09-07T12:00:00.000Z' });
    const b2 = createEvidenceBundle({ key: attempt2Key, source: commitEvidenceSource('bbb2222'), createdAt: '2026-09-07T12:05:00.000Z' });
    await writeEvidenceBundle(root, b1, new Map());
    await writeEvidenceBundle(root, b2, new Map());

    const read1 = await readEvidenceBundle(root, attempt1Key);
    const read2 = await readEvidenceBundle(root, attempt2Key);
    assert.equal(read1.bundle?.source && 'sha' in read1.bundle.source ? read1.bundle.source.sha : undefined, 'aaa1111');
    assert.equal(read2.bundle?.source && 'sha' in read2.bundle.source ? read2.bundle.source.sha : undefined, 'bbb2222');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
