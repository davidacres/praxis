import { execFile as execFileCallback } from 'node:child_process';
import * as path from 'node:path';
import * as util from 'node:util';
import { buildCommitGraph, parseGitBranches, parseGitLog, parseGitStatus, parseGitTags, type GitCommitDetails, type GitDiffResult, type GitRepositorySnapshot, type GitStatusSnapshot } from '@ticket-manager/core';
import { getSettingsBackend } from './settingsBackendInstance';

const execFile = util.promisify(execFileCallback);
const MAX_COMMITS = 5000;
const CACHE_TTL_MS = 1500;
const repositoryCache = new Map<string, GitRepositorySnapshot>();

async function git(args: string[], cwd: string): Promise<string> {
  try {
    let configuredPath = '';
    try {
      configuredPath = (await getSettingsBackend().read()).git.executablePath.trim();
    } catch {
      // Unit/integration callers can exercise repository discovery before the Electron app has initialised settings.
    }
    const executable = process.env.TICKET_MANAGER_GIT_PATH?.trim() || configuredPath || 'git';
    const { stdout } = await execFile(executable, args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error as { stderr?: string; code?: number | string };
    const message = detail.stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Git could not complete “${args.slice(0, 2).join(' ')}”: ${message}`);
  }
}

async function resolveRepository(input?: string): Promise<string> {
  const candidate = input?.trim() || process.cwd();
  return (await git(['rev-parse', '--show-toplevel'], candidate)).trim();
}

export async function loadGitRepository(input?: string, options?: { force?: boolean }): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const cached = repositoryCache.get(repositoryPath);
  if (cached && !options?.force && Date.now() - Date.parse(cached.loadedAt) < CACHE_TTL_MS) return cached;
  const [head, currentBranchRaw, branchRaw, tagRaw, logRaw] = await Promise.all([
    git(['rev-parse', 'HEAD'], repositoryPath),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath).catch(() => ''),
    git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes'], repositoryPath),
    git(['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/tags'], repositoryPath),
    git(['log', '--all', '--date=iso-strict', `--max-count=${MAX_COMMITS}`, '--pretty=format:%H%x00%P%x00%an%x00%aI%x00%s%x00%b%x1e'], repositoryPath)
  ]);
  const branches = parseGitBranches(branchRaw);
  const parsedTags = parseGitTags(tagRaw);
  const tags = parsedTags.map(tag => tag.name);
  const refs = new Map<string, string[]>();
  for (const branch of branches) refs.set(branch.tip, [...(refs.get(branch.tip) ?? []), branch.name]);
  for (const tag of parsedTags) refs.set(tag.tip, [...(refs.get(tag.tip) ?? []), `tag:${tag.name}`]);
  const commits = parseGitLog(logRaw);
  const snapshot = {
    repositoryPath,
    repositoryName: path.basename(repositoryPath),
    head: head.trim(),
    currentBranch: currentBranchRaw.trim() || undefined,
    branches,
    tags,
    commits: buildCommitGraph(commits, refs, branches),
    loadedAt: new Date().toISOString()
  };
  repositoryCache.set(repositoryPath, snapshot);
  return snapshot;
}

export async function getGitStatus(input: string): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath).catch(() => '');
  const status = parseGitStatus(await git(['status', '--porcelain=v1', '-z'], repositoryPath), repositoryPath, branch.trim() || undefined);
  const tracking = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repositoryPath).catch(() => '');
  const [behind, ahead] = tracking.trim().split(/\s+/).map(value => Number(value) || 0);
  return { ...status, ahead, behind };
}

async function mutate(input: string, args: string[]): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  repositoryCache.delete(repositoryPath);
  await git(args, repositoryPath);
  return loadGitRepository(repositoryPath, { force: true });
}

export async function stageGit(input: string, paths: string[]): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  await git(['add', '--', ...paths], repositoryPath);
  return getGitStatus(repositoryPath);
}

export async function unstageGit(input: string, paths: string[]): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  await git(['restore', '--staged', '--', ...paths], repositoryPath);
  return getGitStatus(repositoryPath);
}

export async function commitGit(input: string, message: string): Promise<GitRepositorySnapshot> {
  const cleanMessage = message.trim();
  if (!cleanMessage) throw new Error('Enter a commit message before committing.');
  return mutate(input, ['commit', '-m', cleanMessage]);
}

export async function createBranchGit(input: string, name: string, startPoint?: string): Promise<GitRepositorySnapshot> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.startsWith('-')) throw new Error('Enter a valid branch name.');
  return mutate(input, ['switch', '-c', cleanName, ...(startPoint ? [startPoint] : [])]);
}

export async function checkoutGit(input: string, name: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['switch', '--', name]);
}

export async function deleteBranchGit(input: string, name: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['branch', '-d', '--', name]);
}

export async function pullGit(input: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['pull', '--ff-only']);
}

export async function fetchGit(input: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['fetch', '--all', '--prune']);
}

export async function pushGit(input: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['push']);
}

export async function getGitCommit(repositoryPath: string, hash: string): Promise<GitCommitDetails> {
  const snapshot = await loadGitRepository(repositoryPath);
  const node = snapshot.commits.find(commit => commit.hash === hash);
  if (!node) throw new Error(`Commit ${hash.slice(0, 8)} was not found in this repository.`);
  const raw = await git(['show', '--format=%B', '--numstat', '--no-renames', '--no-ext-diff', hash], snapshot.repositoryPath);
  const lines = raw.split('\n');
  const changedFiles = lines.slice(1).map(line => {
    const match = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line);
    if (!match) return undefined;
    return { additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]), path: match[3], status: 'modified' };
  }).filter((file): file is NonNullable<typeof file> => Boolean(file));
  return { ...node, body: lines.slice(0, Math.max(1, lines.findIndex(line => /^\d+\s/.test(line)))).join('\n').trim(), changedFiles };
}

export async function getGitDiff(repositoryPath: string, hash: string, filePath?: string): Promise<GitDiffResult> {
  const args = ['show', '--format=fuller', '--no-ext-diff', '--patch', hash];
  if (filePath) args.push('--', filePath);
  return { commit: hash, path: filePath, patch: await git(args, await resolveRepository(repositoryPath)) };
}
