import { execFile as execFileCallback } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import {
  buildCommitGraph,
  parseGitBranches,
  parseGitDiff,
  parseGitLog,
  parseGitStatus,
  parseGitTags,
  type GitCommitDetails,
  type GitBlameLine,
  type GitConflictFile,
  type GitConflictResolution,
  type GitDiffDocument,
  type GitDiffRequest,
  type GitDiffResult,
  type GitFileContent,
  type GitHunkActionRequest,
  type GitFileHistoryEntry,
  type GitRepositorySnapshot,
  type GitRepositoryPreflight,
  type GitStatusSnapshot
} from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';

const execFile = util.promisify(execFileCallback);
const MAX_COMMITS = 5000;
/** A file viewer reads the whole file, unlike a diff — cap it so an accidental
 *  open of a generated bundle or log doesn't try to render megabytes of text. */
const MAX_FILE_VIEW_BYTES = 1_000_000;
const CACHE_TTL_MS = 1500;
const repositoryCache = new Map<string, GitRepositorySnapshot>();

async function gitExecutable(): Promise<string> {
  let configuredPath = '';
  try {
    configuredPath = (await getSettingsBackend().read()).git.executablePath.trim();
  } catch {
    // Unit/integration callers can exercise repository discovery before the Electron app has initialised settings.
  }
  return process.env.PRAXIS_GIT_PATH?.trim() || configuredPath || 'git';
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const executable = await gitExecutable();
    const { stdout } = await execFile(executable, args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error as { stderr?: string; code?: number | string };
    const message = detail.stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Git could not complete “${args.slice(0, 2).join(' ')}”: ${message}`);
  }
}

async function gitWithInput(args: string[], cwd: string, input: string): Promise<string> {
  const executable = await gitExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on('data', chunk => { outputSize += chunk.length; if (outputSize <= 32 * 1024 * 1024) stdout.push(chunk); });
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`Git could not complete “${args.slice(0, 2).join(' ')}”: ${Buffer.concat(stderr).toString('utf8').trim() || `exit code ${code}`}`));
    });
    child.stdin.end(input);
  });
}

/**
 * Git is per-project, so the caller must always say which repository it means.
 * This used to fall back to a `PRAXIS_DEFAULT_REPOSITORY` env var and
 * then to `process.cwd()`, which silently resolved against whatever directory
 * the app process was launched from — a repository the user never asked for.
 * Refusing is the honest answer; every caller has the path.
 */
async function resolveRepository(input: string): Promise<string> {
  const candidate = input?.trim();
  if (!candidate) {
    throw new Error('No repository path was supplied. Open Git from a project with a workspace folder.');
  }
  return (await git(['rev-parse', '--show-toplevel'], candidate)).trim();
}

export async function preflightGitRepository(input?: string): Promise<GitRepositoryPreflight> {
  const requestedPath = input?.trim();
  if (!requestedPath) return { status: 'no-workspace', message: 'Attach a project workspace folder before opening Git Graph.' };
  try {
    const stat = await fsp.stat(requestedPath);
    if (!stat.isDirectory()) return { status: 'inaccessible-folder', requestedPath, message: 'The selected workspace is not a folder.' };
  } catch {
    return { status: 'missing-folder', requestedPath, message: 'The project workspace folder could not be found.' };
  }
  try {
    const repositoryPath = (await git(['rev-parse', '--show-toplevel'], requestedPath)).trim();
    const bare = (await git(['rev-parse', '--is-bare-repository'], requestedPath)).trim() === 'true';
    if (bare) return { status: 'bare-repository', requestedPath, repositoryPath, repositoryName: path.basename(repositoryPath), message: 'This is a bare repository. Choose a working checkout to use Git Graph.' };
    const gitDir = (await git(['rev-parse', '--git-dir'], requestedPath)).trim();
    const isWorktree = path.isAbsolute(gitDir) && !gitDir.endsWith('.git');
    return { status: isWorktree ? 'worktree' : 'repository', requestedPath, repositoryPath, repositoryName: path.basename(repositoryPath), message: isWorktree ? 'Git worktree found.' : 'Git repository found.' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const notRepo = /not a git repository/i.test(detail);
    return { status: notRepo ? 'not-a-repository' : 'inaccessible-folder', requestedPath, message: notRepo ? 'This workspace is not a Git repository yet.' : 'Git could not inspect this workspace. Check that the folder is accessible.' };
  }
}

/** The repository's current branch name, or `undefined` on a detached HEAD or a non-repo path. */
export async function getCurrentBranch(repositoryPath: string): Promise<string | undefined> {
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath).catch(() => '')).trim();
  return branch || undefined;
}

export async function initializeGitRepository(repositoryPath: string): Promise<GitRepositoryPreflight> {
  const preflight = await preflightGitRepository(repositoryPath);
  if (preflight.status !== 'not-a-repository') throw new Error(preflight.message);
  await git(['init'], repositoryPath);
  return preflightGitRepository(repositoryPath);
}

export async function cloneGitRepository(repositoryUrl: string, targetParent: string, targetName?: string): Promise<GitRepositoryPreflight> {
  const url = repositoryUrl.trim();
  const parent = targetParent.trim();
  if (!url) throw new Error('Enter a repository URL before cloning.');
  if (!parent) throw new Error('Choose a destination folder before cloning.');
  const name = (targetName?.trim() || path.basename(url.replace(/\\?$/, '').replace(/\.git$/i, ''))).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!name || name === '.' || name === '..') throw new Error('Enter a valid destination folder name.');
  const destination = path.join(parent, name);
  if (await fsp.access(destination).then(() => true).catch(() => false)) throw new Error(`The destination already exists: ${destination}`);
  await git(['clone', url, destination], parent);
  return preflightGitRepository(destination);
}

export async function loadGitRepository(input: string, options?: { force?: boolean }): Promise<GitRepositorySnapshot> {
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
  const operationChecks: Array<[NonNullable<GitStatusSnapshot['operation']>, string]> = [
    ['merge', 'MERGE_HEAD'], ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD']
  ];
  let operation: GitStatusSnapshot['operation'];
  const gitDirectory = (await git(['rev-parse', '--absolute-git-dir'], repositoryPath)).trim();
  for (const [kind, marker] of operationChecks) {
    if (await fsp.access(path.join(gitDirectory, marker)).then(() => true).catch(() => false)) { operation = kind; break; }
  }
  return { ...status, ahead, behind, operation };
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

export async function discardGit(input: string, paths: string[]): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  const status = await getGitStatus(repositoryPath);
  const selected = new Set(paths);
  if (status.files.some(file => selected.has(file.path) && file.indexStatus === '?')) throw new Error('Untracked files are not discarded automatically. Delete them explicitly outside Praxis if they are no longer needed.');
  await git(['restore', '--worktree', '--', ...paths], repositoryPath);
  return getGitStatus(repositoryPath);
}

export async function commitGit(input: string, message: string): Promise<GitRepositorySnapshot> {
  const cleanMessage = message.trim();
  if (!cleanMessage) throw new Error('Enter a commit message before committing.');
  return mutate(input, ['commit', '-m', cleanMessage]);
}

export async function createBranchGit(input: string, name: string, startPoint?: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const cleanName = await validateBranchName(repositoryPath, name);
  const resolvedStart = startPoint ? await resolveCommitish(repositoryPath, startPoint) : undefined;
  return mutate(repositoryPath, ['switch', '-c', cleanName, ...(resolvedStart ? [resolvedStart] : [])]);
}

export async function checkoutGit(input: string, name: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['switch', '--', name]);
}

export async function deleteBranchGit(input: string, name: string): Promise<GitRepositorySnapshot> {
  return mutate(input, ['branch', '-d', '--', name]);
}

async function validateBranchName(repositoryPath: string, name: string): Promise<string> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.startsWith('-')) throw new Error('Enter a valid branch name.');
  await git(['check-ref-format', '--branch', cleanName], repositoryPath);
  return cleanName;
}

export async function renameBranchGit(input: string, oldName: string, newName: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const snapshot = await loadGitRepository(repositoryPath);
  if (!snapshot.branches.some(branch => !branch.isRemote && branch.name === oldName)) throw new Error(`Local branch ${oldName} was not found.`);
  const cleanName = await validateBranchName(repositoryPath, newName);
  return mutate(repositoryPath, ['branch', '-m', '--', oldName, cleanName]);
}

async function mutateAllowingConflicts(input: string, args: string[]): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  try {
    return await mutate(repositoryPath, args);
  } catch (error) {
    const status = await getGitStatus(repositoryPath).catch(() => undefined);
    if (status?.files.some(file => file.conflicted)) return loadGitRepository(repositoryPath, { force: true });
    throw error;
  }
}

export async function mergeGit(input: string, source: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const commit = await resolveCommitish(repositoryPath, source);
  return mutateAllowingConflicts(repositoryPath, ['merge', '--no-edit', commit]);
}

export async function rebaseGit(input: string, target: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const commit = await resolveCommitish(repositoryPath, target);
  return mutateAllowingConflicts(repositoryPath, ['rebase', commit]);
}

export async function cherryPickGit(input: string, commitish: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const commit = await resolveCommitish(repositoryPath, commitish);
  return mutateAllowingConflicts(repositoryPath, ['cherry-pick', commit]);
}

export async function revertGit(input: string, commitish: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  const commit = await resolveCommitish(repositoryPath, commitish);
  return mutateAllowingConflicts(repositoryPath, ['revert', '--no-edit', commit]);
}

export async function stashGit(input: string, message?: string): Promise<GitRepositorySnapshot> {
  const cleanMessage = message?.trim() || `Praxis stash ${new Date().toISOString()}`;
  return mutate(input, ['stash', 'push', '--include-untracked', '-m', cleanMessage]);
}

export async function popGitStash(input: string): Promise<GitRepositorySnapshot> {
  return mutateAllowingConflicts(input, ['stash', 'pop']);
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

async function resolveCommitish(repositoryPath: string, value: string): Promise<string> {
  const candidate = value.trim();
  if (!candidate || candidate.startsWith('-')) throw new Error('Choose a valid commit or branch to compare.');
  return (await git(['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`], repositoryPath)).trim();
}

