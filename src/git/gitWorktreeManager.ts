import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import type { OutputChannel } from 'vscode';
import type { IssueDetails } from '../types';
import { buildWorktreeName } from '../ai/copilotAgentService';

const execFile = util.promisify(execFileCallback);

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

export class GitWorktreeManager {
  public constructor(private readonly output: Pick<OutputChannel, 'appendLine'>) {}

  public async prepareDeliveryWorktree(
    issue: Pick<IssueDetails, 'key' | 'summary' | 'branch'>,
    baseBranch: string,
    workspacePath: string
  ): Promise<PreparedWorktree> {
    const repoRoot = await readStdout('git', ['rev-parse', '--show-toplevel'], workspacePath);
    if (!repoRoot) {
      throw new Error('Could not resolve the git repository root for the active workspace.');
    }

    const worktreeName = buildWorktreeName(issue);
    const worktreeRoot = path.resolve(repoRoot, '..', '.ticket-manager-worktrees');
    const worktreePath = path.join(worktreeRoot, worktreeName);

    await fs.mkdir(worktreeRoot, { recursive: true });

    try {
      await fs.access(worktreePath);
      throw new Error(`The delivery worktree path already exists: ${worktreePath}`);
    } catch (error) {
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

    this.output.appendLine(`[Delivery] Creating worktree ${worktreeName} from ${baseBranch}.`);
    await execFile('git', ['worktree', 'add', '-b', worktreeName, worktreePath, branchRef], {
      cwd: repoRoot,
      windowsHide: true
    });

    return {
      repoRoot,
      worktreeRoot,
      worktreePath,
      worktreeName,
      branchName: worktreeName,
      baseBranch
    };
  }
}