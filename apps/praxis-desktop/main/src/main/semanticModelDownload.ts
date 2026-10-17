import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';

/** Streams one pinned asset to `destination`, following redirects and refusing a size or checksum mismatch. */
export function streamDownload(
  url: string,
  destination: string,
  expectedSize: number,
  expectedSha256: string,
  onChunk: (bytesReceived: number) => void,
  redirectCount = 0
): Promise<void> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects while downloading model asset.'));
  }

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('http:') ? http : https;
    const req = protocol.get(url, { headers: { 'User-Agent': 'Praxis-Desktop' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Hugging Face answers some assets with a relative Location
        // (/api/resolve-cache/...); resolve it against the URL just requested.
        const next = new URL(res.headers.location, url).toString();
        return resolve(
          streamDownload(next, destination, expectedSize, expectedSha256, onChunk, redirectCount + 1)
        );
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed with status ${res.statusCode}: ${url}`));
      }

      const hash = createHash('sha256');
      let bytesCount = 0;
      const tempPath = `${destination}.partial`;
      const fileStream = fs.createWriteStream(tempPath);

      res.on('data', chunk => {
        bytesCount += chunk.length;
        hash.update(chunk);
        onChunk(chunk.length);
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (bytesCount !== expectedSize) {
            fs.unlinkSync(tempPath);
            return reject(new Error(`Size mismatch for ${path.basename(destination)}: expected ${expectedSize}, got ${bytesCount}`));
          }
          const actualSha256 = hash.digest('hex');
          if (actualSha256 !== expectedSha256) {
            fs.unlinkSync(tempPath);
            return reject(new Error(`Checksum mismatch for ${path.basename(destination)}: expected ${expectedSha256}, got ${actualSha256}`));
          }
          fs.renameSync(tempPath, destination);
          resolve();
        });
      });

      fileStream.on('error', err => {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Download connection timed out.'));
    });
  });
}
