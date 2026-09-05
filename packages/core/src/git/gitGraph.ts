export interface GitCommitNode {
  hash: string;
  shortHash: string;
  parents: string[];
  children: string[];
  author: string;
  date: string;
  message: string;
  branchHints: string[];
  refs: string[];
  lane: number;
  isMerge: boolean;
  isDivergence: boolean;
  isConvergence: boolean;
}

export interface GitBranchInfo {
  name: string;
  ref: string;
  tip: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
}

export interface GitRepositorySnapshot {
  repositoryPath: string;
  repositoryName: string;
  head: string;
  currentBranch?: string;
  branches: GitBranchInfo[];
  tags: string[];
  commits: GitCommitNode[];
  loadedAt: string;
}

export type GitRepositoryPreflightStatus =
  | 'no-workspace'
  | 'missing-folder'
  | 'inaccessible-folder'
  | 'not-a-repository'
  | 'repository'
  | 'worktree'
  | 'bare-repository';

export interface GitRepositoryPreflight {
  status: GitRepositoryPreflightStatus;
  requestedPath?: string;
  repositoryPath?: string;
  repositoryName?: string;
  message: string;
}

export interface GitCommitDetails extends GitCommitNode {
  body: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number; status: string }>;
}

export type GitComparisonKind = 'working' | 'staged' | 'commit' | 'compare';

export interface GitDiffRequest {
  kind: GitComparisonKind;
  /** Commit/ref for a commit diff, or the left side of a comparison. */
  left?: string;
  /** Right side of a two-ref comparison. */
  right?: string;
  path?: string;
  contextLines?: number;
  ignoreWhitespace?: boolean;
}

export type GitDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'binary' | 'unknown';
export type GitDiffLineKind = 'context' | 'addition' | 'deletion' | 'notice';

export interface GitDiffLine {
  kind: GitDiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface GitDiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
  /** A self-contained patch used for safe hunk-level working-tree operations. */
  patch: string;
}

export interface GitDiffFile {
  id: string;
  oldPath?: string;
  newPath?: string;
  displayPath: string;
  status: GitDiffFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffDocument {
  request: GitDiffRequest;
  title: string;
  subtitle: string;
  additions: number;
  deletions: number;
  files: GitDiffFile[];
  generatedAt: string;
}

/** Legacy raw-patch contract retained for existing integrations while the structured viewer rolls out. */
export interface GitDiffResult {
  commit: string;
  path?: string;
  patch: string;
}

export type GitHunkAction = 'stage' | 'unstage' | 'discard';

export interface GitHunkActionRequest {
  action: GitHunkAction;
  path: string;
  patch: string;
}

export interface GitChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  conflicted?: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitConflictFile {
  path: string;
  base: string;
  current: string;
  incoming: string;
  result: string;
  isBinary: boolean;
}

export type GitConflictResolution =
  | { strategy: 'current' | 'incoming' }
  | { strategy: 'manual'; content: string };

/**
 * A file's own text, read straight off the working tree — not a diff against
 * anything. This is the read-only "just let me look at it" case a diff can't
 * serve: a file the session never touched, or one you want to see whole
 * rather than as a hunk.
 */
export interface GitFileContent {
  path: string;
  content: string;
  isBinary: boolean;
  /** Byte size on disk, so a binary or truncated file can say how large it is. */
  size: number;
  /** True once `content` has been cut short — large files are capped rather than shipped whole. */
  truncated: boolean;
}

export interface GitFileHistoryEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBlameLine {
  lineNumber: number;
  commit: string;
  shortHash: string;
  author: string;
  date: string;
  content: string;
}

export interface GitStatusSnapshot {
  repositoryPath: string;
  branch?: string;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
}

export function buildCommitGraph(
  commits: Array<Pick<GitCommitNode, 'hash' | 'parents' | 'author' | 'date' | 'message'>>,
  refs: Map<string, string[]>,
  branches: GitBranchInfo[]
): GitCommitNode[] {
  const byHash = new Map(commits.map(commit => [commit.hash, commit]));
  const children = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      const list = children.get(parent) ?? [];
      list.push(commit.hash);
      children.set(parent, list);
    }
  }
  const branchCommits = new Map<string, Set<string>>();
  for (const branch of branches) {
    const reachable = new Set<string>();
    let cursor: string | undefined = branch.tip;
    while (cursor && !reachable.has(cursor)) {
      reachable.add(cursor);
      cursor = byHash.get(cursor)?.parents[0];
    }
    branchCommits.set(branch.name, reachable);
  }
  const nodes: GitCommitNode[] = [];
  const activeLanes: string[] = [];
  for (const commit of commits) {
    let lane = activeLanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = activeLanes.findIndex(value => !value);
      if (lane < 0) lane = activeLanes.length;
      activeLanes[lane] = commit.hash;
    }
    const childHashes = children.get(commit.hash) ?? [];
    const branchHints = branches.filter(branch => branchCommits.get(branch.name)?.has(commit.hash)).map(branch => branch.name);
    nodes.push({
      ...commit,
      shortHash: commit.hash.slice(0, 8),
      children: childHashes,
      branchHints,
      refs: refs.get(commit.hash) ?? [],
      lane,
      isMerge: commit.parents.length > 1,
      isDivergence: childHashes.length > 1,
      isConvergence: commit.parents.length > 1
    });
    activeLanes[lane] = commit.parents[0] ?? '';
    for (const parent of commit.parents.slice(1)) {
      if (!activeLanes.includes(parent)) activeLanes.push(parent);
    }
  }
  return nodes;
}
