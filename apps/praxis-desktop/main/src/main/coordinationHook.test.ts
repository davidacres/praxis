import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinCoordination } from './coordinationHost';

const HOOK = path.join(__dirname, 'coordinationHook.js');

/** Runs the hook as Claude Code would: a separate process, payload on stdin. Async, so an in-process broker can answer it. */
function runHook(root: string, payload: unknown, raw?: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, PRAXIS_COORDINATION_ROOT: root } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => resolve({ stdout, stderr, status }));
    child.stdin.end(raw ?? JSON.stringify(payload));
  });
}

test('the Claude Code hook denies an edit another session holds, before it happens, and releases its own', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const broker = await joinCoordination(root);
  try {
    await broker.send({ kind: 'register', session: { sessionKey: 'SESSION-B', runtime: 'gateway', coverage: 'enforced' } });
    const held = await broker.send({ kind: 'acquire', requestId: 'b1', owner: { sessionKey: 'SESSION-B' }, items: [{ resource: { kind: 'file', worktree: repo, path: 'busy.ts' }, mode: 'exclusive' }], reason: 'refactoring busy.ts', lifetime: 'sequence', wait: false });
    assert.equal(held.ok && held.acquire?.status, 'granted');

    const denied = await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: path.join(repo, 'busy.ts') } });
    assert.equal(denied.status, 0);
    const decision = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /file busy\.ts is held by SESSION-B \(refactoring busy\.ts\)/);

    const allowed = await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: 'free.ts' } });
    assert.equal(allowed.stdout, '', 'no output: the tool proceeds');
    let state = (await broker.snapshot()) as { claims: Array<{ owner: { sessionKey: string }; resource: { path?: string } }> };
    assert.ok(state.claims.some(claim => claim.owner.sessionKey === 'claude:s1' && claim.resource.path === 'free.ts'));

    await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: 'free.ts' } });
    state = (await broker.snapshot()) as typeof state;
    assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'claude:s1'), false, 'released after the tool');

    const bash = await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    assert.equal(bash.stdout, '', 'shell commands are not claimed by the hook: cooperative coverage');
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('with no broker running the hook allows the tool and says why; a malformed payload too', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  try {
    const result = await runHook(root, { session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x' } });
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no coordination broker is running.*allowing/);
    assert.ok(!fs.existsSync(path.join(root, 'broker.lock')), 'a hook never becomes the broker');
    const malformed = await runHook(root, undefined, '{nope');
    assert.equal(malformed.status, 0);
    assert.match(malformed.stderr, /unreadable payload; allowing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