function comparisonLabels(request: GitDiffRequest): Pick<GitDiffDocument, 'title' | 'subtitle'> {
  switch (request.kind) {
    case 'working': return { title: 'Working changes', subtitle: 'Working tree compared with the staged snapshot' };
    case 'staged': return { title: 'Staged changes', subtitle: 'Staged snapshot compared with HEAD' };
    case 'commit': return { title: request.left ? `Commit ${request.left.slice(0, 8)}` : 'Commit changes', subtitle: 'Selected commit compared with its first parent' };
    case 'compare': return { title: 'Compare revisions', subtitle: `${request.left ?? '?'} → ${request.right ?? '?'}` };
  }
}

export async function getGitComparison(input: string, request: GitDiffRequest): Promise<GitDiffDocument> {
  const repositoryPath = await resolveRepository(input);
  const contextLines = Math.max(0, Math.min(50, Math.round(request.contextLines ?? 3)));
  const common = [`--unified=${contextLines}`, '--no-ext-diff', '--no-color', '--find-renames'];
  if (request.ignoreWhitespace) common.push('--ignore-all-space');
  let args: string[];
  if (request.kind === 'working') {
    args = ['diff', ...common];
  } else if (request.kind === 'staged') {
    args = ['diff', '--cached', ...common];
  } else if (request.kind === 'commit') {
    const commit = await resolveCommitish(repositoryPath, request.left ?? 'HEAD');
    const record = (await git(['rev-list', '--parents', '-n', '1', commit], repositoryPath)).trim().split(/\s+/);
    args = record[1] ? ['diff', ...common, record[1], commit] : ['show', '--format=', ...common, commit];
  } else {
    const left = await resolveCommitish(repositoryPath, request.left ?? 'HEAD');
    const right = await resolveCommitish(repositoryPath, request.right ?? 'HEAD');
    args = ['diff', ...common, left, right];
  }
  if (request.path) args.push('--', request.path);
  let raw = await git(args, repositoryPath);
  if (request.kind === 'working') raw += await untrackedFilePatches(repositoryPath, request.path);
  const files = parseGitDiff(raw);
  const labels = comparisonLabels(request);
  return {
    request,
    ...labels,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
    generatedAt: new Date().toISOString()
  };
}

