import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { readPraxisManifestFromTarball } from './tarballManifest';

/** Builds a minimal single-file USTAR tarball (gzipped), the same shape `npm pack` produces. */
function buildTarball(entries: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const contentBuf = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(contentBuf.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8'); // checksum placeholder
    header.write('0', 156, 1, 'utf8'); // typeflag: normal file
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');

    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

    const paddedLength = Math.ceil(contentBuf.length / 512) * 512;
    const contentBlock = Buffer.alloc(paddedLength);
    contentBuf.copy(contentBlock);

    blocks.push(header, contentBlock);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(blocks));
}

test('readPraxisManifestFromTarball recovers the manifest from package/package.json', () => {
  const tarball = buildTarball({
    'package/package.json': JSON.stringify({
      name: '@acme/praxis-addon-nord',
      version: '1.0.0',
      praxis: { schemaVersion: 1, kind: 'theme', id: 'nord', name: 'Nord' }
    }),
    'package/README.md': '# Nord'
  });
  const manifest = readPraxisManifestFromTarball(tarball);
  assert.deepEqual(manifest, { schemaVersion: 1, kind: 'theme', id: 'nord', name: 'Nord' });
});

test('readPraxisManifestFromTarball returns undefined when package.json has no praxis field', () => {
  const tarball = buildTarball({
    'package/package.json': JSON.stringify({ name: '@acme/some-lib', version: '1.0.0' })
  });
  assert.equal(readPraxisManifestFromTarball(tarball), undefined);
});

test('readPraxisManifestFromTarball returns undefined when package/package.json is absent', () => {
  const tarball = buildTarball({ 'package/README.md': '# nothing here' });
  assert.equal(readPraxisManifestFromTarball(tarball), undefined);
});
