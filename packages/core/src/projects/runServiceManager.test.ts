import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunServiceManager, type RunLogLine, type RunServiceStatus } from './runServiceManager';
import { RUN_PROFILE_SCHEMA_VERSION, type RunProfile, type RunServiceDefinition } from './runProfile';

function profile(services: RunServiceDefinition[]): RunProfile {
  const at = '2026-09-09T00:00:00.000Z';
  return { schemaVersion: RUN_PROFILE_SCHEMA_VERSION, id: 'p', name: 'p', services, createdAt: at, updatedAt: at };
}

/** A service whose executable is `node -e <script>` — deterministic and needs nothing installed. */
function nodeService(id: string, script: string, overrides: Partial<RunServiceDefinition> = {}): RunServiceDefinition {
  return { id, name: id, executable: process.execPath, args: ['-e', script], ...overrides };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

function waitForState(manager: RunServiceManager, id: string, states: RunServiceStatus['state'][]): Promise<RunServiceStatus> {
  return new Promise(resolve => {
    const check = (): RunServiceStatus | undefined => manager.status().find(status => status.id === id && states.includes(status.state));
    const existing = check();
    if (existing) {
      resolve(existing);
      return;
    }
    const listener = (status: RunServiceStatus): void => {
      if (status.id === id && states.includes(status.state)) {
        manager.off('status', listener);
        resolve(status);
      }
    };
    manager.on('status', listener);
  });
}

test('a service with no readiness probe becomes ready once it settles, and stop() tears it down', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);')]), { projectFolder: dir });
    const status = manager.status();
    assert.equal(status.length, 1);
    assert.equal(status[0].state, 'ready');
    assert.ok(status[0].pid);

    await manager.stop();
    assert.equal(manager.status()[0].state, 'stopped');
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a log-line readiness probe is satisfied by matching stdout', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const logs: RunLogLine[] = [];
  manager.on('log', line => logs.push(line));
  try {
    await manager.start(
      profile([nodeService('api', "console.log('booting'); setTimeout(() => console.log('Server ready on 3000'), 50); setInterval(() => {}, 1000);", { readinessProbe: { kind: 'log-line', match: 'Server ready' } })]),
      { projectFolder: dir }
    );
    assert.equal(manager.status()[0].state, 'ready');
    assert.ok(logs.some(line => line.text.includes('Server ready on 3000')));
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tcp readiness probe is satisfied once the service binds its port', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const port = await freePort();
  try {
    const script = `const net = require('net'); setTimeout(() => { net.createServer().listen(${port}, '127.0.0.1'); }, 100);`;
    await manager.start(profile([nodeService('api', script, { port, readinessProbe: { kind: 'tcp', port } })]), { projectFolder: dir });
    assert.equal(manager.status()[0].state, 'ready');
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an http readiness probe checks the declared path and expected status', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const port = await freePort();
  try {
    const script = `
      const http = require('http');
      setTimeout(() => {
        http.createServer((req, res) => {
          if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
          else { res.writeHead(404); res.end(); }
        }).listen(${port}, '127.0.0.1');
      }, 100);
    `;
    await manager.start(
      profile([nodeService('api', script, { port, readinessProbe: { kind: 'http', path: '/healthz', expectedStatus: 200 } })]),
      { projectFolder: dir }
    );
    assert.equal(manager.status()[0].state, 'ready');
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an http probe with no declared port fails before anything is spawned', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(
      profile([nodeService('api', 'setInterval(() => {}, 1000);', { readinessProbe: { kind: 'http', path: '/healthz' } })]),
      { projectFolder: dir }
    );
    const status = manager.status()[0];
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /requires the service to declare a port/);
    assert.equal(status.pid, undefined);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('port collision: a port already held by something else fails the service without spawning it', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const port = await freePort();
  const holder = net.createServer();
  await new Promise<void>(resolve => holder.listen(port, '127.0.0.1', resolve));
  try {
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);', { port })]), { projectFolder: dir });
    const status = manager.status()[0];
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /already in use/);
    assert.equal(status.pid, undefined, 'the service should never have been spawned');
  } finally {
    await manager.stop();
    await new Promise<void>(resolve => holder.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('early exit: a service that exits before becoming ready is marked failed, not ready', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(profile([nodeService('api', 'process.exit(3);')]), { projectFolder: dir });
    const status = manager.status()[0];
    assert.equal(status.state, 'failed');
    assert.equal(status.exitCode, 3);
    assert.match(status.error ?? '', /exited before it became ready/);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed dependency: a service is never spawned once something it depends on fails', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(
      profile([
        nodeService('db', 'process.exit(1);'),
        { ...nodeService('api', 'setInterval(() => {}, 1000);'), dependsOn: ['db'] }
      ]),
      { projectFolder: dir }
    );
    const statuses = manager.status();
    const db = statuses.find(status => status.id === 'db')!;
    const api = statuses.find(status => status.id === 'api')!;
    assert.equal(db.state, 'failed');
    assert.equal(api.state, 'failed');
    assert.match(api.error ?? '', /Dependency "db" failed to become ready/);
    assert.equal(api.pid, undefined, 'a service should never spawn once its dependency has failed');
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('dependency order: a dependent service does not start until its dependency is ready', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const events: string[] = [];
  manager.on('status', status => {
    if (status.state === 'ready' || status.state === 'starting') events.push(`${status.id}:${status.state}`);
  });
  try {
    await manager.start(
      profile([
        nodeService('db', "setTimeout(() => console.log('db ready'), 150); setInterval(() => {}, 1000);", { readinessProbe: { kind: 'log-line', match: 'db ready' } }),
        { ...nodeService('api', 'setInterval(() => {}, 1000);'), dependsOn: ['db'] }
      ]),
      { projectFolder: dir }
    );
    assert.equal(manager.status().find(status => status.id === 'db')?.state, 'ready');
    assert.equal(manager.status().find(status => status.id === 'api')?.state, 'ready');
    assert.deepEqual(events, ['db:starting', 'db:ready', 'api:starting', 'api:ready']);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('timeout: a service whose probe is never satisfied is failed and killed once its readiness timeout elapses', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const port = await freePort(); // never bound by the script — the probe can never succeed
  try {
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);', { readinessProbe: { kind: 'tcp', port } })]), {
      projectFolder: dir,
      readinessTimeoutMs: 300
    });
    const status = manager.status()[0];
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /Readiness timed out/);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated stop is a safe no-op, not a re-kill or an error', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);')]), { projectFolder: dir });
    await manager.stop();
    assert.equal(manager.status()[0].state, 'stopped');
    await manager.stop();
    await manager.stop();
    assert.equal(manager.status()[0].state, 'stopped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopping a managed service does not touch an unrelated process this instance never spawned', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  try {
    await new Promise<void>(resolve => bystander.once('spawn', () => resolve()));
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);')]), { projectFolder: dir });
    await manager.stop();
    assert.equal(bystander.exitCode, null, 'the bystander process should still be running');
    assert.equal(bystander.killed, false);
  } finally {
    bystander.kill();
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a service that exits unexpectedly after becoming ready is marked failed', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(profile([nodeService('api', "setTimeout(() => process.exit(7), 700); setInterval(() => {}, 1000);")]), { projectFolder: dir });
    assert.equal(manager.status()[0].state, 'ready');
    const failed = await waitForState(manager, 'api', ['failed']);
    assert.equal(failed.exitCode, 7);
    assert.match(failed.error ?? '', /exited unexpectedly/);
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('starting a second run while one is already active is refused', async () => {
  const manager = new RunServiceManager();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-run-'));
  try {
    await manager.start(profile([nodeService('api', 'setInterval(() => {}, 1000);')]), { projectFolder: dir });
    await assert.rejects(
      () => manager.start(profile([nodeService('api2', 'setInterval(() => {}, 1000);')]), { projectFolder: dir }),
      /already active/
    );
  } finally {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid profile is refused before anything is spawned', async () => {
  const manager = new RunServiceManager();
  await assert.rejects(() => manager.start(profile([]), { projectFolder: '/tmp' }), /is invalid/);
  assert.deepEqual(manager.status(), []);
});
