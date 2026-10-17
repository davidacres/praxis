import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { SemanticModelProgressEvent, SemanticModelStatus } from '@praxis/core';
import { broadcastToAllWindows } from './windowBroadcast.js';

const ASSETS = [
  {
    name: 'vocab.txt',
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/vocab.txt',
    size: 231508,
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'
  },
  {
    name: 'model.onnx',
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/onnx/model.onnx',
    size: 90405214,
    sha256: '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452'
  }
];

const TOTAL_BYTES = ASSETS.reduce((sum, a) => sum + a.size, 0);

const MANIFEST_CONTENT = {
  version: 1,
  modelId: 'sentence-transformers/all-MiniLM-L6-v2',
  revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41',
  modelSha256: '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452',
  vocabSha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  dimensions: 384,
  maximumTokens: 256,
  tokenizer: 'bert-uncased-wordpiece-v3',
  pooling: 'attention-mask-mean',
  normalization: 'l2',
  metric: 'cosine',
  queryPrefix: '',
  documentPrefix: '',
  representationVersion: 2,
  license: 'Apache-2.0'
};

export function getSemanticModelDirectory(): string {
  if (process.env.PRAXIS_MODEL_BUNDLE && fs.existsSync(process.env.PRAXIS_MODEL_BUNDLE)) {
    return process.env.PRAXIS_MODEL_BUNDLE;
  }
  return path.join(app.getPath('userData'), 'models', 'semantic-search');
}

let isDownloading = false;
let currentProgress = 0;
let cachedFingerprint: string | undefined;

export function isSemanticModelInstalled(): boolean {
  const dir = getSemanticModelDirectory();
  const manifestPath = path.join(dir, 'manifest.json');
  const modelPath = path.join(dir, 'model.onnx');
  const vocabPath = path.join(dir, 'vocab.txt');
  return fs.existsSync(manifestPath) && fs.existsSync(modelPath) && fs.existsSync(vocabPath);
}

export function getCachedFingerprint(): string | undefined {
  return cachedFingerprint;
}

export function setCachedFingerprint(fingerprint: string | undefined): void {
  cachedFingerprint = fingerprint;
}

export function getSemanticModelStatus(): SemanticModelStatus {
  const installed = isSemanticModelInstalled();
  const dir = getSemanticModelDirectory();
  let sizeBytes = 0;
  if (installed) {
    try {
      const modelStat = fs.statSync(path.join(dir, 'model.onnx'));
      const vocabStat = fs.statSync(path.join(dir, 'vocab.txt'));
      sizeBytes = modelStat.size + vocabStat.size;
    } catch {
      // ignore
    }
  }

  return {
    installed,
    active: installed && !!cachedFingerprint,
    fingerprint: cachedFingerprint,
    sizeBytes,
    downloading: isDownloading,
    progressPercent: currentProgress,
    modelId: MANIFEST_CONTENT.modelId,
    architecture: installed ? 'BERT / MiniLM (ONNX)' : undefined
  };
}

function streamDownload(
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
        return resolve(
          streamDownload(res.headers.location, destination, expectedSize, expectedSha256, onChunk, redirectCount + 1)
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

export async function downloadSemanticModel(
  onProgress?: (event: SemanticModelProgressEvent) => void
): Promise<void> {
  if (isDownloading) {
    throw new Error('Model download is already in progress.');
  }

  const dir = getSemanticModelDirectory();
  fs.mkdirSync(dir, { recursive: true });

  isDownloading = true;
  currentProgress = 0;
  let totalDownloadedSoFar = 0;

  const emitProgress = (additionalBytes: number) => {
    totalDownloadedSoFar += additionalBytes;
    const percent = Math.min(100, Math.round((totalDownloadedSoFar / TOTAL_BYTES) * 100));
    currentProgress = percent;
    const event: SemanticModelProgressEvent = {
      bytesDownloaded: totalDownloadedSoFar,
      totalBytes: TOTAL_BYTES,
      percent
    };
    if (onProgress) onProgress(event);
    broadcastToAllWindows('ai:semanticModelProgress', event);
  };

  try {
    for (const asset of ASSETS) {
      const assetDest = path.join(dir, asset.name);
      if (fs.existsSync(assetDest) && fs.statSync(assetDest).size === asset.size) {
        emitProgress(asset.size);
        continue;
      }

      await streamDownload(asset.url, assetDest, asset.size, asset.sha256, chunkBytes => {
        emitProgress(chunkBytes);
      });
    }

    // Write manifest.json
    const manifestDest = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestDest, JSON.stringify(MANIFEST_CONTENT, null, 2), 'utf8');

    currentProgress = 100;
    broadcastToAllWindows('ai:semanticModelProgress', {
      bytesDownloaded: TOTAL_BYTES,
      totalBytes: TOTAL_BYTES,
      percent: 100
    });
  } finally {
    isDownloading = false;
  }
}

export function deleteSemanticModel(): void {
  const dir = getSemanticModelDirectory();
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to remove semantic model directory:', err);
  }
  cachedFingerprint = undefined;
}
