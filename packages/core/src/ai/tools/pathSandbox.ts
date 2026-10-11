import * as nodePath from 'node:path';
import { lstat, realpath, open, stat, mkdir, type FileHandle } from 'node:fs/promises';
import { constants, realpathSync, statSync, readdirSync, type Dirent } from 'node:fs';

export class PathSandboxError extends Error {
  constructor(message: string) { super(message); this.name = 'PathSandboxError'; }
}

function contained(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

/** Lexical containment alone is not permission to read or write a path. */
export function resolveLexicallySandboxedPath(workingDirectory: string, inputPath: string): string {
  const root = nodePath.resolve(workingDirectory);
  const candidate = nodePath.resolve(root, inputPath);
  if (!contained(root, candidate)) throw new PathSandboxError(`Path escapes working directory: ${inputPath}`);
  return candidate;
}

/** Resolve existing links (including ancestors of new files) before filesystem access. */
export async function resolveSandboxedPath(workingDirectory: string, inputPath: string): Promise<string> {
  const candidate = resolveLexicallySandboxedPath(workingDirectory, inputPath);
  const root = await realpath(workingDirectory);
  let ancestor = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      if (!contained(root, resolved)) throw new PathSandboxError(`Path escapes working directory through a symlink: ${inputPath}`);
      return nodePath.join(resolved, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link may point outside the root. Never treat it as a new file.
      const stat = await lstat(ancestor).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== 'ENOENT') throw failure;
        return undefined;
      });
      if (stat?.isSymbolicLink()) throw new PathSandboxError(`Unresolved symlink in working directory: ${inputPath}`);
      const parent = nodePath.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(nodePath.basename(ancestor));
      ancestor = parent;
    }
  }
}


/** Pin a file descriptor and validate its inode before exposing bytes or changing content. */
export async function openSandboxedFile(root: string, inputPath: string, write = false): Promise<FileHandle> {
  const canonicalRoot = await realpath(root);
  let candidate = await resolveSandboxedPath(canonicalRoot, inputPath);
  if (write) {
    await mkdir(nodePath.dirname(candidate), { recursive: true });
    candidate = await resolveSandboxedPath(canonicalRoot, candidate);
  }
  // Never truncate a path before the descriptor has been checked. Exclusive creation
  // prevents a final-component link from being followed when the file is new.
  let handle: FileHandle;
  try { handle = await open(candidate, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW); }
  catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    handle = await open(candidate, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
  }
  try {
    const resolved = await realpath(candidate);
    if (!contained(canonicalRoot, resolved)) throw new PathSandboxError(`Path changed outside working directory: ${inputPath}`);
    const [opened, current] = await Promise.all([handle.stat(), stat(resolved)]);
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw new PathSandboxError(`File changed while opening: ${inputPath}`);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function readSandboxedFile(root: string, inputPath: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  const handle = await openSandboxedFile(root, inputPath);
  try {
    const info = await handle.stat();
    if (info.size > maxBytes) throw new PathSandboxError(`File too large (${info.size} bytes). Max ${maxBytes} bytes.`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new PathSandboxError(`File too large. Max ${maxBytes} bytes.`);
    return bytes;
  } finally { await handle.close(); }
}

export async function writeSandboxedFile(root: string, inputPath: string, content: string): Promise<void> {
  const handle = await openSandboxedFile(root, inputPath, true);
  try { await handle.truncate(0); await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}

/** No permission/coordination await may separate a directory check from its use. */
export function listSandboxedDirectory(root: string, inputPath: string): Dirent[] {
  const canonicalRoot = realpathSync(root);
  const candidate = realpathSync(resolveLexicallySandboxedPath(canonicalRoot, inputPath));
  if (!contained(canonicalRoot, candidate)) throw new PathSandboxError(`Path escapes working directory: ${inputPath}`);
  const before = statSync(candidate);
  const entries = readdirSync(candidate, { withFileTypes: true });
  const afterPath = realpathSync(candidate);
  const after = statSync(afterPath);
  if (!contained(canonicalRoot, afterPath) || before.dev !== after.dev || before.ino !== after.ino) throw new PathSandboxError(`Directory changed while listing: ${inputPath}`);
  return entries;
}
