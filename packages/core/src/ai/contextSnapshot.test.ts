import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextSnapshot,
  CONTEXT_SNAPSHOT_GENERATOR,
  extractDependencyKeys,
  formatContextSnapshot,
  snapshotManifest,
  validateHandover,
  type ContextSnapshot
} from './contextSnapshot';
import { buildHandoverEnvelope, emptyHandoverBrief } from './sessionHandover';
import type { AgentSessionRecord } from './agentTypes';

const AT = '2026-10-08T20:00:00.000Z';

function snapshot(overrides: Partial<Parameters<typeof buildContextSnapshot>[0]> = {}): ContextSnapshot {
  return buildContextSnapshot({
    sessionKey: 'PAY-12',
    createdAt: AT,
    git: { head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', branch: 'feature/pay', dirty: true },
    workspace: '/repo',
    files: [
      { path: 'src/pay.ts', reason: 'touched', bytes: 1200 },
      { path: './src/pay.ts', reason: 'changed', bytes: 1200 },
      { path: 'docs/spec.md', reason: 'declared', bytes: 400 },
      { path: '.env', reason: 'changed', bytes: 80 },
      { path: 'keys/server.pem', reason: 'changed', bytes: 900 },
      { path: 'assets/logo.png', reason: 'changed', bytes: 9000, binary: true },
      { path: 'fixtures/huge.json', reason: 'changed', bytes: 10_000_000 },
      { path: 'src/gone.ts', reason: 'touched' },
      { path: '../other/x.ts', reason: 'touched', bytes: 10 }
    ],
    ticketContext: '## Ticket PAY-12\nSome text mentioning PAY-1.\n## Dependencies\n- PAY-7 Payment provider\n- Blocked by OPS-3\n## Comments\nSee PAY-99.',
    ...overrides
  });
}

test('a snapshot records the commit, the files handed over and those left out with why, and the dependencies', () => {
  const snap = snapshot();
  assert.equal(snap.generator, CONTEXT_SNAPSHOT_GENERATOR);
  assert.equal(snap.sourceCommit, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(snap.dirty, true);
  // Declared first, then touched; the duplicate path counted once.
  assert.deepEqual(snap.includedFiles.map(file => [file.path, file.reason]), [['docs/spec.md', 'declared'], ['src/pay.ts', 'touched']]);
  assert.deepEqual(Object.fromEntries(snap.excludedFiles.map(file => [file.path, file.reason])), {
    '.env': 'secret',
    'keys/server.pem': 'secret',
    'assets/logo.png': 'binary',
    'fixtures/huge.json': 'too-large',
    'src/gone.ts': 'missing',
    '../other/x.ts': 'outside-workspace'
  });
  assert.deepEqual(snap.dependencies, ['OPS-3', 'PAY-7']);
});

test('the file list is bounded, and the overflow is recorded rather than dropped', () => {
  const files = Array.from({ length: 5 }, (_, index) => ({ path: `src/f${index}.ts`, reason: 'changed' as const, bytes: 10 }));
  const snap = snapshot({ files, maxFiles: 3 });
  assert.equal(snap.includedFiles.length, 3);
  assert.deepEqual(snap.excludedFiles.map(file => file.reason), ['limit', 'limit']);
});

test('the fingerprint identifies the state, not the moment', () => {
  assert.equal(snapshot().fingerprint, snapshot({ createdAt: '2027-01-01T00:00:00.000Z' }).fingerprint);
  assert.notEqual(snapshot().fingerprint, snapshot({ git: { head: 'ffffffffffffffffffffffffffffffffffffffff' } }).fingerprint);
});

test('dependency keys come only from dependency headings and lines', () => {
  assert.deepEqual(extractDependencyKeys('Depends on: API-2 and API-3\nUnrelated WEB-9'), ['API-2', 'API-3']);
  assert.deepEqual(extractDependencyKeys(undefined), []);
});

function record(): AgentSessionRecord {
  return {
    issueKey: 'PAY-12',
    provider: 'claude-code-cli',
    taskDefinition: { goal: 'Take card payments', scope: 'src/pay.ts', definitionOfDone: 'Tests pass' },
    handoverBrief: { ...emptyHandoverBrief(AT), progress: 'Card form done', nextSteps: 'Wire the provider', touchedFiles: ['src/pay.ts'] },
    events: []
  } as unknown as AgentSessionRecord;
}

test('acceptance: another provider can resume from the envelope and snapshot alone — commit, files and dependencies are in the text', () => {
  const snap = snapshot();
  const envelope = buildHandoverEnvelope(record(), { provider: 'codex-cli' as never, snapshot: snap });
  assert.equal(envelope.snapshot?.fingerprint, snap.fingerprint);
  assert.match(envelope.text, /## Context snapshot/);
  assert.match(envelope.text, /Source commit: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 on feature\/pay \(with uncommitted changes\)/);
  assert.match(envelope.text, /- docs\/spec\.md \(declared\)\n- src\/pay\.ts \(touched\)/);
  assert.match(envelope.text, /- \.env \(secret\)/);
  assert.match(envelope.text, /Depends on: OPS-3, PAY-7/);
  assert.match(formatContextSnapshot(snapshot({ git: undefined })), /Not a Git repository/);
  assert.deepEqual(validateHandover(envelope, snap, { sessionKey: 'PAY-12', head: snap.sourceCommit }), []);
});

test('a malformed or stale handover is blocked, with the reason', () => {
  const snap = snapshot();
  const good = buildHandoverEnvelope(record(), { snapshot: snap });
  const blocks = (envelope: Parameters<typeof validateHandover>[0], snapshotValue: ContextSnapshot | undefined, head?: string, sessionKey = 'PAY-12') =>
    validateHandover(envelope, snapshotValue, { sessionKey, ...(head ? { head } : {}) }).filter(issue => issue.level === 'block').map(issue => issue.message).join(' | ');

  assert.match(blocks({ ...good, purpose: { ...good.purpose, goal: '' } }, snap), /no goal/);
  assert.match(blocks({ ...good, brief: { ...good.brief, touchedFiles: 'src/pay.ts' as never } }, snap), /touched files are not a list/);
  assert.match(blocks({ ...good, text: `${good.text}\nkey: sk-ant-abcdefghijklmnopqrstuvwx` }, snap), /looks like a secret/);
  assert.match(blocks(good, undefined), /no context snapshot/);
  assert.match(blocks(good, snap, 'ffffffffffffffffffffffffffffffffffffffff'), /The work has moved since the snapshot \(a1b2c3d → fffffff\)/);
  assert.match(blocks(good, snap, undefined, 'OTHER-1'), /different session/);
  assert.match(blocks(good, { ...snap, generator: 'old@0' }), /made by old@0/);
  assert.match(blocks(good, { ...snap, includedFiles: [...snap.includedFiles, { path: 'config/.env.production', reason: 'touched' }] }), /looks like a secrets file/);
});

test('a manifest links the persisted snapshot as evidence', () => {
  const snap = snapshot();
  assert.deepEqual(snapshotManifest(snap, '/data/handover-snapshots/PAY-12/x.json'), {
    sessionKey: 'PAY-12', createdAt: AT, fingerprint: snap.fingerprint, sourceCommit: snap.sourceCommit,
    path: '/data/handover-snapshots/PAY-12/x.json', included: 2, excluded: 6
  });
});