async function untrackedFilePatches(repositoryPath: string, selectedPath?: string): Promise<string> {
  const paths = (await git(['ls-files', '--others', '--exclude-standard', '-z'], repositoryPath)).split('\0').filter(Boolean).filter(filePath => !selectedPath || filePath === selectedPath);
  const patches: string[] = [];
  for (const filePath of paths.slice(0, 250)) {
    const resolvedPath = path.resolve(repositoryPath, filePath);
    if (!resolvedPath.startsWith(`${repositoryPath}${path.sep}`)) continue;
    const stat = await fsp.stat(resolvedPath).catch(() => undefined);
    if (!stat?.isFile()) continue;
    if (stat.size > 2 * 1024 * 1024) {
      patches.push(`diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ\n`);
      continue;
    }
    const buffer = await fsp.readFile(resolvedPath);
    if (buffer.includes(0)) {
      patches.push(`diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ\n`);
      continue;
    }
    const content = buffer.toString('utf8');
    const lines = content === '' ? [] : content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
    const body = lines.map(line => `+${line}`).join('\n');
    patches.push(`diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`);
  }
  return patches.length ? `\n${patches.join('')}` : '';
}

function assertSafeHunkRequest(request: GitHunkActionRequest): void {
  if (!request.path || path.isAbsolute(request.path) || request.path.split(/[\\/]/).includes('..')) {
    throw new Error('The selected file is outside this repository.');
  }
  const files = parseGitDiff(request.patch);
  if (files.length !== 1 || files[0].displayPath !== request.path || files[0].hunks.length !== 1) {
    throw new Error('The selected change no longer matches this file. Refresh the diff and try again.');
  }
}

