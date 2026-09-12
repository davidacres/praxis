import { gunzipSync } from 'node:zlib';

/**
 * Reads `package/package.json`'s `praxis` field straight out of a published
 * tarball, in memory — a pure USTAR reader, no `fs`, no external `tar` dep.
 *
 * Why this exists: GitHub Packages' npm registry packument API only echoes a
 * fixed allowlist of "standard" npm fields (name, version, dist, description,
 * repository, author, homepage, …) for each version — it silently drops any
 * custom top-level field, `praxis` included, even when the package was
 * published correctly and the real `package.json` inside the tarball has it.
 * Verified directly: a real published add-on's packument version entry has no
 * `praxis` key at all, while `package/package.json` inside its own tarball
 * does. Relying on the packument alone means every GitHub Packages-hosted
 * add-on is silently invisible to the catalogue, regardless of how correctly
 * it was authored. This is the fallback that recovers it.
 */
export function readPraxisManifestFromTarball(tarball: Uint8Array): unknown {
  const tar = gunzipSync(tarball);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two consecutive zeroed blocks mark end-of-archive.
    if (header.every(byte => byte === 0)) break;

    const name = readCString(header, 0, 100);
    const sizeOctal = readCString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const contentStart = offset + 512;

    if (name === 'package/package.json') {
      const content = tar.subarray(contentStart, contentStart + size).toString('utf8');
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return parsed.praxis;
      } catch {
        return undefined;
      }
    }

    // Advance past this entry's content, padded up to the next 512-byte block.
    const blocks = Math.ceil(size / 512);
    offset = contentStart + blocks * 512;
  }
  return undefined;
}

function readCString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}
