import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCliProvider, type CliSpawn } from './providerPreflight';

class FakeChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

function spawnFixture(
  emit: (child: FakeChild) => void
): CliSpawn {
  return (_command, _args, _options) => {
    const child = new FakeChild();
    queueMicrotask(() => emit(child));
    return child as never;
  };
}

test('marks a missing CLI as unavailable', async () => {
  const result = await probeCliProvider('missing', spawnFixture(child => {
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  }));

  assert.deepEqual(result, { status: 'unavailable', message: 'not found' });
});

test('distinguishes denied and failed CLI preflight results', async () => {
  const denied = await probeCliProvider('denied', spawnFixture(child => {
    child.stderr.emit('data', Buffer.from('Login required before using this CLI.'));
    child.emit('close', 1);
  }));
  const failed = await probeCliProvider('broken', spawnFixture(child => {
    child.stderr.emit('data', Buffer.from('unexpected startup error'));
    child.emit('close', 1);
  }));

  assert.equal(denied.status, 'denied');
  assert.equal(failed.status, 'failed');
});

test('reports a ready CLI even when its version output has no parseable version', async () => {
  const ready = await probeCliProvider('ready', spawnFixture(child => {
    child.stdout.emit('data', Buffer.from('CLI development build'));
    child.emit('close', 0);
  }));
  const versioned = await probeCliProvider('versioned', spawnFixture(child => {
    child.stdout.emit('data', Buffer.from('Provider CLI v1.2.3'));
    child.emit('close', 0);
  }));

  assert.deepEqual(ready, { status: 'ready', message: 'CLI development build' });
  assert.deepEqual(versioned, {
    status: 'ready',
    message: 'Provider CLI v1.2.3',
    providerVersion: '1.2.3'
  });
});
