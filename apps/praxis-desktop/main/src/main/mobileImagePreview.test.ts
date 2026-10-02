import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { AgentSessionRecord } from '@praxis/core';
import { findSessionRecord, readMobileImagePreview } from './mobileImagePreview';

const TRANSPARENT_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function record(workingDirectory: string, overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    issueKey: 'S-1', sessionId: 's1', title: 'x', state: 'completed', taskDefinition: { goal: 'x', scope: 'repo', definitionOfDone: 'done' },
    mode: 'chat', stepCount: 1, startedAt: '2026-09-22T09:00:00.000Z', workingDirectory,
    events: [],
    ...overrides,
  };
}

test('reads a previewable image inside the session folder as a data URL', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  writeFileSync(nodePath.join(dir, 'shot.png'), TRANSPARENT_PIXEL_PNG);
  const preview = await readMobileImagePreview(record(dir), { path: 'shot.png' });
  assert.equal(preview?.mimeType, 'image/png');
  assert.equal(preview?.dataBase64, TRANSPARENT_PIXEL_PNG.toString('base64'));
  assert.equal(preview?.nextOffset, preview?.totalLength);
});

test('a nested path still resolves within the session folder', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  mkdirSync(nodePath.join(dir, 'artifacts'));
  writeFileSync(nodePath.join(dir, 'artifacts', 'shot.png'), TRANSPARENT_PIXEL_PNG);
  const preview = await readMobileImagePreview(record(dir), { path: 'artifacts/shot.png' });
  assert.equal(preview?.mimeType, 'image/png');
});

test('refuses a path that escapes the session folder', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  const result = await readMobileImagePreview(record(dir), { path: '../../etc/passwd' });
  assert.equal(result, undefined);
});

test('a non-image extension is not previewed', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  writeFileSync(nodePath.join(dir, 'notes.txt'), 'hello');
  const result = await readMobileImagePreview(record(dir), { path: 'notes.txt' });
  assert.equal(result, undefined);
});

test('a missing file is a quiet miss, not an error', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  const result = await readMobileImagePreview(record(dir), { path: 'missing.png' });
  assert.equal(result, undefined);
});

test('a session with no known working folder is a quiet miss', async () => {
  const result = await readMobileImagePreview(record(''), { path: 'shot.png' });
  assert.equal(result, undefined);
});

test('returns large image previews in bounded, aligned chunks', async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'praxis-mobile-image-'));
  const image = Buffer.alloc(900 * 1024, 0x5a);
  writeFileSync(nodePath.join(dir, 'large.png'), image);
  const first = await readMobileImagePreview(record(dir), { path: 'large.png' });
  assert.equal(first?.dataBase64?.length, 768 * 1024);
  assert.equal(first?.nextOffset, 768 * 1024);
  assert.equal(first?.totalLength, image.toString('base64').length);
  const second = await readMobileImagePreview(record(dir), { path: 'large.png', offset: first!.nextOffset });
  assert.equal(second?.dataBase64, image.toString('base64').slice(first!.nextOffset));
  assert.equal(second?.nextOffset, second?.totalLength);
});

test('reads an attached user image by event and attachment index', async () => {
  const session = record('', {
    events: [{
      timestamp: '2026-09-22T09:00:00.000Z',
      type: 'user_input_completed',
      summary: 'What is this?',
      attachments: [{ mimeType: 'image/jpeg', dataBase64: 'AQID' }],
    }],
  });
  const preview = await readMobileImagePreview(session, { eventIndex: 0, attachmentIndex: 0 });
  assert.deepEqual(preview, { mimeType: 'image/jpeg', dataBase64: 'AQID', nextOffset: 4, totalLength: 4 });
  assert.equal(await readMobileImagePreview(session, { eventIndex: 1, attachmentIndex: 0 }), undefined);
  assert.equal(await readMobileImagePreview(session, { eventIndex: 0, attachmentIndex: 1 }), undefined);
});

test('a session is found by its id or by the issue key a gadget carries', () => {
  const records = [
    { sessionId: 'bb1c41c7-uuid', issueKey: 'SESSION-c012d5ce' },
    { sessionId: 'other-uuid', issueKey: 'SESSION-ffffffff' },
  ];
  assert.equal(findSessionRecord(records, 'bb1c41c7-uuid'), records[0]);
  // The gadget's work id: this is what a phone sends for an artifact image.
  assert.equal(findSessionRecord(records, 'SESSION-c012d5ce'), records[0]);
  assert.equal(findSessionRecord(records, 'SESSION-ffffffff'), records[1]);
  assert.equal(findSessionRecord(records, 'missing'), undefined);
});
