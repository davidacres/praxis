import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinCoordination } from './coordinationHost';

/**
 * Live proof against the installed agent CLIs (TASK-395): an edit tool is denied by the
 * coordination hook *before* the losing write, and the same request succeeds once the file is
 * free. Nothing is written to anyone's global configuration: Claude Code takes its hooks from
 * `--settings <file>`; Codex from the throwaway repository's own `.codex/hooks.json`, with the
 * hook feature and hook trust granted for that one invocation by flag.
 *
 * Run with PRAXIS_LIVE_CLAUDE=1 / PRAXIS_LIVE_CODEX=1; each spends a little usage.
 */

const HOOK = path.join(__dirname, 'coordinationHook.js');
const live = process.env.PRAXIS_LIVE_CLAUDE === '1';
const liveCodex = process.env.PRAXIS_LIVE_CODEX === '1';

function claude(cwd: string, root: string, settings: string, prompt: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn('claude', ['-p', prompt, '--settings', settings, '--permission-mode', 'acceptEdits', '--allowedTools', 'Write,Edit,Read', '--disallowedTools', 'Bash', '--output-format', 'text'], {
      cwd,
      env: { ...process.env, PRAXIS_COORDINATION_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (out += chunk));
    child.on('close', () => resolve(out));
  });
}

test('Claude Code: an edit another session holds is denied before it happens', { skip: !live && 'set PRAXIS_LIVE_CLAUDE=1', timeout: 300_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'busy.txt'), 'original\n');
  const hook = { type: 'command', command: `"${process.execPath}" "${HOOK}"`, timeout: 15 };
  const settings = path.join(root, 'claude-settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [hook] }],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [hook] }],
      Stop: [{ hooks: [hook] }]
    }
  }));
  const broker = await joinCoordination(root);
  try {
    await broker.send({ kind: 'register', session: { sessionKey: 'SESSION-B', runtime: 'gateway', coverage: 'enforced' } });
    await broker.send({ kind: 'acquire', requestId: 'b1', owner: { sessionKey: 'SESSION-B' }, items: [{ resource: { kind: 'file', worktree: repo, path: 'busy.txt' }, mode: 'exclusive' }], reason: 'rewriting busy.txt', lifetime: 'sequence', wait: false });

    const prompt = 'Use the Write tool exactly once to replace the whole contents of busy.txt with the single line CHANGED. If the tool is denied, do not try any other way; just report the reason you were given.';
    const refused = await claude(repo, root, settings, prompt);
    assert.equal(fs.readFileSync(path.join(repo, 'busy.txt'), 'utf8'), 'original\n', `the losing write never happened. Claude said: ${refused}`);
    assert.match(refused, /SESSION-B|another session|coordination|held/i, refused);

    // Control: the same request once the file is free.
    await broker.send({ kind: 'release', owner: { sessionKey: 'SESSION-B' }, requestId: 'b1' });
    const done = await claude(repo, root, settings, prompt);
    assert.match(fs.readFileSync(path.join(repo, 'busy.txt'), 'utf8'), /CHANGED/, done);
    const state = (await broker.snapshot()) as { claims: unknown[]; events: Array<{ type: string; sessionKey?: string }> };
    assert.equal(state.claims.length, 0, 'the hook released after the tool and at Stop');
    assert.ok(state.events.some(event => event.type === 'resource-acquired' && event.sessionKey?.startsWith('claude:')), 'the granted write went through the broker');
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Claude Code: a hook that crashes does not block the edit — why a hook route is only ever cooperative', { skip: !live && 'set PRAXIS_LIVE_CLAUDE=1', timeout: 300_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'busy.txt'), 'original\n');
  // The hook process dies before it can answer (as an out-of-memory kill or a bad install would).
  const crash = { type: 'command', command: `"${process.execPath}" -e "process.kill(process.pid, 'SIGKILL')"`, timeout: 15 };
  const settings = path.join(root, 'claude-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [crash] }] } }));
  try {
    const said = await claude(repo, root, settings, 'Use the Write tool exactly once to replace the whole contents of busy.txt with the single line CHANGED. If the tool is denied, do not try any other way; just report the reason you were given.');
    assert.match(fs.readFileSync(path.join(repo, 'busy.txt'), 'utf8'), /CHANGED/, `Claude Code ran the tool despite the crashed hook (fail-open). Claude said: ${said}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function codex(cwd: string, prompt: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn('codex', ['exec', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-s', 'workspace-write', '-c', `projects."${cwd}".trust_level="trusted"`, prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (out += chunk));
    child.on('close', () => resolve(out));
  });
}

test('Codex: an apply_patch another session holds is denied before it happens', { skip: !liveCodex && 'set PRAXIS_LIVE_CODEX=1', timeout: 300_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'busy.txt'), 'original\n');
  fs.mkdirSync(path.join(repo, '.codex'));
  const command = `PRAXIS_COORDINATION_ROOT="${root}" "${process.execPath}" "${HOOK}" --runtime codex`;
  const entry = { hooks: [{ type: 'command', command }] };
  fs.writeFileSync(path.join(repo, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', ...entry }], PostToolUse: [{ matcher: '.*', ...entry }], Stop: [entry] } }));
  const broker = await joinCoordination(root);
  try {
    await broker.send({ kind: 'register', session: { sessionKey: 'SESSION-B', runtime: 'gateway', coverage: 'enforced' } });
    await broker.send({ kind: 'acquire', requestId: 'b1', owner: { sessionKey: 'SESSION-B' }, items: [{ resource: { kind: 'file', worktree: repo, path: 'busy.txt' }, mode: 'exclusive' }], reason: 'rewriting busy.txt', lifetime: 'sequence', wait: false });

    const prompt = 'Replace the whole contents of busy.txt with the single line CHANGED, using apply_patch (not the shell). If the tool is denied, do not try any other way; just report the reason you were given.';
    const refused = await codex(repo, prompt);
    assert.equal(fs.readFileSync(path.join(repo, 'busy.txt'), 'utf8'), 'original\n', `the losing patch never applied. Codex said: ${refused.slice(-2000)}`);
    assert.match(refused, /blocked by PreToolUse hook: Praxis coordination: Busy: file busy\.txt is held by SESSION-B/, refused.slice(-2000));

    await broker.send({ kind: 'release', owner: { sessionKey: 'SESSION-B' }, requestId: 'b1' });
    const done = await codex(repo, prompt);
    assert.match(fs.readFileSync(path.join(repo, 'busy.txt'), 'utf8'), /CHANGED/, done.slice(-2000));
    const state = (await broker.snapshot()) as { claims: unknown[]; events: Array<{ type: string; sessionKey?: string }> };
    assert.equal(state.claims.length, 0, 'released after the tool and at Stop');
    assert.ok(state.events.some(event => event.type === 'resource-acquired' && event.sessionKey?.startsWith('codex:')), 'the granted patch went through the broker');
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
