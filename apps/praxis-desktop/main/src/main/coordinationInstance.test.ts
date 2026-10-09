import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoordinationState } from '@praxis/core';

// This process's broker lives in a temp root, never the developer's own.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-'));
process.env.PRAXIS_COORDINATION_ROOT = root;
process.env.PRAXIS_PERSON_IDLE_MS = '400';

// Loaded after the environment is set: the instance reads it on first use.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const instance = require('./coordinationInstance') as typeof import('./coordinationInstance');

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pci-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'a');
  git('add', '.');
  git('commit', '-qm', 'seed');
  return dir;
}

const file = (worktree: string, at: string) => ({ resource: { kind: 'file' as const, worktree, path: at }, mode: 'exclusive' as const });
const state = async () => (await instance.getCoordination().snapshot()) as CoordinationState;

test.after(async () => {
  await instance.disposeCoordination();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bounded wait is granted, in turn, as soon as the holder releases — a fresh grant, held until the turn ends', async () => {
  const dir = repo();
  const holder = instance.coordinationGateFor('HOLDER', dir, 'enforced')!;
  const waiter = instance.coordinationGateFor('WAITER', dir, 'enforced')!;
  const held = await holder.acquire({ items: [file(dir, 'a.ts')], reason: 'refactoring a.ts', lifetime: 'sequence' });
  assert.equal(held.ok, true);
  const refused = await waiter.acquire({ items: [file(dir, 'a.ts')], reason: 'edit' });
  assert.equal(refused.ok, false);

  const started = Date.now();
  const waiting = waiter.wait!({ items: [file(dir, 'a.ts')], reason: 'edit a.ts', timeoutMs: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await state()).waiters.length, 1, 'queued at the broker while it waits');
  if (held.ok) await held.release();
  const granted = await waiting;
  assert.equal(granted.ok, true);
  assert.ok(Date.now() - started < 3000, 'woken promptly by the release');
  const mine = (await state()).claims.filter(claim => claim.owner.sessionKey === 'WAITER');
  assert.deepEqual(mine.map(claim => [claim.state, claim.lifetime]), [['executing', 'sequence']], 'started at once: not left as a reservation to lapse');
  // The waiter's own write proceeds; its turn ending releases what it waited for.
  assert.equal((await waiter.acquire({ items: [file(dir, 'a.ts')], reason: 'write' })).ok, true);
  instance.endCoordinatedTurn('WAITER');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await state()).claims.some(claim => claim.owner.sessionKey === 'WAITER'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a wait that times out, is cancelled, or outlives its turn leaves nothing queued and says what was in the way', async () => {
  const dir = repo();
  const holder = instance.coordinationGateFor('HOLDER2', dir, 'enforced')!;
  const waiter = instance.coordinationGateFor('WAITER2', dir, 'enforced')!;
  const held = await holder.acquire({ items: [file(dir, 'a.ts')], reason: 'long refactor', lifetime: 'sequence' });
  assert.equal(held.ok, true);

  const timedOut = await waiter.wait!({ items: [file(dir, 'a.ts')], reason: 'edit', timeoutMs: 1000 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.ok ? '' : timedOut.reason, /Still busy after 1 s: file a\.ts is held by HOLDER2 \(long refactor\)/);
  assert.equal((await state()).waiters.length, 0, 'the timed-out wait was cancelled at the broker');

  const controller = new AbortController();
  const cancelled = waiter.wait!({ items: [file(dir, 'a.ts')], reason: 'edit', timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const result = await cancelled;
  assert.match(result.ok ? '' : result.reason, /cancelled/);
  assert.equal((await state()).waiters.length, 0);

  const outlived = waiter.wait!({ items: [file(dir, 'a.ts')], reason: 'edit', timeoutMs: 10_000 });
  setTimeout(() => instance.endCoordinatedTurn('WAITER2'), 300);
  const ended = await outlived;
  assert.match(ended.ok ? '' : ended.reason, /turn ended/);
  // Released afterwards, the resource is not handed to the ended turn.
  if (held.ok) await held.release();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await state()).claims.some(claim => claim.owner.sessionKey === 'WAITER2'), false, 'no late grant to a turn that has ended');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write after the checkout moved under the session is refused once, naming the move', async () => {
  const dir = repo();
  const gate = instance.coordinationGateFor('MOVER', dir, 'enforced')!;
  const first = await gate.acquire({ items: [file(dir, 'a.ts')], reason: 'write' });
  assert.equal(first.ok, true);
  if (first.ok) await first.release();

  execFileSync('git', ['checkout', '-q', '-b', 'other'], { cwd: dir });
  const moved = await gate.acquire({ items: [file(dir, 'a.ts')], reason: 'write' });
  assert.equal(moved.ok, false);
  assert.match(moved.ok ? '' : moved.reason, /the checkout switched from main to other since this session last acted here/);
  assert.equal((await state()).sessions.MOVER.branch, 'other', 'others see the branch it is on now');
  const again = await gate.acquire({ items: [file(dir, 'a.ts')], reason: 'write' });
  assert.equal(again.ok, true, 'reported once: the session re-reads and goes on');
  if (again.ok) await again.release();

  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'someone else'], { cwd: dir });
  const commit = await gate.acquire({ items: [file(dir, 'a.ts')], reason: 'write' });
  assert.match(commit.ok ? '' : commit.reason, /other moved from [0-9a-f]{8} to [0-9a-f]{8}/);

  // The session's own command moving HEAD is its new baseline, not a surprise.
  const shell = await gate.acquire({ items: [{ resource: { kind: 'worktree', worktree: dir }, mode: 'exclusive' }], reason: 'commit' });
  assert.equal(shell.ok, true);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'mine'], { cwd: dir });
  if (shell.ok) await shell.release();
  assert.equal((await gate.acquire({ items: [file(dir, 'a.ts')], reason: 'write' })).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a person using the in-app browser takes it from the agent driving it, which is told; it is handed back after they stop', async () => {
  assert.deepEqual(await instance.holdBrowserForSequence('BROWSING-AGENT'), { ok: true });
  await instance.personUsedBrowser();
  await instance.personUsedBrowser();
  const taken = (await state()).events.filter(entry => entry.type === 'taken-over' && entry.toSessionKey === 'BROWSING-AGENT');
  assert.equal(taken.length, 1, 'repeated input is one takeover');
  assert.match(taken[0].text, /out of date/);
  const refused = await instance.holdBrowserForSequence('BROWSING-AGENT');
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /a person is using the in-app browser/);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(await instance.holdBrowserForSequence('BROWSING-AGENT'), { ok: true }, 'handed back once the person left it alone');
});

test('releasing with evidence clears a service claim that went to recovery when its session ended', async () => {
  const dir = repo();
  const gate = instance.coordinationGateFor('SERVICE-OWNER', dir, 'enforced')!;
  const service = await gate.acquire({ items: [{ resource: { kind: 'process', host: os.hostname(), pgid: 424242 }, mode: 'exclusive' }], reason: 'service', lifetime: 'service' });
  assert.equal(service.ok, true);
  instance.endCoordinatedSession('SERVICE-OWNER');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await state()).claims.find(claim => claim.owner.sessionKey === 'SERVICE-OWNER')?.state, 'recovery-required');
  if (service.ok) await service.release('its processes (group 424242) exited');
  const now = await state();
  assert.equal(now.claims.some(claim => claim.owner.sessionKey === 'SERVICE-OWNER'), false);
  assert.match(now.events.find(entry => entry.type === 'recovered')?.text ?? '', /Praxis confirmed processes|Praxis confirmed process group 424242 is free/);
  fs.rmSync(dir, { recursive: true, force: true });
});
