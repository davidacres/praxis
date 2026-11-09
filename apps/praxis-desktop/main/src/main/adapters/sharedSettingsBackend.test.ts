import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SharedSettingsBackend } from './sharedSettingsBackend';
import { JsonKeyValueStore } from './jsonKeyValueStore';
import { withJsonFileWrite } from './jsonFileWrites';

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-settings-consistency-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  const backend = new SharedSettingsBackend(file);
  t.after(() => { backend.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, backend };
}

test('failed settings persistence rolls back its patch, preserves later edits and does not poison the queue', async t => {
  const { file, backend } = fixture(t);
  const originalTheme = backend.read().appearance.themeId;
  const rename = fs.promises.rename;
  let fail = true;
  t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof rename>) => {
    if (args[1] === file && fail) { fail = false; throw new Error('injected save failure'); }
    return rename(...args);
  });
  let release!: () => void;
  const held = withJsonFileWrite(file, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  let notifications = 0;
  backend.onDidChange(() => notifications++);
  const failed = assert.rejects(backend.write({ appearance: { themeId: 'failed-theme' } }), /injected save failure/);
  const later = backend.write({ terminal: { fontSize: 21 } });
  assert.equal(backend.read().appearance.themeId, 'failed-theme');
  assert.equal(backend.read().terminal.fontSize, 21);
  release();
  await held;
  await failed;
  await later;
  assert.equal(backend.read().appearance.themeId, originalTheme);
  assert.equal(backend.read().terminal.fontSize, 21);
  assert.equal(notifications, 1);
  await backend.write({ terminal: { fontSize: 22 } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).terminal.fontSize, 22);
  assert.equal(notifications, 2);
});

test('settings and key-value adapters sharing one document preserve each others fields', async t => {
  const { file, backend } = fixture(t);
  const connections = new JsonKeyValueStore(file);
  const operations: Promise<unknown>[] = [];
  for (let i = 0; i < 15; i++) {
    operations.push(backend.write({ terminal: { fontSize: 10 + i } }));
    operations.push(connections.update('praxis.connections', [{ id: `connection-${i}` }]));
  }
  await Promise.all(operations);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(document.terminal.fontSize, 24);
  assert.deepEqual(document['praxis.connections'], [{ id: 'connection-14' }]);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('watcher adopts a genuine external edit immediately after a local save without echoing it', async t => {
  const { file, backend } = fixture(t);
  let notifications = 0;
  backend.onDidChange(() => notifications++);
  await backend.write({ terminal: { fontSize: 20 } });
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  document.terminal.fontSize = 23;
  fs.writeFileSync(file, JSON.stringify(document));
  const deadline = Date.now() + 2000;
  while (backend.read().terminal.fontSize !== 23 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(backend.read().terminal.fontSize, 23);
  assert.equal(notifications, 2);
});