export async function applyGitHunk(input: string, request: GitHunkActionRequest): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  assertSafeHunkRequest(request);
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (request.action === 'stage') args.push('--cached');
  if (request.action === 'unstage') args.push('--cached', '--reverse');
  if (request.action === 'discard') args.push('--reverse');
  args.push('-');
  await gitWithInput(args, repositoryPath, request.patch);
  return getGitStatus(repositoryPath);
}

async function safeRepositoryFile(repositoryPath: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error('The selected file is outside this repository.');
  const candidate = path.resolve(repositoryPath, relativePath);
  if (!candidate.startsWith(`${path.resolve(repositoryPath)}${path.sep}`)) throw new Error('The selected file is outside this repository.');
  const parent = await fsp.realpath(path.dirname(candidate));
  const realRepository = await fsp.realpath(repositoryPath);
  if (parent !== realRepository && !parent.startsWith(`${realRepository}${path.sep}`)) throw new Error('The selected file resolves outside this repository.');
  return candidate;
}

async function conflictStage(repositoryPath: string, stage: 1 | 2 | 3, filePath: string): Promise<string> {
  return git(['show', `:${stage}:${filePath}`], repositoryPath).catch(() => '');
}

export async function getGitConflict(input: string, filePath: string): Promise<GitConflictFile> {
  const repositoryPath = await resolveRepository(input);
  const status = await getGitStatus(repositoryPath);
  if (!status.files.some(file => file.path === filePath && file.conflicted)) throw new Error(`${filePath} is no longer conflicted. Refresh the working tree.`);
  const resolvedPath = await safeRepositoryFile(repositoryPath, filePath);
  const [base, current, incoming, resultBuffer] = await Promise.all([
    conflictStage(repositoryPath, 1, filePath),
    conflictStage(repositoryPath, 2, filePath),
    conflictStage(repositoryPath, 3, filePath),
    fsp.readFile(resolvedPath).catch(() => Buffer.from(''))
  ]);
  const result = resultBuffer.toString('utf8');
  return { path: filePath, base, current, incoming, result, isBinary: resultBuffer.includes(0) || current.includes('\0') || incoming.includes('\0') };
}

export async function resolveGitConflict(input: string, filePath: string, resolution: GitConflictResolution): Promise<GitStatusSnapshot> {
  const repositoryPath = await resolveRepository(input);
  const status = await getGitStatus(repositoryPath);
  if (!status.files.some(file => file.path === filePath && file.conflicted)) throw new Error(`${filePath} is no longer conflicted. Refresh the working tree.`);
  if (resolution.strategy === 'manual') {
    if (Buffer.byteLength(resolution.content, 'utf8') > 8 * 1024 * 1024) throw new Error('The resolved file is too large to save safely in Praxis.');
    if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(resolution.content)) {
      throw new Error('Remove every conflict marker before saving the resolved file.');
    }
    const resolvedPath = await safeRepositoryFile(repositoryPath, filePath);
    const existing = await fsp.lstat(resolvedPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error('Praxis cannot write a manual resolution through a symbolic link.');
    await fsp.writeFile(resolvedPath, resolution.content, 'utf8');
  } else {
    await git(['checkout', resolution.strategy === 'current' ? '--ours' : '--theirs', '--', filePath], repositoryPath);
  }
  await git(['add', '--', filePath], repositoryPath);
  return getGitStatus(repositoryPath);
}

