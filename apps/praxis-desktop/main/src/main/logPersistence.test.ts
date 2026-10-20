import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogBus } from '@praxis/core';
import { attachLogPersistence, readRecentLogLines } from './logPersistence';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'praxis-log-'));
}

/** Waits for the serialised writer to flush. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
}

test('lines written in one session seed the next session', async () => {
  const dir = await tempDir();
  const first = new LogBus();
  attachLogPersistence(first, dir);
  first.appendLine('[ai] started');
  first.appendLine('[jira] multi\nline');
  await settle();

  const second = new LogBus();
  attachLogPersistence(second, dir);
  assert.deepEqual(second.recent().slice(0, 2), ['[ai] started', '[jira] multi\nline']);
  assert.match(second.recent()[2], /previous session/);
});

test('a first run has no history and no marker', async () => {
  const bus = new LogBus();
  attachLogPersistence(bus, await tempDir());
  assert.deepEqual(bus.recent(), []);
});

test('a corrupt or truncated line is skipped, not fatal', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'application.log'), '"ok"\n{broken\n"also ok"\n"half');
  assert.deepEqual(readRecentLogLines(dir, 10), ['ok', 'also ok']);
});

test('only the most recent lines are loaded', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'application.log'), ['"a"', '"b"', '"c"'].join('\n'));
  assert.deepEqual(readRecentLogLines(dir, 2), ['b', 'c']);
});

test('an unwritable log directory never throws into the logger', async () => {
  const dir = await tempDir();
  const blocker = path.join(dir, 'file');
  await fs.writeFile(blocker, 'x');
  const bus = new LogBus();
  attachLogPersistence(bus, path.join(blocker, 'logs'));
  assert.doesNotThrow(() => bus.appendLine('still works'));
  assert.deepEqual(bus.recent(), ['still works']);
});

test('the session boundary marker is itself kept for the following session', async () => {
  const dir = await tempDir();
  const first = new LogBus();
  attachLogPersistence(first, dir);
  first.appendLine('one');
  await settle();
  const second = new LogBus();
  attachLogPersistence(second, dir);
  second.appendLine('two');
  await settle();
  const third = new LogBus();
  attachLogPersistence(third, dir);
  assert.equal(third.recent().filter(line => /previous session/.test(line)).length, 2);
  assert.deepEqual(third.recent().slice(0, 3).map(line => line.slice(0, 3)), ['one', '—— ', 'two']);
});
