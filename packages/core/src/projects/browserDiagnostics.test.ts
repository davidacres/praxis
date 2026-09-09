import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserDiagnosticsRecorder,
  DEFAULT_CONSOLE_BUFFER_SIZE,
  readBrowserDiagnosticsBundle,
  readScreenshot,
  writeBrowserDiagnosticsBundle,
  writeScreenshot,
  type BrowserDiagnosticsBundleKey
} from './browserDiagnostics';

function key(overrides: Partial<BrowserDiagnosticsBundleKey> = {}): BrowserDiagnosticsBundleKey {
  return { projectId: 'proj-1', runId: 'run-1', serviceId: 'web', ...overrides };
}

test('a seeded console error appears in the correct run bundle', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordConsole('error', 'TypeError: fetch failed');
  const bundle = recorder.snapshot();
  assert.equal(bundle.projectId, 'proj-1');
  assert.equal(bundle.runId, 'run-1');
  assert.equal(bundle.serviceId, 'web');
  assert.equal(bundle.console.length, 1);
  assert.equal(bundle.console[0].level, 'error');
  assert.equal(bundle.console[0].message, 'TypeError: fetch failed');
});

test('a seeded failed API request appears in the correct run bundle', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordNetworkFailure({ url: 'http://127.0.0.1:5000/api/orders', method: 'GET', status: 500 });
  const bundle = recorder.snapshot();
  assert.equal(bundle.network.length, 1);
  assert.equal(bundle.network[0].url, 'http://127.0.0.1:5000/api/orders');
  assert.equal(bundle.network[0].status, 500);
  assert.equal(bundle.network[0].error, undefined);
});

test('a connection-level network failure has no status, distinct from an HTTP error status', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordNetworkFailure({ url: 'http://127.0.0.1:9999/', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' });
  const [entry] = recorder.snapshot().network;
  assert.equal(entry.status, undefined);
  assert.equal(entry.error, 'net::ERR_CONNECTION_REFUSED');
});

test('a credential-shaped console message is redacted before it reaches the bundle', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordConsole('log', 'Authorization: Bearer sk_live_abcdefghij1234567890');
  const [entry] = recorder.snapshot().console;
  assert.doesNotMatch(entry.message, /sk_live_abcdefghij1234567890/);
  assert.match(entry.message, /\[REDACTED\]/);
  assert.equal(entry.redacted, true);
});

test('a credential-shaped query string in a failed request URL is redacted', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordNetworkFailure({ url: 'http://127.0.0.1:5000/api?api_key=abcd1234efgh5678', method: 'GET', status: 401 });
  const [entry] = recorder.snapshot().network;
  assert.doesNotMatch(entry.url, /abcd1234efgh5678/);
  assert.equal(entry.redacted, true);
});

test('an ordinary console message and successful-looking URL are not marked redacted', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordConsole('info', 'App mounted');
  recorder.recordNetworkFailure({ url: 'http://127.0.0.1:5000/api/orders', method: 'GET', status: 404 });
  const bundle = recorder.snapshot();
  assert.equal(bundle.console[0].redacted, false);
  assert.equal(bundle.network[0].redacted, false);
});

test('two recorders for different runs never see each other\'s entries — isolation is per-instance', () => {
  const projectA = new BrowserDiagnosticsRecorder(key({ runId: 'run-a' }));
  const projectB = new BrowserDiagnosticsRecorder(key({ runId: 'run-b' }));
  projectA.recordConsole('error', 'A failed');
  projectB.recordConsole('error', 'B failed');
  assert.deepEqual(projectA.snapshot().console.map(e => e.message), ['A failed']);
  assert.deepEqual(projectB.snapshot().console.map(e => e.message), ['B failed']);
});

test('the console buffer is bounded — the oldest entries are dropped and truncated is set', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  for (let i = 0; i < DEFAULT_CONSOLE_BUFFER_SIZE + 10; i++) recorder.recordConsole('log', `line ${i}`);
  const bundle = recorder.snapshot();
  assert.equal(bundle.console.length, DEFAULT_CONSOLE_BUFFER_SIZE);
  assert.equal(bundle.console[0].message, 'line 10', 'the oldest 10 entries should have been dropped');
  assert.equal(bundle.truncated, true);
});

test('a bundle with nothing captured is not truncated', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordConsole('log', 'one line');
  assert.equal(recorder.snapshot().truncated, false);
});

test('a written bundle round-trips through storage unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const recorder = new BrowserDiagnosticsRecorder(key());
    recorder.recordConsole('warning', 'slow response');
    const bundle = recorder.snapshot('2026-09-09T00:00:00.000Z');
    await writeBrowserDiagnosticsBundle(dir, bundle);
    assert.deepEqual(await readBrowserDiagnosticsBundle(dir, key()), bundle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reading a bundle that was never written comes back undefined, not an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    assert.equal(await readBrowserDiagnosticsBundle(dir, key()), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed bundle file on disk is treated as absent rather than thrown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'proj-1', 'run-1', 'web'), { recursive: true });
    await writeFile(path.join(dir, 'proj-1', 'run-1', 'web', 'bundle.json'), 'not json', 'utf8');
    assert.equal(await readBrowserDiagnosticsBundle(dir, key()), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two different projects\' bundles are stored in isolated directories and never collide', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const bundleA = new BrowserDiagnosticsRecorder(key({ projectId: 'proj-a' })).snapshot();
    const bundleB = new BrowserDiagnosticsRecorder(key({ projectId: 'proj-b' })).snapshot();
    await writeBrowserDiagnosticsBundle(dir, bundleA);
    await writeBrowserDiagnosticsBundle(dir, bundleB);
    assert.equal((await readBrowserDiagnosticsBundle(dir, key({ projectId: 'proj-a' })))?.projectId, 'proj-a');
    assert.equal((await readBrowserDiagnosticsBundle(dir, key({ projectId: 'proj-b' })))?.projectId, 'proj-b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a path-shaped project id is refused rather than escaping the storage root', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const bundle = new BrowserDiagnosticsRecorder(key({ projectId: '../../etc' })).snapshot();
    await assert.rejects(() => writeBrowserDiagnosticsBundle(dir, bundle), /Unsafe projectId/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a screenshot round-trips through storage, and its record is a bare generated filename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes, not a full valid image — content-agnostic storage
    const record = await writeScreenshot(dir, key(), png, '2026-09-09T00:00:00.000Z');
    assert.equal(record.presence, 'present');
    assert.match(record.path ?? '', /^screenshot-\d+\.png$/);
    const readBack = await readScreenshot(dir, key(), record);
    assert.deepEqual(readBack, png);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reading a screenshot with a path-traversal-shaped record fails closed rather than escaping the bundle directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-diag-'));
  try {
    const hostile = { presence: 'present' as const, path: '../../../etc/passwd', capturedAt: '2026-09-09T00:00:00.000Z' };
    assert.equal(await readScreenshot(dir, key(), hostile), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing screenshot record carries a reason rather than being silently absent', () => {
  const recorder = new BrowserDiagnosticsRecorder(key());
  recorder.recordScreenshot({ presence: 'missing', capturedAt: '2026-09-09T00:00:00.000Z', missingReason: 'capturePage() threw: window was destroyed' });
  const [record] = recorder.snapshot().screenshots;
  assert.equal(record.presence, 'missing');
  assert.equal(record.missingReason, 'capturePage() threw: window was destroyed');
});
