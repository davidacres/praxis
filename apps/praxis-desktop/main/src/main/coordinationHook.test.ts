import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinCoordination } from './coordinationHost';

const HOOK = path.join(__dirname, 'coordinationHook.js');

/** Runs the hook as Claude Code would: a separate process, payload on stdin. Async, so an in-process broker can answer it. */
function runHook(root: string, payload: unknown, raw?: string, args: string[] = [], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, PRAXIS_COORDINATION_ROOT: root, ...env } });
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

    // A subagent stopping does not end the parent's turn: its claims stay.
    await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't3', tool_input: { file_path: 'mid.ts' } });
    await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'SubagentStop' });
    state = (await broker.snapshot()) as typeof state;
    assert.ok(state.claims.some(claim => claim.owner.sessionKey === 'claude:s1' && claim.resource.path === 'mid.ts'), 'the parent\'s edit is still claimed');
    await runHook(root, { session_id: 's1', cwd: repo, hook_event_name: 'Stop' });
    state = (await broker.snapshot()) as typeof state;
    assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'claude:s1'), false, 'the session\'s own Stop releases it');

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

function gitRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

test('Codex, Copilot and Gemini payloads are each claimed and denied in that runtime\'s own format', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const repo = gitRepo();
  const broker = await joinCoordination(root);
  try {
    await broker.send({ kind: 'register', session: { sessionKey: 'HOLDER', runtime: 'gateway', coverage: 'enforced' } });
    await broker.send({ kind: 'acquire', requestId: 'h', owner: { sessionKey: 'HOLDER' }, items: [{ resource: { kind: 'file', worktree: repo, path: 'busy.txt' }, mode: 'exclusive' }], reason: 'rewriting busy.txt', lifetime: 'sequence', wait: false });

    // Codex: the payload it really sent (captured from codex-cli 0.159.3), patch headers name the files.
    const patch = '*** Begin Patch\n*** Delete File: busy.txt\n*** Add File: busy.txt\n+CHANGED\n*** End Patch';
    const codex = await runHook(root, { session_id: 'c1', turn_id: 't', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, tool_use_id: 'exec-1' }, undefined, ['--runtime', 'codex']);
    const codexDecision = JSON.parse(codex.stdout).hookSpecificOutput;
    assert.equal(codexDecision.permissionDecision, 'deny');
    assert.match(codexDecision.permissionDecisionReason, /file busy\.txt is held by HOLDER \(rewriting busy\.txt\)/);
    // A patch touching free files is granted all or none, and released after.
    const free = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Update File: b.ts\n*** Move to: c.ts\n*** End Patch';
    assert.equal((await runHook(root, { session_id: 'c1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: free }, tool_use_id: 'exec-2' }, undefined, ['--runtime', 'codex'])).stdout, '');
    let state = (await broker.snapshot()) as { claims: Array<{ owner: { sessionKey: string }; resource: { path?: string } }> };
    assert.deepEqual(state.claims.filter(claim => claim.owner.sessionKey === 'codex:c1').map(claim => claim.resource.path).sort(), ['a.ts', 'b.ts', 'c.ts']);
    await runHook(root, { session_id: 'c1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: free }, tool_use_id: 'exec-2' }, undefined, ['--runtime', 'codex']);
    state = (await broker.snapshot()) as typeof state;
    assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'codex:c1'), false);

    // Copilot: no event name in the payload (the command says which), arguments as a JSON string.
    const copilot = await runHook(root, { sessionId: 'p1', timestamp: 1, cwd: repo, toolName: 'edit', toolArgs: JSON.stringify({ path: path.join(repo, 'busy.txt'), old_str: 'a', new_str: 'b' }) }, undefined, ['--runtime', 'copilot', '--event', 'pre']);
    assert.deepEqual(Object.keys(JSON.parse(copilot.stdout)).sort(), ['permissionDecision', 'permissionDecisionReason']);
    assert.equal(JSON.parse(copilot.stdout).permissionDecision, 'deny');
    assert.equal((await runHook(root, { sessionId: 'p1', cwd: repo, toolName: 'bash', toolArgs: { command: 'echo > busy.txt' } }, undefined, ['--runtime', 'copilot', '--event', 'pre'])).stdout, '', 'shell is not claimed');

    // Gemini: BeforeTool, `decision: deny`.
    const gemini = await runHook(root, { session_id: 'g1', cwd: repo, hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: 'busy.txt', content: 'x' } }, undefined, ['--runtime', 'gemini']);
    assert.equal(JSON.parse(gemini.stdout).decision, 'deny');
    assert.match(JSON.parse(gemini.stdout).reason, /held by HOLDER/);
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/** A process that holds the broker's socket and token but misbehaves: never answers, or dies mid-request. */
async function brokenBroker(root: string, behaviour: 'silent' | 'crash'): Promise<net.Server> {
  fs.writeFileSync(path.join(root, 'broker.token'), 'token', { mode: 0o600 });
  const server = net.createServer(socket => {
    socket.on('data', () => {
      if (behaviour === 'crash') socket.destroy();
    });
  });
  await new Promise<void>(resolve => server.listen(path.join(root, 'broker.sock'), () => resolve()));
  return server;
}

test('a broker that hangs or dies mid-request does not let an edit through; the hook says why', async () => {
  const repo = gitRepo();
  const payload = { session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't', tool_input: { file_path: 'x.ts' } };
  for (const behaviour of ['silent', 'crash'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
    const server = await brokenBroker(root, behaviour);
    try {
      const started = Date.now();
      const result = await runHook(root, payload, undefined, [], { PRAXIS_HOOK_TIMEOUT_MS: '1500' });
      assert.equal(result.status, 0);
      const decision = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(decision.permissionDecision, 'deny', `${behaviour}: refused`);
      if (behaviour === 'silent') {
        assert.match(result.stderr, /did not answer within 2 s; refusing the edit/);
        assert.ok(Date.now() - started < 6000, 'promptly, not at the agent\'s own hook timeout');
      } else {
        assert.match(decision.permissionDecisionReason, /could not grant this edit: .*nothing was granted/);
        assert.doesNotMatch(decision.permissionDecisionReason, /Another session/);
      }
      // Not an edit: nothing to refuse.
      const read = await runHook(root, { ...payload, tool_name: 'Read' }, undefined, [], { PRAXIS_HOOK_TIMEOUT_MS: '1500' });
      assert.equal(read.stdout, '');
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  fs.rmSync(repo, { recursive: true, force: true });
});
