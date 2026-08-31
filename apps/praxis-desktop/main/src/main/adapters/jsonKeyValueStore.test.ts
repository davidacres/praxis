import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonKeyValueStore } from './jsonKeyValueStore';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-kv-')), 'store.json');
}

test('concurrent updates all land without an ENOENT temp-file race', async () => {
  const file = tmpFile();
  const store = new JsonKeyValueStore(file);

  // Fire many overlapping writes in the same tick — the exact shape that used
  // to collide on `<file>.<pid>.<Date.now()>.tmp`.
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => store.update(`k${i}`, { i, at: Date.now() }))
  );

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { i: number }>;
  for (let i = 0; i < 40; i++) {
    assert.equal(onDisk[`k${i}`]?.i, i, `k${i} missing from the persisted file`);
    assert.equal(store.get<{ i: number }>(`k${i}`)?.i, i);
  }
  // No stray temp files left behind.
  const strays = fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(strays, []);
});

test('a rejected write rolls its key back and does not wedge the queue', async () => {
  const file = tmpFile();
  const store = new JsonKeyValueStore(file);
  await store.update('ok', 1);

  // A value JSON.stringify throws on — the persist rejects.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(store.update('bad', circular));
  assert.equal(store.get('bad'), undefined, 'failed key was rolled back in memory');

  // The queue still works afterwards.
  await store.update('after', 2);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, { ok: 1, after: 2 });
});
