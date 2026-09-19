import type { WireImageAttachment } from '@praxis/core';

/**
 * Image attachments for the session chat composer — pasted or dropped in,
 * downscaled to a sane maximum dimension, and re-encoded as PNG/JPEG base64
 * so a 6000px screenshot cannot stall the IPC channel or the provider request.
 * Re-encoded through a canvas rather than passed through raw: clipboard PNGs
 * from some apps are enormous, and HEIC (iOS screenshots) needs transcoding
 * to something providers accept.
 */

/** Longest edge an attachment keeps after downscaling. */
const MAX_EDGE_PX = 1568;
/** Cap on images carried by a single user turn. */
export const MAX_ATTACHED_IMAGES = 4;
/** Per-image encoded budget — past this the re-encode drops JPEG quality before failing. */
const MAX_ENCODED_BYTES = 5 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** A file or clipboard item the composer accepted, before re-encoding. */
export interface PendingImageSource {
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
}

/** True when a dropped/pasted file is an image the composer can carry. */
export function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_MIME_TYPES.has(file.type.toLowerCase());
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

/** Bytes → a `data:` URL. The app CSP allows `data:` images but not `blob:`, so decoding goes through this rather than object URLs. */
function bytesToDataUrl(bytes: ArrayBuffer, mimeType: string): string {
  return `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`;
}

/** Loads image dimensions, rejecting for anything the browser cannot decode. */
function loadDimensions(bytes: ArrayBuffer, mimeType: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('That image could not be read.'));
    image.src = bytesToDataUrl(bytes, mimeType);
  });
}

/**
 * Re-encodes an image through a canvas at a downscaled size, returning base64
 * (no `data:` prefix) ready for the wire. GIFs skip the canvas — re-encoding
 * would drop animation — and are only accepted as-is when already small.
 */
export async function encodeImageAttachment(source: PendingImageSource): Promise<WireImageAttachment> {
  const mimeType = source.mimeType.toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error('Only PNG, JPEG, WebP, or GIF images can be attached.');
  }

  const rawBytes = source.bytes;
  if (mimeType === 'image/gif') {
    if (rawBytes.byteLength > MAX_ENCODED_BYTES) {
      throw new Error('That GIF is too large to attach.');
    }
    return { mimeType, dataBase64: arrayBufferToBase64(rawBytes) };
  }

  const { width, height } = await loadDimensions(rawBytes, mimeType);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('That image could not be read.');
  context.drawImage(await loadImageElement(rawBytes, mimeType), 0, 0, targetWidth, targetHeight);

  // JPEG first (small); fall back to keeping alpha-safe PNG when the image
  // still exceeds the budget and PNG does better, or when encoding fails.
  const png = await canvasToBase64(canvas, 'image/png');
  const keepPng = mimeType === 'image/png' && png.bytes <= MAX_ENCODED_BYTES;
  const chosen = keepPng ? png : await encodeJpegWithinBudget(canvas);
  return { mimeType: chosen.mimeType, dataBase64: chosen.base64 };
}

/**
 * Decodes through an `<img>` element — `createImageBitmap` is avoided because
 * Chromium rejects it for images that arrive outside a fetch context in a
 * `file://` window, while `<img>` decoding works for anything `loadDimensions`
 * already accepted.
 */
function loadImageElement(bytes: ArrayBuffer, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That image could not be read.'));
    image.src = bytesToDataUrl(bytes, mimeType);
  });
}

async function canvasToBase64(canvas: HTMLCanvasElement, mimeType: string): Promise<{ mimeType: string; base64: string; bytes: number }> {
  const dataUrl = canvas.toDataURL(mimeType);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { mimeType, base64, bytes: Math.floor(base64.length * 3 / 4) };
}

/** JPEG re-encode, stepping quality down until the encoded size fits the budget. */
async function encodeJpegWithinBudget(canvas: HTMLCanvasElement): Promise<{ mimeType: string; base64: string }> {
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const encoded = await canvasToBase64(canvas, 'image/jpeg');
    if (encoded.bytes <= MAX_ENCODED_BYTES) {
      return { mimeType: encoded.mimeType, base64: encoded.base64 };
    }
  }
  throw new Error('That image is too large to attach.');
}

/** Bytes → base64 without the `data:` prefix, in chunks to avoid call-stack limits. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Collects every supported image file from a drop/paste event's transfer list. */
export async function collectImageFiles(files: FileList | File[]): Promise<PendingImageSource[]> {
  const supported = Array.from(files).filter(isSupportedImageFile);
  return Promise.all(supported.map(async file => ({ mimeType: file.type, bytes: await readBytes(file) })));
}

/** Reads image payloads out of a clipboard event, preferring file items. */
export async function collectClipboardImages(clipboardData: DataTransfer): Promise<PendingImageSource[]> {
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && isSupportedImageFile(file)) files.push(file);
  }
  return collectImageFiles(files);
}
