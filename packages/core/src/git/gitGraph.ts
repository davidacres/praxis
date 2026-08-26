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

export interface GitCommitDetails extends GitCommitNode {
  body: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number; status: string }>;
}

export interface GitDiffResult {
  commit: string;
  path?: string;
  patch: string;
}

export interface GitChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatusSnapshot {
  repositoryPath: string;
  branch?: string;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
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
