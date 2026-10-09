import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinCoordination } from './coordinationHost';

/**
 * Live proof against the installed Claude Code (TASK-395): its Write tool is denied by the
 * coordination hook *before* the losing write, and the same request succeeds once the
 * file is free. Uses `claude --settings <file>` — nothing is written to the user's global
 * configuration. Run with PRAXIS_LIVE_CLAUDE=1; it spends a little Claude usage.
 */

const HOOK = path.join(__dirname, 'coordinationHook.js');
const live = process.env.PRAXIS_LIVE_CLAUDE === '1';

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
