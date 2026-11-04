import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamChatStore } from '@praxis/core';
import { FileTeamChatRepository } from './adapters/teamChatRepository';
import { TeamChatActivation } from './teamChatActivation';
import { TeamChatAttachments } from './teamChatAttachments';

function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-activation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'team-chats.json');
  fs.writeFileSync(file, JSON.stringify({ teamChats: [{ id: 'old', projectId: 'p', title: 'Old', createdAt: 'then', updatedAt: 'then', messages: [] }] }));
  return { file, repository: new FileTeamChatRepository(file) };
}
test('quiescence fences new legacy requests and waits for text-only calls and saves', async () => {
  const activation = new TeamChatActivation();
  let settle!: () => void;
  const work = activation.legacy(() => new Promise<void>(resolve => { settle = resolve; }));
  let committed = false;
  const cutover = activation.activate(async () => { committed = true; });
  await assert.rejects(activation.legacy(async () => undefined), /disabled/);
  await Promise.resolve();
  assert.equal(committed, false);
  settle(); await work; await cutover;
  assert.equal(committed, true);
});
test('backup preserves exact bytes, migration is idempotent and legacy writes are rejected', async t => {
  const { file, repository } = fixture(t);
  const original = fs.readFileSync(file, 'utf8');
  await repository.activate();
  assert.equal(JSON.parse(fs.readFileSync(`${file}.v1-backup`, 'utf8')).original, original);
  const committed = fs.readFileSync(file, 'utf8');
  await repository.activate();
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
  const store = new TeamChatStore(repository);
  assert.equal(store.list('p').length, 1);
  await assert.rejects(store.saveMessages('old', []), /replacement/);
  await store.rename('old', 'Renamed');
  assert.equal(new TeamChatStore(new FileTeamChatRepository(file)).get('old')?.title, 'Renamed');
});
test('backup failure or mismatched interrupted backup never replaces source', async t => {
  const { file, repository } = fixture(t);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.v1-backup`, 'incomplete');
  await assert.rejects(repository.activate(), /backup/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('queued attachments retain bytes after composer mutation and reject cross-conversation ownership', async t => {
  const { file } = fixture(t);
  const attachments = new TeamChatAttachments(path.join(path.dirname(file), 'attachments'));
  const images = [{ mimeType: 'image/png', dataBase64: Buffer.from('original bytes').toString('base64') }];
  const refs = await attachments.stage('one', images);
  images[0].dataBase64 = Buffer.from('edited').toString('base64');
  const restarted = new TeamChatAttachments(path.join(path.dirname(file), 'attachments'));
  assert.equal(Buffer.from((await restarted.resolve('one', refs))[0].dataBase64, 'base64').toString(), 'original bytes');
  await assert.rejects(restarted.resolve('two', refs));
  await assert.rejects(restarted.resolve('one', [{ ...refs[0], size: 1 }]), /integrity/);
  await assert.rejects(attachments.stage('one', [{ mimeType: 'text/plain', dataBase64: 'eA==' }]), /media/);
});

test('restoration is allowed only before durable acceptance', async t => {
  const { file, repository } = fixture(t);
  const original = fs.readFileSync(file, 'utf8');
  await repository.activate();
  await repository.restoreBeforeAcceptance();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await repository.activate();
  await repository.transaction(draft => { draft.activation!.acceptedNewTurns = true; });
  await assert.rejects(repository.restoreBeforeAcceptance(), /forward repair/);
  assert.equal(repository.read().activation?.acceptedNewTurns, true);
});

test('interrupted activation reuses a validated backup and uncertain commit requires reconciliation', async t => {
  const { file, repository } = fixture(t);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.v1-backup`, JSON.stringify({ version: 1, original }));
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('interrupted before replacement'); });
  await assert.rejects(repository.activate(), /interrupted/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  rename.mock.restore();
  await repository.activate();
  assert.equal(repository.read().conversations[0].id, 'old');
  assert.equal(repository.read().teamChats.length, 0);
});

test('disabled activation never commits or fences unrelated legacy work', async () => {
  const activation = new TeamChatActivation(false);
  let committed = false;
  await assert.rejects(activation.activate(async () => { committed = true; }), /disabled/);
  assert.equal(committed, false);
  assert.equal(await activation.legacy(async () => 'legacy'), 'legacy');
});

test('a failed commit lifts the fence so legacy work resumes and activation can retry', async () => {
  const activation = new TeamChatActivation();
  await assert.rejects(activation.activate(async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(await activation.legacy(async () => 'legacy'), 'legacy');
  let committed = false;
  await activation.activate(async () => { committed = true; });
  assert.equal(committed, true);
  await assert.rejects(activation.legacy(async () => undefined), /disabled/);
});
