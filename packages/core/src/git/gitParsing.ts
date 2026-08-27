import type {
  GitBranchInfo,
  GitChangedFile,
  GitCommitNode,
  GitDiffFile,
  GitDiffFileStatus,
  GitDiffHunk,
  GitDiffLine,
  GitStatusSnapshot
} from './gitGraph';

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
  const records = raw.split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    // Real `status --porcelain=v1 -z` records are `XY path\0`; keep support for
    // the older split test fixture shape while callers migrate.
    const splitShape = record.length === 2 && index + 1 < records.length;
    const status = splitShape ? record : record.slice(0, 2);
    const filePath = splitShape ? records[++index] : record.slice(3);
    if (!filePath || status.length < 2) continue;
    const conflicted = status === 'DD' || status === 'AU' || status === 'UD' || status === 'UA' || status === 'DU' || status === 'AA' || status === 'UU';
    files.push({ path: filePath, indexStatus: status[0] ?? ' ', worktreeStatus: status[1] ?? ' ', staged: !conflicted && status[0] !== ' ' && status[0] !== '?', conflicted });
    // Rename/copy records include the original path as the following NUL record.
    if (!splitShape && (status[0] === 'R' || status[0] === 'C') && index + 1 < records.length) index += 1;
  }
  return { repositoryPath, branch, ahead: 0, behind: 0, files };
}

function normalizeDiffPath(value: string): string | undefined {
  const cleaned = value.trim().replace(/^"|"$/g, '');
  if (cleaned === '/dev/null') return undefined;
  return cleaned.replace(/^[ab]\//, '');
}

function statusFromHeaders(headers: string[], oldPath?: string, newPath?: string): GitDiffFileStatus {
  if (headers.some(line => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))) return 'binary';
  if (headers.some(line => line.startsWith('new file mode ')) || (!oldPath && Boolean(newPath))) return 'added';
  if (headers.some(line => line.startsWith('deleted file mode ')) || (Boolean(oldPath) && !newPath)) return 'deleted';
  if (headers.some(line => line.startsWith('rename from '))) return 'renamed';
  if (headers.some(line => line.startsWith('copy from '))) return 'copied';
  return oldPath || newPath ? 'modified' : 'unknown';
}

function parseHunk(header: string, body: string[], fileHeader: string, fileIndex: number, hunkIndex: number): GitDiffHunk | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldLines = Number(match[2] ?? 1);
  const newStart = Number(match[3]);
  const newLines = Number(match[4] ?? 1);
  let oldLine = oldStart;
  let newLine = newStart;
  const lines: GitDiffLine[] = body.map(rawLine => {
    if (rawLine.startsWith('+')) return { kind: 'addition', content: rawLine.slice(1), newLineNumber: newLine++ };
    if (rawLine.startsWith('-')) return { kind: 'deletion', content: rawLine.slice(1), oldLineNumber: oldLine++ };
    if (rawLine.startsWith(' ')) return { kind: 'context', content: rawLine.slice(1), oldLineNumber: oldLine++, newLineNumber: newLine++ };
    return { kind: 'notice', content: rawLine };
  });
  return {
    id: `file-${fileIndex}-hunk-${hunkIndex}`,
    header,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
    patch: `${fileHeader}${header}\n${body.join('\n')}\n`
  };
}

/** Parse the stable unified patch emitted by Git into a renderer-safe document model. */
export function parseGitDiff(raw: string): GitDiffFile[] {
  if (!raw.trim()) return [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => { if (line.startsWith('diff --git ')) starts.push(index); });
  return starts.flatMap((start, fileIndex) => {
    const end = starts[fileIndex + 1] ?? lines.length;
    const section = lines.slice(start, end);
    const firstHunk = section.findIndex(line => line.startsWith('@@ '));
    const headerEnd = firstHunk >= 0 ? firstHunk : section.length;
    const headers = section.slice(0, headerEnd);
    const minusHeader = headers.find(line => line.startsWith('--- '));
    const plusHeader = headers.find(line => line.startsWith('+++ '));
    const renameFrom = headers.find(line => line.startsWith('rename from '));
    const renameTo = headers.find(line => line.startsWith('rename to '));
    const diffMatch = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(headers[0] ?? '');
    const oldPath = normalizeDiffPath(renameFrom?.slice(12) ?? minusHeader?.slice(4) ?? diffMatch?.[1] ?? '');
    const newPath = normalizeDiffPath(renameTo?.slice(10) ?? plusHeader?.slice(4) ?? diffMatch?.[2] ?? '');
    const displayPath = newPath ?? oldPath;
    if (!displayPath) return [];
    const fileHeader = `${headers.join('\n')}\n`;
    const hunks: GitDiffHunk[] = [];
    let cursor = firstHunk;
    while (cursor >= 0 && cursor < section.length) {
      const header = section[cursor];
      if (!header.startsWith('@@ ')) { cursor += 1; continue; }
      let next = cursor + 1;
      while (next < section.length && !section[next].startsWith('@@ ')) next += 1;
      const hunk = parseHunk(header, section.slice(cursor + 1, next).filter((line, index, values) => index < values.length - 1 || line !== ''), fileHeader, fileIndex, hunks.length);
      if (hunk) hunks.push(hunk);
      cursor = next;
    }
    const additions = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'addition').length, 0);
    const deletions = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'deletion').length, 0);
    const status = statusFromHeaders(headers, oldPath, newPath);
    const file: GitDiffFile = {
      id: `file-${fileIndex}`,
      oldPath,
      newPath,
      displayPath,
      status,
      additions,
      deletions,
      isBinary: status === 'binary',
      hunks
    };
    return [file];
  });
}

/** Build an applicable patch containing only selected added/removed lines from one parsed hunk. */
export function buildPartialHunkPatch(hunk: GitDiffHunk, selectedIndexes: number[]): string {
  const selected = new Set(selectedIndexes);
  const headerIndex = hunk.patch.indexOf(hunk.header);
  const fileHeader = headerIndex >= 0 ? hunk.patch.slice(0, headerIndex) : '';
  const body: string[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind === 'context') body.push(` ${line.content}`);
    else if (line.kind === 'notice') body.push(line.content);
    else if (selected.has(index)) body.push(`${line.kind === 'addition' ? '+' : '-'}${line.content}`);
    else if (line.kind === 'deletion') body.push(` ${line.content}`);
  });
  const oldLines = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length;
  const newLines = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length;
  const suffix = hunk.header.replace(/^@@[^@]*@@/, '');
  const header = `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@${suffix}`;
  return `${fileHeader}${header}\n${body.join('\n')}\n`;
}
