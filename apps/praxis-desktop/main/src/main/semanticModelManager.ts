import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { streamDownload } from './semanticModelDownload.js';
import type { SemanticModelProgressEvent, SemanticModelStatus } from '@praxis/core';
import { broadcastToAllWindows } from './windowBroadcast.js';

// Mirrors services/code-intelligence/models/bge-small-manifest.json, which the service
// pins and verifies; LocalModel refuses any other model, revision or checksum.
const MODEL_ID = 'BAAI/bge-small-en-v1.5';
const MODEL_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';

const ASSETS = [
  {
    name: 'vocab.txt',
    url: `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/vocab.txt`,
    size: 231508,
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'
  },
  {
    name: 'model.onnx',
    url: `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/onnx/model.onnx`,
    size: 133093490,
    sha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35'
  }
];

const TOTAL_BYTES = ASSETS.reduce((sum, a) => sum + a.size, 0);

const MANIFEST_CONTENT = {
  version: 1,
  modelId: MODEL_ID,
  revision: MODEL_REVISION,
  modelSha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
  vocabSha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  dimensions: 384,
  maximumTokens: 256,
  tokenizer: 'bert-uncased-wordpiece-v3',
  pooling: 'cls',
  normalization: 'l2',
  metric: 'cosine',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  representationVersion: 2,
  license: 'MIT'
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

function hasModelFiles(dir: string): boolean {
  return ['manifest.json', 'model.onnx', 'vocab.txt'].every(name => fs.existsSync(path.join(dir, name)));
}

function installedManifest(dir: string): { modelId?: unknown; revision?: unknown } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** True only for the pinned model; an older download (e.g. MiniLM) is not "installed". */
export function isSemanticModelInstalled(): boolean {
  const dir = getSemanticModelDirectory();
  if (!hasModelFiles(dir)) return false;
  const manifest = installedManifest(dir);
  return manifest?.modelId === MODEL_ID && manifest?.revision === MODEL_REVISION;
}

/** Model files from an earlier pinned model are present; downloading replaces them. */
export function isSemanticModelUpdateAvailable(): boolean {
  return hasModelFiles(getSemanticModelDirectory()) && !isSemanticModelInstalled();
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
    updateAvailable: isSemanticModelUpdateAvailable(),
    modelId: MANIFEST_CONTENT.modelId,
    architecture: installed ? 'BERT / bge-small (ONNX)' : undefined
  };
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