export async function abortGitConflict(input: string): Promise<GitRepositorySnapshot> {
  const repositoryPath = await resolveRepository(input);
  repositoryCache.delete(repositoryPath);
  let firstError: unknown;
  let aborted = false;
  for (const args of [['merge', '--abort'], ['rebase', '--abort'], ['cherry-pick', '--abort'], ['revert', '--abort']]) {
    try { await git(args, repositoryPath); aborted = true; break; } catch (error) { firstError ??= error; }
  }
  if (!aborted) throw firstError;
  return loadGitRepository(repositoryPath, { force: true });
}

function assertRepositoryRelativePath(filePath: string): void {
  if (!filePath || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) throw new Error('The selected file is outside this repository.');
}

export async function getGitFileHistory(input: string, filePath: string, ref = 'HEAD'): Promise<GitFileHistoryEntry[]> {
  const repositoryPath = await resolveRepository(input);
  assertRepositoryRelativePath(filePath);
  const commit = await resolveCommitish(repositoryPath, ref);
  const raw = await git(['log', '--follow', '--date=iso-strict', '--format=%H%x00%an%x00%aI%x00%s%x1e', commit, '--', filePath], repositoryPath);
  return raw.split('\x1e').filter(Boolean).flatMap(record => {
    const [hash, author, date, message] = record.replace(/^[\r\n]+/, '').split('\0');
    return hash && author && date ? [{ hash, shortHash: hash.slice(0, 8), author, date, message: message?.trim() || '(no message)' }] : [];
  });
}

export async function getGitBlame(input: string, filePath: string, ref = 'HEAD'): Promise<GitBlameLine[]> {
  const repositoryPath = await resolveRepository(input);
  assertRepositoryRelativePath(filePath);
  const commit = await resolveCommitish(repositoryPath, ref);
  const raw = await git(['blame', '--line-porcelain', commit, '--', filePath], repositoryPath);
  const result: GitBlameLine[] = [];
  let current: Partial<GitBlameLine> = {};
  for (const line of raw.split('\n')) {
    const header = /^([0-9a-f^]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) { current = { commit: header[1], shortHash: header[1].slice(0, 8), lineNumber: Number(header[2]) }; continue; }
    if (line.startsWith('author ')) current.author = line.slice(7);
    else if (line.startsWith('author-time ')) current.date = new Date(Number(line.slice(12)) * 1000).toISOString();
    else if (line.startsWith('\t') && current.commit && current.lineNumber) {
      result.push({ commit: current.commit, shortHash: current.shortHash ?? current.commit.slice(0, 8), lineNumber: current.lineNumber, author: current.author ?? 'Unknown', date: current.date ?? new Date(0).toISOString(), content: line.slice(1) });
      current = {};
    }
  }
  return result;
}

/**
 * A file's own text off the working tree — not a diff. This is the "just let
 * me look at it" case: a file the session never touched, or one you'd rather
 * read whole than as a hunk. Reads the tracked-or-not working copy directly
 * (not a git object), so it shows exactly what's on disk right now, including
 * untracked and locally-modified files.
 */
export async function getGitFileContent(input: string, filePath: string): Promise<GitFileContent> {
  const repositoryPath = await resolveRepository(input);
  const resolvedPath = await safeRepositoryFile(repositoryPath, filePath);
  const stat = await fsp.stat(resolvedPath);
  if (stat.isDirectory()) throw new Error(`${filePath} is a directory, not a file.`);
  const buffer = await fsp.readFile(resolvedPath);
  const isBinary = buffer.subarray(0, 8000).includes(0);
  const truncated = !isBinary && buffer.length > MAX_FILE_VIEW_BYTES;
  const content = isBinary ? '' : buffer.subarray(0, MAX_FILE_VIEW_BYTES).toString('utf8');
  return { path: filePath, content, isBinary, size: stat.size, truncated };
}
