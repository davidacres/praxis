import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSessionRecord } from '@praxis/core';
import { takeContextSnapshot } from './contextSnapshotHost';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('a snapshot of a real repository records HEAD, touched and changed files, leaves secrets out, and is persisted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-snapshot-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/pay.ts'), 'export const pay = 1;\n');
    git(repo, 'init', '-q', '--initial-branch=main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
    const head = git(repo, 'rev-parse', 'HEAD');
    // Uncommitted work: an edited file, a new one, and a secrets file.
    fs.writeFileSync(path.join(repo, 'src/pay.ts'), 'export const pay = 2;\n');
    fs.writeFileSync(path.join(repo, 'src/card.ts'), 'export const card = true;\n');
    fs.writeFileSync(path.join(repo, '.env'), 'STRIPE_KEY=sk_live_x\n');

    const store = path.join(root, 'store');
    const record = {
      issueKey: 'PAY-12',
      workingDirectory: repo,
      handoverBrief: { touchedFiles: ['src/pay.ts'] },
      taskDefinition: { goal: 'Pay', scope: '', definitionOfDone: '', ticketContext: 'Depends on PAY-7' }
    } as unknown as AgentSessionRecord;
    const { snapshot, manifest, head: current } = await takeContextSnapshot(record, store, '2026-10-08T20:00:00.000Z');

    assert.equal(snapshot.sourceCommit, head);
    assert.equal(current, head);
    assert.equal(snapshot.branch, 'main');
    assert.equal(snapshot.dirty, true);
    assert.deepEqual(snapshot.includedFiles.map(file => `${file.path}:${file.reason}`), ['src/pay.ts:touched', 'src/card.ts:changed']);
    assert.deepEqual(snapshot.excludedFiles, [{ path: '.env', reason: 'secret' }]);
    assert.deepEqual(snapshot.dependencies, ['PAY-7']);
    assert.ok(manifest && fs.existsSync(manifest.path), 'the snapshot is persisted');
    assert.equal(JSON.parse(fs.readFileSync(manifest!.path, 'utf8')).fingerprint, snapshot.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
