import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalToolExecutor, type ToolPermissionRequest } from './localTools';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-localtools-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function executor(dir: string): LocalToolExecutor {
  return new LocalToolExecutor({
    workingDirectory: dir,
    toolMode: 'full',
    requestPermission: async () => 'allow_once'
  });
}

test('write_file returns a diff for a newly created file', async () => {
  await withTempDir(async dir => {
    const result = await executor(dir).execute('write_file', {
      path: 'notes.md',
      content: 'line one\nline two\n'
    });
    assert.equal(result.ok, true);
    assert.equal(result.data?.kind, 'write');
    assert.ok(result.data?.diff, 'expected a diff');
    assert.match(result.data!.diff!, /\+line one/);
    assert.equal(result.data?.fileChanges?.[0]?.path, 'notes.md');
    assert.equal(await fs.readFile(path.join(dir, 'notes.md'), 'utf8'), 'line one\nline two\n');
  });
});

test('write_file returns a diff with deletions when modifying an existing file', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'notes.md'), 'a\nb\nc\n', 'utf8');
    const result = await executor(dir).execute('write_file', {
      path: 'notes.md',
      content: 'a\nB\nc\n'
    });
    assert.equal(result.ok, true);
    assert.match(result.data!.diff!, /-b/);
    assert.match(result.data!.diff!, /\+B/);
  });
});

test('run_shell reports stdout and exit code in data', async () => {
  await withTempDir(async dir => {
    const result = await executor(dir).execute('run_shell', { command: 'echo praxis-ok' });
    assert.equal(result.ok, true);
    assert.equal(result.data?.kind, 'shell');
    assert.equal(result.data?.exitCode, 0);
    assert.match(result.data?.output ?? '', /praxis-ok/);
  });
});

test('permission prompts identify the tool without exposing its path or command', async () => {
  await withTempDir(async dir => {
    const requests: ToolPermissionRequest[] = [];
    const localTools = new LocalToolExecutor({
      workingDirectory: dir,
      toolMode: 'full',
      requestPermission: async request => {
        requests.push(request);
        return 'deny';
      }
    });

    const result = await localTools.execute('run_shell', { command: 'npm test -- --runInBand' });

    assert.equal(result.ok, false);
    assert.equal(requests[0]?.toolName, 'run_shell');
    assert.equal(requests[0]?.description, 'Permission requested: run_shell');
    assert.equal(requests[0]?.detail, 'The agent wants to execute a shell command in the project workspace.');
    assert.equal(requests[0]?.permissionKey, 'npm test -- --runInBand');
    assert.doesNotMatch(requests[0]?.description ?? '', /npm test|\//);
    assert.doesNotMatch(requests[0]?.detail ?? '', /npm test|\//);
  });
});

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('read_image returns base64 image attachments the model can view', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'shot.png'), PNG_1PX);
    const result = await executor(dir).execute('read_image', { path: 'shot.png' });

    assert.equal(result.ok, true);
    assert.equal(result.images?.length, 1);
    assert.equal(result.images?.[0].mimeType, 'image/png');
    assert.equal(result.images?.[0].dataBase64, PNG_1PX.toString('base64'));
    assert.doesNotMatch(result.images?.[0].dataBase64 ?? '', /^data:/);
    assert.match(result.content, /shot\.png/);
  });
});

test('read_image is offered in read-only mode', async () => {
  await withTempDir(async dir => {
    const readOnly = new LocalToolExecutor({
      workingDirectory: dir,
      toolMode: 'read-only',
      requestPermission: async () => 'allow_once'
    });
    await fs.writeFile(path.join(dir, 'shot.png'), PNG_1PX);
    assert.equal((await readOnly.execute('read_image', { path: 'shot.png' })).ok, true);
  });
});

test('read_image rejects a non-image path without reading it', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'notes.md'), '# hello');
    const result = await executor(dir).execute('read_image', { path: 'notes.md' });

    assert.equal(result.ok, false);
    assert.equal(result.images, undefined);
    assert.match(result.content, /Not a readable image/);
  });
});

test('read_image asks for permission and honours a denial', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'shot.png'), PNG_1PX);
    const requests: ToolPermissionRequest[] = [];
    const localTools = new LocalToolExecutor({
      workingDirectory: dir,
      toolMode: 'full',
      requestPermission: async request => {
        requests.push(request);
        return 'deny';
      }
    });

    const result = await localTools.execute('read_image', { path: 'shot.png' });

    assert.equal(result.ok, false);
    assert.equal(result.images, undefined);
    assert.equal(requests[0]?.toolName, 'read_image');
    assert.equal(requests[0]?.permissionKey, 'shot.png');
  });
});

test('read_image escapes the workspace', async () => {
  await withTempDir(async dir => {
    const result = await executor(dir).execute('read_image', { path: '../../etc/hosts' });
    assert.equal(result.ok, false);
  });
});

// ── Coordination gate (FX-BF-048 / TASK-393) ─────────────────────────────

test('a write or shell command another session holds is refused before it happens', async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'praxis-gate-'));
  try {
    const asked: string[] = [];
    let released = 0;
    const gate = {
      worktree: root,
      acquire: async (input: { items: Array<{ resource: { kind: string; path?: string } }>; reason: string }) => {
        asked.push(`${input.items[0].resource.kind}:${input.items[0].resource.path ?? ''}`);
        return input.items[0].resource.path === 'busy.ts'
          ? { ok: false as const, reason: 'file busy.ts is held by SESSION-B (editing).' }
          : { ok: true as const, release: async () => { released += 1; } };
      }
    };
    const executor = new LocalToolExecutor({ workingDirectory: root, toolMode: 'full', requestPermission: async () => 'allow_always', coordination: gate as never });

    const refused = await executor.execute('write_file', { path: 'busy.ts', content: 'x' });
    assert.equal(refused.ok, false);
    assert.match(refused.content, /Not done: file busy\.ts is held by SESSION-B .*do not retry in a loop/);
    assert.equal(fsSync.existsSync(path.join(root, 'busy.ts')), false, 'the losing write never touched the disk');

    const written = await executor.execute('write_file', { path: 'free.ts', content: 'y' });
    assert.equal(written.ok, true);
    assert.equal(released, 1, 'the claim is released once the write is done');

    const shell = await executor.execute('run_shell', { command: 'echo hi' });
    assert.equal(shell.ok, true);
    assert.deepEqual(asked, ['file:busy.ts', 'file:free.ts', 'worktree:'], 'a shell command owns the whole worktree');
    assert.equal(released, 2);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});
