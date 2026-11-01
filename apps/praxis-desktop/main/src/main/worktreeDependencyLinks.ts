import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RemovedDependencyLink {
  /** The link, relative to the worktree. */
  link: string;
  /** Where it pointed. */
  target: string;
}

/**
 * Removes `node_modules` symlinks in a run worktree that point outside it, before a check runs.
 *
 * A stage agent short of packages once linked the worktree's `packages/x/node_modules` to the main
 * checkout's. The install stage's `npm ci` then cleared that directory *through the link*, deleting
 * the main checkout's packages so it no longer built. Removing a link never touches what it points
 * at, and the install stage gives the worktree its own packages, so nothing a run needs is lost.
 *
 * Only `node_modules` directories beside a tracked `package.json` are looked at — the link itself,
 * and the packages directly inside it (including `@scope/` ones). Workspace links into the worktree
 * are left alone.
 */
export async function removeEscapingDependencyLinks(worktreePath: string): Promise<RemovedDependencyLink[]> {
  const root = await fs.realpath(worktreePath);
  const removed: RemovedDependencyLink[] = [];
  for (const dir of await packageDirs(root)) {
    const modules = path.join(root, dir, 'node_modules');
    const stat = await fs.lstat(modules).catch(() => undefined);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      await removeIfEscaping(root, modules, removed);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
      const full = path.join(modules, entry.name);
      if (entry.isSymbolicLink()) await removeIfEscaping(root, full, removed);
      else if (entry.isDirectory() && entry.name.startsWith('@')) {
        for (const scoped of await fs.readdir(full, { withFileTypes: true })) {
          if (scoped.isSymbolicLink()) await removeIfEscaping(root, path.join(full, scoped.name), removed);
        }
      }
    }
  }
  return removed;
}

/** Directories (relative to the worktree) holding a tracked package.json, the worktree root included. */
async function packageDirs(root: string): Promise<string[]> {
  const dirs = new Set<string>(['.']);
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', 'package.json', '*/package.json'], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    for (const file of stdout.split('\0')) {
      if (file && path.posix.basename(file) === 'package.json' && !file.split('/').includes('node_modules')) {
        dirs.add(path.posix.dirname(file));
      }
    }
  } catch {
    // Not a git worktree: the root is still checked.
  }
  return [...dirs];
}

async function removeIfEscaping(root: string, link: string, removed: RemovedDependencyLink[]): Promise<void> {
  const raw = await fs.readlink(link);
  const resolved = path.resolve(path.dirname(link), raw);
  // A dangling link has no real path; judge it by where it says it points.
  const target = await fs.realpath(resolved).catch(() => resolved);
  const relative = path.relative(root, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return;
  await fs.unlink(link);
  removed.push({ link: path.relative(root, link).split(path.sep).join('/'), target });
}
