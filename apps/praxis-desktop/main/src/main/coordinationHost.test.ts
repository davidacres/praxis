import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { COORDINATION_FILE, ResilientCoordination, joinCoordination } from './coordinationHost';

const HOST = path.join(__dirname, 'coordinationHost.js');

/** A separate OS process that joins the broker and runs commands sent to it as JSON lines. */
function contender(root: string): { child: ChildProcess; run: (command: unknown) => Promise<any>; role: Promise<string> } {
  const script = `
    const { ResilientCoordination } = require(${JSON.stringify(HOST)});
    const coordination = new ResilientCoordination(${JSON.stringify(root)});
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const { id, command } = JSON.parse(line);
        const result = command === 'role' ? (await coordination.snapshot(), coordination.role) : await coordination.send(command);
        process.stdout.write(JSON.stringify({ id, result }) + '\\n');
      }
    });`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  let next = 1;
  const pending = new Map<number, (value: unknown) => void>();
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', chunk => {
    out += chunk;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      const { id, result } = JSON.parse(line);
      pending.get(id)?.(result);
      pending.delete(id);
    }
  });
  const run = (command: unknown) => new Promise<any>(resolve => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ id, command })}\n`);
  });
  return { child, run, role: run('role') };
}

const file = (p: string) => ({ resource: { kind: 'file', worktree: '/repo', path: p }, mode: 'exclusive' });
const register = (sessionKey: string) => ({ kind: 'register', session: { sessionKey, runtime: 'gateway', coverage: 'enforced' } });
const acquire = (sessionKey: string, requestId: string, p: string) => ({ kind: 'acquire', requestId, owner: { sessionKey }, items: [file(p)], reason: `edit ${p}`, lifetime: 'tool', wait: false });

function tempRoot(): string {
  // Short path: a Unix socket path must stay under ~100 characters.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
}

test('two processes share one broker: exactly one of them gets the file', async () => {
  const root = tempRoot();
  const a = contender(root);
  const b = contender(root);
  try {
    const roles = [await a.role, await b.role].sort();
    assert.deepEqual(roles, ['follower', 'leader']);
    await a.run(register('A'));
    await b.run(register('B'));
    const [ra, rb] = await Promise.all([a.run(acquire('A', 'a1', 'src/x.ts')), b.run(acquire('B', 'b1', 'src/x.ts'))]);
    const statuses = [ra.acquire?.status, rb.acquire?.status].sort();
    assert.deepEqual(statuses, ['blocked', 'granted'], JSON.stringify([ra, rb]));
    // Persisted before answering: the file on disk holds the grant.
    const saved = JSON.parse(fs.readFileSync(path.join(root, COORDINATION_FILE), 'utf8'));
    assert.equal(saved.claims.length, 1);
  } finally {
    a.child.kill();
    b.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('when the leader is killed, a follower takes over and the dead leader\'s work is held for recovery', async () => {
  const root = tempRoot();
  const a = contender(root);
  assert.equal(await a.role, 'leader');
  const b = contender(root);
  try {
    assert.equal(await b.role, 'follower');
    await a.run(register('A'));
    await b.run(register('B'));
    assert.equal((await a.run(acquire('A', 'a1', 'src/x.ts'))).acquire.status, 'granted');
    a.child.kill('SIGKILL');
    await new Promise(resolve => a.child.once('exit', resolve));

    // B's next request rejoins: it becomes the leader, and A's executing claim is not handed over.
    const result = await b.run(acquire('B', 'b1', 'src/x.ts'));
    assert.equal(await b.run('role'), 'leader');
    assert.equal(result.acquire.status, 'blocked');
    assert.equal(result.acquire.blockers[0].state, 'recovery-required');
    assert.equal((await b.run({ kind: 'recover', claimId: 'a1#0', actor: 'test', note: 'process killed' })).ok, true);
    assert.equal((await b.run(acquire('B', 'b2', 'src/x.ts'))).acquire.status, 'granted');
  } finally {
    a.child.kill();
    b.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live lock is never taken over, however it looks', async () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    // A lock owned by this (alive) process, with no broker listening.
    fs.writeFileSync(path.join(root, 'broker.lock'), JSON.stringify({ pid: process.pid, epoch: 'x', at: '2000-01-01T00:00:00.000Z' }));
    await assert.rejects(() => joinCoordination(root), /holds it but does not answer/);
    assert.ok(fs.existsSync(path.join(root, 'broker.lock')), 'the lock was left alone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unreadable state blocks grants until it is reset, and keeps a copy', async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, COORDINATION_FILE), '{"schemaVersion": 1, "claims": [tru');
    const coordination = new ResilientCoordination(root);
    await coordination.send(register('A') as never);
    const refused = await coordination.send(acquire('A', 'a1', 'x.ts') as never);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.error, /could not be read.*No resources are granted until it is reset/);
    assert.ok(fs.readdirSync(root).some(name => name.startsWith(`${COORDINATION_FILE}.unreadable-`)));
    coordination.reset();
    await coordination.send(register('A') as never);
    const granted = await coordination.send(acquire('A', 'a2', 'x.ts') as never);
    assert.equal(granted.ok && granted.acquire?.status, 'granted');
    await coordination.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a request without the user\'s token is refused', async () => {
  const root = tempRoot();
  const leader = await joinCoordination(root);
  try {
    const socket = path.join(root, 'broker.sock');
    const reply = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(socket, () => client.write(`${JSON.stringify({ id: 1, token: 'wrong', op: 'send', command: register('X') })}\n`));
      client.setEncoding('utf8');
      client.on('data', data => {
        resolve(String(data));
        client.end();
      });
      client.on('error', reject);
    });
    assert.match(reply, /Not authorised/);
    assert.equal(fs.statSync(path.join(root, 'broker.token')).mode & 0o077, 0, 'the token is readable by its owner only');
  } finally {
    await leader.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
