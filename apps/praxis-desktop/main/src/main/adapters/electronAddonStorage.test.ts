import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Header } from 'tar';
import { extractAddonPayload } from './electronAddonStorage';

function archive(path: string, type: 'File' | 'SymbolicLink' | 'Link' = 'File', linkpath?: string): Buffer {
  const body = type === 'File' ? Buffer.from('legitimate payload') : Buffer.alloc(0);
  const header = new Header({ path, type, linkpath, mode: 0o644, size: body.length });
  header.encode();
  return Buffer.concat([header.block!, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]);
}

test('add-on extraction rejects traversal, absolute entries and both link types without writing outside its destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-addon-security-'));
  try {
    const dest = join(root, 'addon'); await mkdir(dest);
    for (const [name, type, target] of [['package/addon/../../escaped', 'File'], ['/package/addon/escaped', 'File'], ['package/addon/link', 'SymbolicLink', '../../escaped'], ['package/addon/link', 'Link', '/tmp/escaped']] as const) {
      await assert.rejects(extractAddonPayload(archive(name, type, target), dest, join(root, 'scratch')), /Unsafe|TAR_ENTRY_ERROR|absolute|\.\./);
      await assert.rejects(stat(join(root, 'escaped')));
    }
    await extractAddonPayload(archive('package/addon/asset.txt'), dest, join(root, 'scratch'));
    assert.equal(await readFile(join(dest, 'asset.txt'), 'utf8'), 'legitimate payload');
  } finally { await rm(root, { recursive: true, force: true }); }
});
