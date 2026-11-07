import { lstat, open, readdir } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { readSandboxedFile, resolveSandboxedPath, writeSandboxedFile } from '../ai/tools/pathSandbox';
import { htmlDocumentTitle, type ArtifactsFolderEntry } from './artifactLibrary';

/**
 * Where a project's published artifacts live, relative to its repository root.
 * Matches the folder this repository already keeps (`docs/published-artifacts`),
 * so an unset project publishes beside the existing pages.
 */
export const DEFAULT_ARTIFACTS_FOLDER = 'docs/published-artifacts';

/**
 * Validates a user-entered artifacts folder and returns it in stored form:
 * relative to the repository root, POSIX separators, no `.` segments.
 * Empty input means "use the default" and returns `undefined`.
 */
export function normalizeArtifactsFolder(raw: string): string | undefined {
  const value = raw.trim().replace(/\\/g, '/');
  if (!value) return undefined;
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error(`Artifacts folder must be a path inside the repository, like ${DEFAULT_ARTIFACTS_FOLDER}.`);
  }
  const segments = value.split('/').filter(segment => segment && segment !== '.');
  if (segments.includes('..')) throw new Error('Artifacts folder cannot go above the repository root.');
  if (segments.length === 0) throw new Error('Choose a folder inside the repository, not the repository root itself.');
  if (segments[0].toLowerCase() === '.git') throw new Error('Artifacts folder cannot be inside .git.');
  return segments.join('/');
}

/** The nearest folder at or above `start` that holds a `.git` entry (a directory, or a worktree's file). */
export async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let dir = nodePath.resolve(start);
  for (;;) {
    const found = await lstat(nodePath.join(dir, '.git')).then(() => true, () => false);
    if (found) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the artifacts folder for a checkout. The setting is relative to the
 * repository root that contains `baseFolder`; outside a repository it is
 * relative to `baseFolder` itself.
 */
export async function resolveArtifactsFolder(baseFolder: string, setting?: string): Promise<{ root: string; folder: string }> {
  const root = (await findRepositoryRoot(baseFolder)) ?? nodePath.resolve(baseFolder);
  const folder = normalizeArtifactsFolder(setting ?? '') ?? DEFAULT_ARTIFACTS_FOLDER;
  return { root, folder };
}

export interface PublishArtifactResult {
  /** Repository-relative, POSIX — what the UI shows. */
  savedPath: string;
  absolutePath: string;
  /** The folder already held a byte-identical copy, so nothing was written. */
  unchanged: boolean;
}

/**
 * Copies an artifact into the project's artifacts folder. An existing file is
 * never overwritten: an identical copy is reused, and a different file with
 * the same name pushes the new one to the first free `name-2.ext`, `name-3.ext`, ….
 * Every read and write goes through the path sandbox rooted at the repository.
 */
export async function publishArtifact(input: {
  baseFolder: string;
  setting?: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<PublishArtifactResult> {
  const fileName = nodePath.basename(input.fileName.replace(/\\/g, '/'));
  if (!fileName || fileName === '.' || fileName === '..') throw new Error('Artifact has no file name to publish under.');
  const { root, folder } = await resolveArtifactsFolder(input.baseFolder, input.setting);
  const bytes = Buffer.from(input.bytes);
  const extension = nodePath.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length) || fileName;
  for (let attempt = 1; attempt <= 999; attempt++) {
    const name = attempt === 1 ? fileName : `${stem}-${attempt}${extension}`;
    const relative = `${folder}/${name}`;
    let existing: Buffer | undefined;
    try {
      existing = await readSandboxedFile(root, relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing && existing.equals(bytes)) {
      return { savedPath: relative, absolutePath: nodePath.join(root, relative), unchanged: true };
    }
    if (!existing) {
      await writeSandboxedFile(root, relative, bytes);
      return { savedPath: relative, absolutePath: nodePath.join(root, relative), unchanged: false };
    }
  }
  throw new Error(`Too many artifacts named ${fileName} in ${folder}.`);
}

/**
 * Lists the files in a project's artifacts folder, subfolders included (a
 * page's `shots/` beside it). Hidden files and symlinks
 * are skipped, and the walk stops at `maxFiles` so a huge folder cannot stall
 * the page. A folder that does not exist yet is simply empty.
 */
export async function listArtifactsFolder(
  root: string,
  folder: string,
  limits: { maxFiles?: number; maxDepth?: number } = {}
): Promise<{ entries: ArtifactsFolderEntry[]; truncated: boolean }> {
  const maxFiles = limits.maxFiles ?? 1000;
  const maxDepth = limits.maxDepth ?? 4;
  const entries: ArtifactsFolderEntry[] = [];
  let truncated = false;
  let start: string;
  try {
    start = await resolveSandboxedPath(root, folder);
  } catch {
    return { entries, truncated };
  }

  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    let children;
    try {
      children = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw error;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
      const childRelative = `${relative}/${child.name}`;
      const childAbsolute = nodePath.join(absolute, child.name);
      if (child.isDirectory()) {
        if (depth < maxDepth) await walk(childAbsolute, childRelative, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      if (entries.length >= maxFiles) {
        truncated = true;
        return;
      }
      const stat = await lstat(childAbsolute).catch(() => undefined);
      if (!stat?.isFile()) continue;
      const entry: ArtifactsFolderEntry = {
        path: childRelative,
        name: child.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
      if (/\.html?$/i.test(child.name)) {
        const title = htmlDocumentTitle(await readHead(childAbsolute));
        if (title) entry.documentTitle = title;
      }
      entries.push(entry);
    }
  };

  await walk(start, folder, 1);
  return { entries, truncated };
}

/** The first bytes of a file — enough for a page's <head> — without reading all of it. */
async function readHead(absolute: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(absolute, 'r').catch(() => undefined);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
