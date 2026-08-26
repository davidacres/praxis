import type { GitBranchInfo, GitChangedFile, GitCommitNode, GitStatusSnapshot } from './gitGraph';

export function parseGitBranches(raw: string): GitBranchInfo[] {
  return raw.split('\n').map(line => line.trimEnd()).filter(Boolean).flatMap(line => {
    const [ref, tip, head, upstream] = line.split('\0');
    if (!ref || !tip || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/'))) return [];
    const isRemote = ref.startsWith('refs/remotes/');
    return [{ ref, tip, name: ref.replace(/^refs\/(heads|remotes)\//, ''), isRemote, isCurrent: head === '*', ...(upstream ? { upstream } : {}) }];
  });
}

export function parseGitTags(raw: string): Array<{ name: string; tip: string }> {
  return raw.split('\n').filter(Boolean).flatMap(line => {
    const [name, tip] = line.split('\0');
    return name && tip ? [{ name, tip }] : [];
  });
}

export function parseGitLog(raw: string): Array<Pick<GitCommitNode, 'hash' | 'parents' | 'author' | 'date' | 'message'> & { body: string }> {
  return raw.split('\x1e').filter(Boolean).flatMap(record => {
    const [hash, parents, author, date, message, body] = record.replace(/^[\r\n]+/, '').split('\0');
    if (!hash || !author || !date) return [];
    return [{ hash, parents: parents ? parents.split(' ').filter(Boolean) : [], author, date, message: message?.trim() || body?.trim() || '(no message)', body: body?.trim() ?? '' }];
  });
}

export function parseGitStatus(raw: string, repositoryPath: string, branch?: string): GitStatusSnapshot {
  const files: GitChangedFile[] = [];
  const records = raw.split('\0');
  for (let index = 0; index + 1 < records.length; index += 2) {
    const status = records[index];
    const filePath = records[index + 1];
    if (!status || !filePath || status.length < 2) continue;
    files.push({ path: filePath, indexStatus: status[0] ?? ' ', worktreeStatus: status[1] ?? ' ', staged: status[0] !== ' ' && status[0] !== '?' });
  }
  return { repositoryPath, branch, ahead: 0, behind: 0, files };
}
