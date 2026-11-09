import test, { mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SharedSettingsBackend } from './adapters/sharedSettingsBackend';
import { registerGitIpc } from './gitIpc';
import { registerFolderIpc } from './folderIpc';
import * as hostInstance from './rustHostInstance';
import * as connectionInstance from './connectionStoreInstance';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';

type Handler = (event: unknown, ...args: any[]) => unknown;

// Capture the actual IPC fallbacks, rather than maintaining a second dispatch table.
function fallbacks(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const capture = mock.method(hostInstance, 'getRustHostBridge', () => ({
    handleOrFallback: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }) as unknown as RustHostBridge);
  try { registerGitIpc(); registerFolderIpc(); } finally { capture.mock.restore(); }
  return handlers;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(repo: string, file: string, content: string): void {
  fs.writeFileSync(path.join(repo, file), content);
}
function commit(repo: string, message: string): void { git(repo, 'add', '.'); git(repo, 'commit', '-m', message); }

function setup(root: string, channel: string): unknown[] {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  if (channel === 'git:initialize') return [repo];
  git(repo, 'init', '-b', 'main');
  write(repo, 'work.txt', 'base\n'); commit(repo, 'base');
  write(repo, 'work.txt', 'second\n'); commit(repo, 'second');
  git(repo, 'tag', 'v1', 'HEAD~1');
  const remote = path.join(root, 'remote.git');
  git(repo, 'init', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, '--git-dir='+remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const simple: Record<string, unknown[]> = {
    'git:preflight': [], 'git:open': [], 'git:refresh': [], 'git:status': [],
    'git:getCommit': [git(repo, 'rev-parse', 'HEAD')], 'git:getDiff': ['HEAD'],
    'git:getComparison': [{ kind: 'working' }],
    'git:createBranch': ['created'], 'git:checkout': ['other'],
    'git:deleteBranch': ['other'], 'git:renameBranch': ['other', 'renamed'],
    'git:getFileContent': ['work.txt'], 'git:getFileHistory': ['work.txt'],
    'git:getBlame': ['work.txt'], 'git:revert': ['HEAD'],
    'git:pull': [], 'git:fetch': [], 'git:push': []
  };
  if (channel === 'git:clone') return [remote, root, 'cloned'];
  if (channel === 'git:push') { write(repo, 'pushed.txt', 'new remote commit\n'); commit(repo, 'push fixture'); }
  if (channel === 'git:pull' || channel === 'git:fetch') {
    const upstream = path.join(root, 'upstream');
    git(repo, 'clone', remote, upstream);
    write(upstream, 'pulled.txt', 'new upstream commit\n'); commit(upstream, 'upstream fixture');
    git(upstream, 'push');
  }
  if (channel === 'git:status') {
    write(repo, 'work.txt', 'dirty\n'); write(repo, 'untracked.txt', 'untracked\n');
  }
  if (['git:checkout', 'git:deleteBranch', 'git:renameBranch'].includes(channel)) git(repo, 'branch', 'other');
  if (['git:stage', 'git:unstage', 'git:discard', 'git:commit', 'git:stash', 'git:popStash', 'git:applyHunk', 'git:getComparison'].includes(channel)) {
    write(repo, 'work.txt', 'changed\n');
    if (['git:unstage', 'git:commit'].includes(channel)) git(repo, 'add', '.');
    if (channel === 'git:popStash') git(repo, 'stash', 'push', '-m', 'saved');
    if (channel === 'git:applyHunk') return [repo, { path: 'work.txt', action: 'stage', patch: git(repo, 'diff')+'\n' }];
    if (channel === 'git:commit') return [repo, 'parity commit'];
    if (channel === 'git:stash') return [repo, 'parity stash'];
    if (channel === 'git:popStash') return [repo];
    if (channel !== 'git:getComparison') return [repo, ['work.txt']];
  }
  if (['git:merge', 'git:rebase', 'git:cherryPick'].includes(channel)) {
    git(repo, 'checkout', '-b', 'feature', 'HEAD~1');
    write(repo, 'feature.txt', 'feature\n'); commit(repo, 'feature');
    const hash = git(repo, 'rev-parse', 'HEAD');
    if (channel === 'git:rebase') return [repo, 'main'];
    git(repo, 'checkout', 'main');
    return [repo, channel === 'git:merge' ? 'feature' : hash];
  }
  if (['git:getConflict', 'git:resolveConflict', 'git:abortConflict'].includes(channel)) {
    git(repo, 'checkout', '-b', 'conflicting', 'HEAD~1');
    write(repo, 'work.txt', 'incoming\n'); commit(repo, 'incoming');
    git(repo, 'checkout', 'main');
    assert.throws(() => git(repo, 'merge', 'conflicting'));
    if (channel === 'git:abortConflict') return [repo];
    return channel === 'git:getConflict' ? [repo, 'work.txt'] : [repo, 'work.txt', { strategy: 'manual', content: 'resolved\n' }];
  }
  assert.ok(channel in simple, `Missing fixture for ${channel}`);
  return [repo, ...simple[channel]];
}

// Only wall-clock response metadata and fixture root locations are normalized.
function normalize(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'generatedAt' || key === 'loadedAt') return '<clock>';
    return typeof item === 'string' ? item.split(root).join('<fixture>') : item;
  }));
}
function diskState(root: string): unknown {
  const repo = path.join(root, fs.existsSync(path.join(root, 'cloned')) ? 'cloned' : 'repo');
  const files: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files[path.relative(repo, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(repo);
  const hasHead = fs.existsSync(path.join(repo, '.git/refs/heads/main'));
  return normalize({ files, status: git(repo, 'status', '--porcelain=v1'),
    refs: hasHead ? git(repo, 'show-ref') : '', history: hasHead ? git(repo, 'log', '--all', '--format=%H %P %s') : '',
    index: git(repo, 'ls-files', '--stage'), staged: git(repo, 'diff', '--cached'),
    remoteRefs: fs.existsSync(path.join(root, 'remote.git')) ? git(repo, '--git-dir='+path.join(root, 'remote.git'), 'show-ref') : '' }, root);
}

test('every default Rust channel matches its TypeScript fallback and mutation state', async t => {
  const env = { GIT_AUTHOR_DATE: '2026-01-02T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T12:00:00Z',
    GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Parity',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'parity@example.test',
    GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'init.defaultBranch', GIT_CONFIG_VALUE_3: 'main',
    GIT_CONFIG_KEY_4: 'core.hooksPath', GIT_CONFIG_VALUE_4: fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-parity-hooks-')) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const handlers = fallbacks();
  const covered = new Set<string>();
  try {
    for (const channel of hostInstance.DEFAULT_MIGRATED_CHANNELS) await t.test(channel, async () => {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-channel-parity-')));
      const tsRoot = path.join(temp, 'ts'); const rustRoot = path.join(temp, 'rust');
      fs.mkdirSync(tsRoot); fs.mkdirSync(rustRoot);
      const settingsPath = path.join(rustRoot, 'settings.json');
      const bridge = new RustHostBridge({ transport: new StdioRustHostTransport({ userDataDir: rustRoot, settingsPath }) });
      try {
        if (channel === 'settings:get') {
          const raw = { appearance: { surfacePackId: 'blueprint', accentColor: 'invalid' }, mobileAccess: { allowedSubnets: ['bad', '192.168.1.', '192.168.1.0/24'] }, startup: { reopenLastWorkspace: false } };
          fs.writeFileSync(settingsPath, JSON.stringify(raw));
          const backend = new SharedSettingsBackend(settingsPath);
          try { assert.deepEqual(await bridge.invoke(channel), backend.read()); } finally { backend.dispose(); }
          assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), raw, 'read must not rewrite settings');
        } else if (channel === 'folder:discoverPlans') {
          for (const root of [tsRoot, rustRoot]) {
            const plans = path.join(root, 'docs/plans'); fs.mkdirSync(plans, { recursive: true });
            fs.writeFileSync(path.join(plans, 'feature.md'), '# Example\n');
            fs.writeFileSync(path.join(plans, 'board.praxis.json'), JSON.stringify({ projectKey: 'PAR', projectName: 'Parity', workflow: [{ id: 'todo', name: 'Queued', category: 'todo' }, { id: 'done', name: 'Shipped', category: 'done' }] }));
            const stories = path.join(plans, 'stories/example'); fs.mkdirSync(stories, { recursive: true });
            fs.writeFileSync(path.join(stories, 'story.md'), '---\nid: FX-BE-1\ntype: Story\nstatus: Queued\n---\n# Nested story\n');
          }
          const connection = (root: string) => ({ id: 'folder-parity', mode: 'folder', name: 'Parity', settings: { roots: [root, root] } });
          fs.writeFileSync(settingsPath, JSON.stringify({ connections: [connection(rustRoot)] }));
          const stub = mock.method(connectionInstance, 'getConnectionStore', () => ({ getConnection: () => connection(tsRoot) }) as any);
          try {
            assert.deepEqual(normalize(await bridge.invoke(channel, 'folder-parity'), rustRoot), normalize(await handlers.get(channel)!({}, 'folder-parity'), tsRoot));
          } finally { stub.mock.restore(); }
        } else {
          const tsArgs = setup(tsRoot, channel); const rustArgs = setup(rustRoot, channel);
          const expected = await handlers.get(channel)!({}, ...tsArgs);
          const actual = await bridge.invoke(channel, ...rustArgs);
          assert.deepEqual(normalize(actual, rustRoot), normalize(expected, tsRoot), `${channel} response`);
          assert.deepEqual(diskState(rustRoot), diskState(tsRoot), `${channel} disk/index/refs/history`);
        }
        covered.add(channel);
      } finally { await bridge.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
    });
    assert.deepEqual([...covered].sort(), [...hostInstance.DEFAULT_MIGRATED_CHANNELS].sort());
  } finally {
    fs.rmSync(env.GIT_CONFIG_VALUE_4, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
