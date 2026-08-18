import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import type { OutputChannel } from 'vscode';
import type { IssueDetails } from '../types';
import { buildWorktreeName } from '../ai/agentPrompt';

const execFile = util.promisify(execFileCallback);

export class WorktreeConflictError extends Error {
  public readonly worktreePath: string;
  public readonly worktreeName: string;
  constructor(worktreePath: string, worktreeName: string) {
    super(`The delivery worktree path already exists: ${worktreePath}`);
    this.name = 'WorktreeConflictError';
    this.worktreePath = worktreePath;
    this.worktreeName = worktreeName;
  }
}

export interface PreparedWorktree {
  repoRoot: string;
  worktreeRoot: string;
  worktreePath: string;
  worktreeName: string;
  branchName: string;
  baseBranch: string;
}

async function readStdout(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, args, {
    cwd,
    windowsHide: true
  });
  return stdout.trim();
}

async function readOptionalStdout(command: string, args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await readStdout(command, args, cwd);
  } catch {
    return undefined;
  }
}

export function resolveRepoWorktreeRoot(repoRoot: string): string {
  return path.join(repoRoot, '.worktrees');
}

export class GitWorktreeManager {
  public constructor(private readonly output: Pick<OutputChannel, 'appendLine'>) {}

  private async ensureSymlinkSupport(repoRoot: string): Promise<void> {
    if (process.platform !== 'win32') {
      return;
    }

    const currentValue = (await readOptionalStdout('git', ['config', '--get', 'core.symlinks'], repoRoot))
      ?.trim()
      .toLowerCase();
    if (currentValue === 'true') {
      return;
    }

    this.output.appendLine('[Delivery] Enabling git core.symlinks=true for worktree checkouts.');
    await execFile('git', ['config', '--local', 'core.symlinks', 'true'], {
      cwd: repoRoot,
      windowsHide: true
    });
  }

