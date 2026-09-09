import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDirectProcessDeployment, type DirectProcessDeploymentInput } from './directProcessExecutor';

/** A node fixture script, run via `process.execPath -e <script>` — deterministic, needs nothing installed. */
function nodeInput(script: string, overrides: Partial<DirectProcessDeploymentInput> = {}): DirectProcessDeploymentInput {
  return {
    operationId: 'op-1',
    executable: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    ...overrides
  };
}

test('a script that exits 0 produces a typed successful result', async () => {
  const result = await runDirectProcessDeployment(nodeInput('process.stdout.write("hello"); process.exit(0);'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.output, 'hello');
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.error, undefined);
  assert.ok(result.pid, 'a successfully spawned process has a pid');
});

test('a script that exits non-zero is reported as a typed result, not thrown', async () => {
  const result = await runDirectProcessDeployment(nodeInput('process.exit(7);'));
  assert.equal(result.exitCode, 7);
  assert.equal(result.error, undefined, 'a non-zero exit is not itself an "error" — the caller reads exitCode');
});

// ── Typed inputs are data, never command-string interpolation ────────────

test('an input value containing shell metacharacters passes through byte-identical, never interpreted', async () => {
  const dangerous = `/tmp/my dir; rm -rf / && echo pwned $(whoami) \`echo x\` "quo'ted"`;
  const result = await runDirectProcessDeployment(
    nodeInput('process.stdout.write(process.env.PRAXIS_DEPLOY_ARTIFACT_PATH || "");', {
      inputs: { ARTIFACT_PATH: dangerous }
    })
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, dangerous, 'the value arrived exactly as given — nothing shell-parsed it');
});

test('multiple typed inputs each surface under their own PRAXIS_DEPLOY_ prefixed variable', async () => {
  const result = await runDirectProcessDeployment(
    nodeInput(
      'process.stdout.write(JSON.stringify({ a: process.env.PRAXIS_DEPLOY_ARTIFACT_PATH, t: process.env.PRAXIS_DEPLOY_TARGET_PATH }));',
      { inputs: { ARTIFACT_PATH: '/artifacts/a.zip', TARGET_PATH: '/var/www/site' } }
    )
  );
  assert.deepEqual(JSON.parse(result.output), { a: '/artifacts/a.zip', t: '/var/www/site' });
});

test('a path with spaces used as cwd is honored exactly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis deploy '));
  try {
    const result = await runDirectProcessDeployment(
      nodeInput('process.stdout.write(process.cwd());', { cwd: dir })
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Startup failure preserves logs and operation identity ────────────────

test('a nonexistent executable is a typed startup failure, not a thrown error, and still carries the operation id', async () => {
  const result = await runDirectProcessDeployment(
    nodeInput('', { executable: path.join(os.tmpdir(), 'praxis-does-not-exist-xyz'), args: [] })
  );
  assert.equal(result.exitCode, null);
  assert.equal(result.operationId, 'op-1');
  assert.match(result.error ?? '', /Could not start/);
  assert.equal(result.output, '');
});

// ── Timeout preserves logs and operation identity ─────────────────────────

test('a timeout kills the process, records timedOut, and preserves whatever output was captured', async () => {
  const result = await runDirectProcessDeployment(
    nodeInput('process.stdout.write("partial-output"); setInterval(() => {}, 1000);', { timeoutMs: 200 })
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.output, 'partial-output');
  assert.match(result.error ?? '', /timed out/);
});

test('the timed-out process is actually killed, not merely reported as such', async () => {
  const pids: number[] = [];
  const result = await runDirectProcessDeployment(
    nodeInput('process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);', { timeoutMs: 200 })
  );
  pids.push(Number(result.output));
  // process.kill(pid, 0) throws ESRCH once the process is actually gone.
  assert.throws(() => process.kill(pids[0], 0));
});

// ── Cancellation ───────────────────────────────────────────────────────────

test('an already-aborted signal cancels before ever spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runDirectProcessDeployment(nodeInput('process.exit(0);', { signal: controller.signal }));
  assert.equal(result.cancelled, true);
  assert.equal(result.pid, undefined);
  assert.equal(result.operationId, 'op-1');
});

test('aborting mid-run cancels the deployment and kills the process', async () => {
  const controller = new AbortController();
  const promise = runDirectProcessDeployment(
    nodeInput('setInterval(() => {}, 1000);', { signal: controller.signal })
  );
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});

// ── Bounded output ─────────────────────────────────────────────────────────

test('output beyond the retained bound is truncated, not unbounded', async () => {
  const result = await runDirectProcessDeployment(
    nodeInput('process.stdout.write("x".repeat(300_000)); process.exit(0);')
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.length <= 200_000, `expected output capped at 200000 bytes, got ${result.output.length}`);
});
