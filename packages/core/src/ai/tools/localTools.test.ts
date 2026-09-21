import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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
