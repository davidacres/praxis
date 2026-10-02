/**
 * Serves one local or user-attached session image to the phone
 * (`sessions.imagePreview`). Mirrors the desktop's own `ai:loadImagePreview`
 * IPC handler rather than sharing code with it, so the two can change
 * independently without a shared module straddling both.
 */
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import {
  PathSandboxError,
  resolveSandboxedPath,
  type AgentSessionRecord,
  type MobileImagePreview,
  type MobileReadParams,
} from '@praxis/core';

const IMAGE_PREVIEW_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};
const MAX_MOBILE_IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024;
const MOBILE_IMAGE_PREVIEW_CHUNK_CHARS = 768 * 1024;
const ATTACHMENT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * The session a phone request names. A gadget carries the work id (the issue
 * key, e.g. `SESSION-1a2b3c4d`) as its session reference, while other requests
 * carry the session's own id, so both must resolve — as they already do for
 * `getSession` and the desktop's own `ai:loadImagePreview`.
 */
export function findSessionRecord<T extends Pick<AgentSessionRecord, 'sessionId' | 'issueKey'>>(
  records: Iterable<T>,
  reference: string,
): T | undefined {
  const all = [...records];
  return all.find(record => record.sessionId === reference) ?? all.find(record => record.issueKey === reference);
}

/** The session's own repository folder, or undefined when none is known yet. */
function sessionWorkingDirectory(record: Pick<AgentSessionRecord, 'worktreePath' | 'workingDirectory'>): string | undefined {
  return record.worktreePath?.trim() || record.workingDirectory?.trim() || undefined;
}

/**
 * One transport-safe base64 chunk for a session-local or user-attached image.
 * Each response is small enough for the mobile secure channel's 1 MiB record
 * limit; a miss is a quiet "no preview", as on the desktop.
 */
export async function readMobileImagePreview(
  record: AgentSessionRecord,
  params: Pick<MobileReadParams, 'path' | 'eventIndex' | 'attachmentIndex' | 'offset'>,
): Promise<MobileImagePreview | undefined> {
  const offset = params.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 4 !== 0) return undefined;

  let mimeType: string;
  let base64: string;
  if (params.path?.trim()) {
    const workingDirectory = sessionWorkingDirectory(record);
    const input = params.path.trim();
    if (!workingDirectory) return undefined;

    const extension = nodePath.extname(input.split(/[?#]/, 1)[0] ?? '').toLowerCase();
    mimeType = IMAGE_PREVIEW_MEDIA_TYPES[extension] ?? '';
    if (!mimeType) return undefined;

    let candidateInput = input;
    if (/^file:\/\//i.test(candidateInput)) {
      try {
        candidateInput = decodeURIComponent(new URL(candidateInput).pathname);
      } catch {
        return undefined;
      }
    }

    let absolute: string;
    try {
      absolute = resolveSandboxedPath(workingDirectory, candidateInput);
    } catch (error) {
      if (error instanceof PathSandboxError) return undefined;
      throw error;
    }

    let contents: Buffer;
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_MOBILE_IMAGE_PREVIEW_BYTES) return undefined;
      contents = await fsp.readFile(absolute);
      if (contents.length > MAX_MOBILE_IMAGE_PREVIEW_BYTES) return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return undefined;
      throw error;
    }
    base64 = contents.toString('base64');
  } else {
    const { eventIndex, attachmentIndex } = params;
    if (!Number.isSafeInteger(eventIndex) || eventIndex! < 0 || !Number.isSafeInteger(attachmentIndex) || attachmentIndex! < 0) {
      return undefined;
    }
    const event = record.events[eventIndex!];
    const attachment = event?.type === 'user_input_completed' ? event.attachments?.[attachmentIndex!] : undefined;
    if (!attachment || !ATTACHMENT_MEDIA_TYPES.has(attachment.mimeType.toLowerCase())) return undefined;
    base64 = attachment.dataBase64;
    if (
      !base64 ||
      base64.length % 4 !== 0 ||
      base64.length > Math.ceil(MAX_MOBILE_IMAGE_PREVIEW_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    ) return undefined;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    if (Math.floor(base64.length * 3 / 4) - padding > MAX_MOBILE_IMAGE_PREVIEW_BYTES) return undefined;
    mimeType = attachment.mimeType.toLowerCase();
  }

  if (offset > base64.length) return undefined;
  const end = Math.min(base64.length, offset + MOBILE_IMAGE_PREVIEW_CHUNK_CHARS);
  return {
    mimeType,
    dataBase64: base64.slice(offset, end),
    nextOffset: end,
    totalLength: base64.length,
  };
}