  public async prepareDeliveryWorktree(
    issue: Pick<IssueDetails, 'key' | 'summary' | 'branch'>,
    baseBranch: string,
    workspacePath: string,
    options?: { forceClean?: boolean }
  ): Promise<PreparedWorktree> {
    const repoRoot = await readStdout('git', ['rev-parse', '--show-toplevel'], workspacePath);
    if (!repoRoot) {
      throw new Error('Could not resolve the git repository root for the active workspace.');
    }

    const worktreeName = buildWorktreeName(issue);
    const worktreeRoot = resolveRepoWorktreeRoot(repoRoot);
    const worktreePath = path.join(worktreeRoot, worktreeName);

    await fs.mkdir(worktreeRoot, { recursive: true });

    try {
      await fs.access(worktreePath);
      if (options?.forceClean) {
        this.output.appendLine(`[Delivery] Force-cleaning existing worktree ${worktreeName}.`);
        await this.removeWorktree(repoRoot, worktreePath, worktreeName);
      } else {
        throw new WorktreeConflictError(worktreePath, worktreeName);
      }
    } catch (error) {
      if (error instanceof WorktreeConflictError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const branchRef = await readStdout('git', ['rev-parse', '--verify', baseBranch], repoRoot).catch(async () => {
      return readStdout('git', ['rev-parse', '--verify', `origin/${baseBranch}`], repoRoot);
    });
    if (!branchRef) {
      throw new Error(`Base branch ${baseBranch} was not found locally or on origin.`);
    }

    await this.ensureSymlinkSupport(repoRoot);
    this.output.appendLine(`[Delivery] Creating worktree ${worktreeName} from ${baseBranch}.`);
    await execFile('git', ['-c', 'core.symlinks=true', 'worktree', 'add', '-b', worktreeName, worktreePath, branchRef], {
      cwd: repoRoot,
      windowsHide: true
    });

    await this.replicateGithubSymlinks(repoRoot, worktreePath);

    return {
      repoRoot,
      worktreeRoot,
      worktreePath,
      worktreeName,
      branchName: worktreeName,
      baseBranch
    };
  }

  /**
   * Merge a sub-task branch into the feature branch from the main repo root.
   * Uses --no-ff to create a merge commit for traceability.
   * After merging, pushes the feature branch and cleans up the sub-task worktree/branch.
   */
  public async mergeSubTaskBranch(
    workspacePath: string,
    subTaskBranch: string,
    featureBranch: string,
    subTaskWorktreePath: string,
    options?: { gitExtraArgs?: string[] }
  ): Promise<{ mergeCommit: string }> {
    const repoRoot = await readStdout('git', ['rev-parse', '--show-toplevel'], workspacePath);

    // Fetch latest to ensure we have current state of both branches
    await execFile('git', ['fetch', 'origin'], { cwd: repoRoot, windowsHide: true });

    // Check out the feature branch in the main repo to perform the merge
    const currentBranch = await readStdout('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);

    await execFile('git', ['checkout', featureBranch], { cwd: repoRoot, windowsHide: true });
    try {
      // Pull latest feature branch changes
      await execFile('git', ['pull', '--ff-only', 'origin', featureBranch], { cwd: repoRoot, windowsHide: true }).catch(() => {
        // May fail if no upstream tracking yet — that's OK
      });

      // Merge the sub-task branch with a merge commit
      await execFile(
        'git',
        ['merge', '--no-ff', '-m', `Merge ${subTaskBranch} into ${featureBranch}`, subTaskBranch],
        { cwd: repoRoot, windowsHide: true }
      );

      const mergeCommit = await readStdout('git', ['rev-parse', 'HEAD'], repoRoot);

      // Push the feature branch with the merge
      const pushArgs = [...(options?.gitExtraArgs ?? []), 'push', 'origin', featureBranch];
      await execFile('git', pushArgs, { cwd: repoRoot, windowsHide: true });

      this.output.appendLine(
        `[Delivery] Merged ${subTaskBranch} into ${featureBranch} (commit: ${mergeCommit.slice(0, 8)}).`
      );

      // Clean up: remove the sub-task worktree and branch
      await this.removeWorktree(repoRoot, subTaskWorktreePath, subTaskBranch);

      return { mergeCommit };
    } catch (mergeError) {
      // If merge fails, abort it and restore state
      await execFile('git', ['merge', '--abort'], { cwd: repoRoot, windowsHide: true }).catch(() => {});
      throw mergeError;
    } finally {
      // Restore original branch
      if (currentBranch && currentBranch !== featureBranch) {
        await execFile('git', ['checkout', currentBranch], { cwd: repoRoot, windowsHide: true }).catch(() => {
          // Best-effort restore
        });
      }
    }
  }

  /**
   * Recreates filesystem symlinks found under the main repo's `.github/` tree
   * inside the freshly created worktree. Targets are written as *absolute*
   * paths so they keep resolving even though the worktree lives at a different
   * depth than the main checkout. These symlinks are typically untracked
   * (pointing outside the repo), which is why `git worktree add` does not
   * materialize them on its own.
   */
  private async replicateGithubSymlinks(repoRoot: string, worktreePath: string): Promise<void> {
    const sourceRoot = path.join(repoRoot, '.github');
    let sourceExists = false;
    try {
      const stat = await fs.stat(sourceRoot);
      sourceExists = stat.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.output.appendLine(`[Delivery] Could not inspect ${sourceRoot}: ${(error as Error).message}`);
      }
      return;
    }
    if (!sourceExists) {
      return;
    }

    const symlinks = await this.findSymlinks(sourceRoot);
    if (symlinks.length === 0) {
      return;
    }

    const destRoot = path.join(worktreePath, '.github');
    let restored = 0;
    for (const entry of symlinks) {
      const relPath = path.relative(sourceRoot, entry.linkPath);
      const destPath = path.join(destRoot, relPath);
      try {
        await this.materializeSymlink(entry.linkPath, entry.absoluteTarget, destPath);
        restored += 1;
        this.output.appendLine(
          `[Delivery] Replicated symlink .github/${relPath.replaceAll('\\', '/')} -> ${entry.absoluteTarget}`
        );
      } catch (error) {
        this.output.appendLine(
          `[Delivery] Failed to replicate symlink .github/${relPath.replaceAll('\\', '/')}: ${(error as Error).message}`
        );
      }
    }
    if (restored > 0) {
      this.output.appendLine(`[Delivery] Replicated ${restored} .github symlink(s) into worktree.`);
    }
  }

  private async findSymlinks(root: string): Promise<Array<{ linkPath: string; absoluteTarget: string }>> {
    const results: Array<{ linkPath: string; absoluteTarget: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        this.output.appendLine(`[Delivery] Could not read ${dir}: ${(error as Error).message}`);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const rawTarget = await fs.readlink(full);
            const absoluteTarget = path.isAbsolute(rawTarget)
              ? rawTarget
              : path.resolve(path.dirname(full), rawTarget);
            results.push({ linkPath: full, absoluteTarget });
          } catch (error) {
            this.output.appendLine(`[Delivery] Could not read symlink ${full}: ${(error as Error).message}`);
          }
          // Do not descend into the symlink contents; the link itself is what
          // gets replicated and it will transparently expose the target tree.
          continue;
        }
        if (entry.isDirectory()) {
          await walk(full);
        }
      }
    };
    await walk(root);
    return results;
  }

  private async materializeSymlink(
    originalLinkPath: string,
    absoluteTarget: string,
    destPath: string
  ): Promise<void> {
    await this.clearDestPath(destPath);

    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const { isDirectory, exists } = await this.inspectTarget(originalLinkPath);

    if (process.platform === 'win32') {
      await this.createWindowsSymlink(absoluteTarget, destPath, isDirectory);
      return;
    }

    if (!exists) {
      this.output.appendLine(`[Delivery] Warning: replicating dangling symlink to ${absoluteTarget}.`);
    }
    await fs.symlink(absoluteTarget, destPath);
  }

  private async clearDestPath(destPath: string): Promise<void> {
    try {
      await fs.lstat(destPath);
      // Something is there — a symlink (possibly git-materialized with a
      // relative target that doesn't resolve from the worktree depth), a
      // placeholder file, or a directory. Remove it unconditionally so the
      // caller can drop in a fresh absolute-target symlink.
      await fs.rm(destPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async inspectTarget(originalLinkPath: string): Promise<{ isDirectory: boolean; exists: boolean }> {
    try {
      const targetStat = await fs.stat(originalLinkPath);
      return { isDirectory: targetStat.isDirectory(), exists: true };
    } catch {
      return { isDirectory: false, exists: false };
    }
  }

  private async createWindowsSymlink(
    absoluteTarget: string,
    destPath: string,
    isDirectory: boolean
  ): Promise<void> {
    const linkType: 'dir' | 'file' = isDirectory ? 'dir' : 'file';
    try {
      await fs.symlink(absoluteTarget, destPath, linkType);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' && isDirectory) {
        // Junctions do not require SeCreateSymbolicLink privilege and behave
        // like directory symlinks for read access. Only valid for directories.
        await fs.symlink(absoluteTarget, destPath, 'junction');
        return;
      }
      if (code === 'EPERM') {
        throw new Error(
          `Creating a file symlink at ${destPath} was denied. Enable Windows Developer Mode or run the editor with symlink privilege so .github symlinks can be replicated into the worktree.`
        );
      }
      throw error;
    }
  }

  /**
   * Removes an existing worktree and its branch so a fresh one can be created.
   */
  private async removeWorktree(repoRoot: string, worktreePath: string, branchName: string): Promise<void> {
    try {
      await execFile('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoRoot,
        windowsHide: true
      });
    } catch {
      // git worktree remove may fail if the worktree is corrupted — fall back to manual cleanup
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch { /* best effort */ }
      await execFile('git', ['worktree', 'prune'], { cwd: repoRoot, windowsHide: true }).catch(() => {});
    }
    // Delete the branch so `worktree add -b` can recreate it
    try {
      await execFile('git', ['branch', '-D', branchName], {
        cwd: repoRoot,
        windowsHide: true
      });
    } catch { /* branch may not exist */ }
  }
}