import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('review MCP exposes frozen artifacts and source without shell or out-of-folder access', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'review-files-'));
  const root = join(folder, 'worktree');
  await mkdir(join(root, '.praxis-run'), { recursive: true });
  await writeFile(join(root, '.praxis-run/change-diff.patch'), '+fixed\n');
  await writeFile(join(root, '.praxis-run/qa-results.md'), 'Prior QA finding');
  await writeFile(join(root, 'source.ts'), 'export const fixed = true;');
  await writeFile(join(folder, 'secret'), 'outside secret');
  await symlink(join(folder, 'secret'), join(root, 'escape'));
  const client = new Client({ name: 'review-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(__dirname, 'readOnlyFilesMcp.js'), root] }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['read_file', 'list_dir']);
    for (const [path, expected] of [['.praxis-run/change-diff.patch', '+fixed'], ['.praxis-run/qa-results.md', 'Prior QA finding'], ['source.ts', 'fixed = true']]) {
      const result = await client.callTool({ name: 'read_file', arguments: { path } });
      assert.notEqual(result.isError, true);
      assert.ok(JSON.stringify(result.content).includes(expected));
    }
    for (const path of ['../secret', join(folder, 'secret'), 'escape']) {
      const result = await client.callTool({ name: 'read_file', arguments: { path } });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result.content).includes('outside secret'));
    }
    assert.equal((await client.callTool({ name: 'run_shell', arguments: { path: '.' } })).isError, true);
    await writeFile(join(root, 'large'), 'x'.repeat(48_000) + 'tail');
    assert.ok(JSON.stringify((await client.callTool({ name: 'read_file', arguments: { path: 'large' } })).content).includes('offset 48000'));
    assert.ok(JSON.stringify((await client.callTool({ name: 'read_file', arguments: { path: 'large', offset: 48000 } })).content).includes('tail'));
  } finally {
    await client.close();
    await rm(folder, { recursive: true, force: true });
  }
});
