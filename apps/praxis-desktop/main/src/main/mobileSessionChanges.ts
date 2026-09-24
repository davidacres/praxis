/**
 * What a session changed on disk, for the phone (`changes.get` with a session
 * target): the same working-tree view the desktop's Changes tab reads, reduced
 * to relative paths and a bounded diff. The repository path itself never
 * leaves the desktop.
 */
import {
  reportedSessionPaths,
  type AgentSessionRecord,
  type GitChangedFile,
  type GitDiffDocument,
  type GitDiffRequest,
  type GitStatusSnapshot,
  type MobileChangedFile,
  type MobileDiffLine,
  type MobileFileDiff,
  type MobileSessionChanges,
} from '@praxis/core';

/** A phone reads a diff, it does not page through a generated file. */
export const MAX_MOBILE_DIFF_LINES = 600;

export interface MobileSessionChangesGit {
  status(repositoryPath: string): Promise<GitStatusSnapshot>;
  comparison(repositoryPath: string, request: GitDiffRequest): Promise<GitDiffDocument>;
}

/** The session's own repository: its worktree when it ran in one, otherwise its working folder. */
export function sessionRepositoryPath(record: Pick<AgentSessionRecord, 'worktreePath' | 'workingDirectory'>): string | undefined {
  return record.worktreePath?.trim() || record.workingDirectory?.trim() || undefined;
}

function fileStatus(file: GitChangedFile): MobileChangedFile['status'] {
  if (file.conflicted) return 'conflicted';
  const code = (file.worktreeStatus || file.indexStatus || '').trim();
  if (code === '?' || code === '??' || code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  return 'modified';
}

export async function readMobileSessionChanges(record: AgentSessionRecord, git: MobileSessionChangesGit): Promise<MobileSessionChanges> {
  const repositoryPath = sessionRepositoryPath(record);
  if (!repositoryPath) return { sessionId: record.sessionId, repository: false, files: [] };
  let status: GitStatusSnapshot;
  try {
    status = await git.status(repositoryPath);
  } catch {
    // Not a git repository is an ordinary case, not an error worth failing the read.
    return { sessionId: record.sessionId, repository: false, files: [] };
  }
  const reported = reportedSessionPaths(record.events, repositoryPath);
  const files = status.files.map((file): MobileChangedFile => ({
    path: file.path,
    status: fileStatus(file),
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    reportedBySession: reported.has(file.path),
  }));
  // The session's own edits first, then anything else that was already in the tree.
  files.sort((left, right) => Number(right.reportedBySession) - Number(left.reportedBySession) || left.path.localeCompare(right.path));
  return { sessionId: record.sessionId, repository: true, ...(status.branch ? { branch: status.branch } : {}), files };
}

/**
 * One file's diff. The path must be one `git status` reports for the session's
 * repository: a phone can ask to see a change, never to read an arbitrary file.
 */
export async function readMobileSessionFileDiff(
  record: AgentSessionRecord,
  path: string,
  git: MobileSessionChangesGit,
  maxLines = MAX_MOBILE_DIFF_LINES,
): Promise<MobileFileDiff> {
  const repositoryPath = sessionRepositoryPath(record);
  if (!repositoryPath) throw new Error('This session’s folder is not a git repository.');
  const status = await git.status(repositoryPath);
  const file = status.files.find(candidate => candidate.path === path);
  if (!file) throw new Error(`${path} has no uncommitted change in this session’s working tree.`);

  const document = await git.comparison(repositoryPath, { kind: file.staged ? 'staged' : 'working', path });
  const diff = document.files.find(entry => entry.displayPath === path) ?? document.files[0];
  if (!diff) return { path, binary: false, additions: file.additions ?? 0, deletions: file.deletions ?? 0, hunks: [], truncated: false };

  let budget = maxLines;
  let truncated = false;
  const hunks: MobileFileDiff['hunks'][number][] = [];
  for (const hunk of diff.hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const lines: MobileDiffLine[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'notice') continue;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      lines.push({
        kind: line.kind === 'addition' ? 'add' : line.kind === 'deletion' ? 'delete' : 'context',
        text: line.content,
        ...(line.oldLineNumber !== undefined ? { oldLine: line.oldLineNumber } : {}),
        ...(line.newLineNumber !== undefined ? { newLine: line.newLineNumber } : {}),
      });
    }
    hunks.push({ header: hunk.header, lines });
  }
  return { path, binary: diff.isBinary, additions: diff.additions, deletions: diff.deletions, hunks, truncated };
}
