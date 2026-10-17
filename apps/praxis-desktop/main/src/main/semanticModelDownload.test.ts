import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { streamDownload } from './semanticModelDownload';

const asset = Buffer.from('pinned model asset bytes\n');
const sha256 = createHash('sha256').update(asset).digest('hex');

// /relative answers like Hugging Face does for vocab.txt: a 307 to a path-only Location.
async function withServer(run: (base: string, requests: string[]) => Promise<void>): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/relative') { res.writeHead(307, { Location: '/api/resolve-cache/asset?etag=%22x%22' }); res.end(); return; }
    if (req.url === '/absolute') { res.writeHead(302, { Location: `${base}/api/resolve-cache/asset` }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
    if (req.url?.startsWith('/api/resolve-cache/asset')) { res.writeHead(200); res.end(asset); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(base, requests); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function destination(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-model-download-')), 'vocab.txt');
}

test('a relative redirect resolves against the requested URL', async () => {
  await withServer(async (base, requests) => {
    const target = destination();
    await streamDownload(`${base}/relative`, target, asset.length, sha256, () => {});
    assert.deepEqual(fs.readFileSync(target), asset);
    assert.deepEqual(requests, ['/relative', '/api/resolve-cache/asset?etag=%22x%22']);
  });
});

test('an absolute redirect is still followed', async () => {
  await withServer(async base => {
    const target = destination();
    await streamDownload(`${base}/absolute`, target, asset.length, sha256, () => {});
    assert.deepEqual(fs.readFileSync(target), asset);
  });
});

test('a checksum mismatch leaves no file behind', async () => {
  await withServer(async base => {
    const target = destination();
    await assert.rejects(streamDownload(`${base}/relative`, target, asset.length, '0'.repeat(64), () => {}), /Checksum mismatch/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.partial`), false);
  });
});

test('a redirect loop stops', async () => {
  await withServer(async base => {
    await assert.rejects(streamDownload(`${base}/loop`, destination(), asset.length, sha256, () => {}), /Too many redirects/);
  });
});
