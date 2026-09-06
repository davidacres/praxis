import * as path from 'node:path';

/**
 * Folder paths inside a workspace file (FX-BE-049).
 *
 * A workspace file is meant to be committed — `stripSecretsFromConnections`
 * exists so "a token must not be the thing that leaks when a workspace file is
 * committed to a repo". But it stored absolute paths, so a shared file resolved
 * on exactly one machine and the stated purpose did not survive the trip.
 *
 * A path **inside the file's own directory tree** is stored relative to the
 * file. A path **outside** it stays absolute: there is nothing sensible to make
 * it relative to, and quietly rewriting it would be worse than being honest
 * that this particular folder is machine-specific.
 *
 * Separators are always POSIX in the file, so one written on macOS opens on
 * Windows.
 */

/** True when `candidate` sits inside `root` (or is `root` itself). */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Shapes a folder path for storage in a workspace file living in
 * `workspaceFileDir`. In-tree paths come back as `./`-prefixed POSIX; anything
 * else is returned unchanged.
 */
export function toPortableFolderPath(absolutePath: string, workspaceFileDir: string): string {
  if (!absolutePath || !workspaceFileDir || !path.isAbsolute(absolutePath)) {
    return absolutePath;
  }
  const root = path.resolve(workspaceFileDir);
  const target = path.resolve(absolutePath);
  if (!isInside(root, target)) {
    return absolutePath;
  }
  const relative = path.relative(root, target).split(path.sep).join('/');
  return relative === '' ? '.' : `./${relative}`;
}

/**
 * Resolves a stored folder path back to an absolute one, against the directory
 * the workspace file was read from. An already-absolute path passes through.
 */
export function resolvePortableFolderPath(storedPath: string, workspaceFileDir: string): string {
  if (!storedPath) {
    return storedPath;
  }
  // A Windows absolute path read on POSIX (or vice versa) is still absolute to
  // the machine that wrote it; leave it be rather than resolving it into a
  // nonsense location under the workspace folder.
  if (path.isAbsolute(storedPath) || /^[A-Za-z]:[\\/]/.test(storedPath)) {
    return storedPath;
  }
  if (!workspaceFileDir) {
    return storedPath;
  }
  return path.resolve(workspaceFileDir, storedPath);
}

/** True when a stored path is portable — i.e. it will resolve wherever the tree is. */
export function isPortableFolderPath(storedPath: string): boolean {
  return !path.isAbsolute(storedPath) && !/^[A-Za-z]:[\\/]/.test(storedPath);
}
