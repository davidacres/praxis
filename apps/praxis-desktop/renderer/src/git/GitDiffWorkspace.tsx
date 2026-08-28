import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitBlameLine, GitDiffDocument, GitDiffFile, GitDiffHunk, GitDiffLine, GitDiffRequest, GitFileHistoryEntry, GitHunkAction } from '@praxis/core';

export type GitDiffViewMode = 'inline' | 'split' | 'hunks';

interface GitDiffWorkspaceProps {
  repositoryPath: string;
  request: GitDiffRequest;
  initialPath?: string;
  onClose: () => void;
  onStatusChanged?: () => void | Promise<void>;
}

const STATUS_LABELS: Record<GitDiffFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  binary: 'Binary',
  unknown: 'Changed'
};

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function directoryName(path: string): string {
  const pieces = path.split('/');
  return pieces.length > 1 ? pieces.slice(0, -1).join('/') : '';
}

function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React', css: 'CSS', json: 'JSON', md: 'Markdown', cs: 'C#', py: 'Python', sh: 'Shell', html: 'HTML', yml: 'YAML', yaml: 'YAML' } as Record<string, string>)[extension ?? ''] ?? (extension?.toUpperCase() || 'Text');
}

function highlightCode(value: string): ReactNode {
  const pattern = /(\/\/.*$|#.*$|`[^`]*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|true|false|null|undefined|public|private|protected|readonly|extends|implements|using|namespace)\b|\b\d+(?:\.\d+)?\b)/gm;
  return value.split(pattern).map((part, index) => {
    if (!part) return null;
    const className = part.startsWith('//') || part.startsWith('#') ? 'comment'
      : /^['"`]/.test(part) ? 'string'
      : /^\d/.test(part) ? 'number'
      : /^(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|true|false|null|undefined|public|private|protected|readonly|extends|implements|using|namespace)$/.test(part) ? 'keyword'
      : undefined;
    return className ? <span className={`git-code-${className}`} key={index}>{part}</span> : part;
  });
}

function changedContent(before: string | undefined, after: string | undefined, side: 'before' | 'after'): ReactNode {
  const value = side === 'before' ? before ?? '' : after ?? '';
  const other = side === 'before' ? after ?? '' : before ?? '';
  if (!value || !other) return highlightCode(value);
  let prefix = 0;
  while (prefix < value.length && prefix < other.length && value[prefix] === other[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < value.length - prefix && suffix < other.length - prefix && value[value.length - suffix - 1] === other[other.length - suffix - 1]) suffix += 1;
  if (prefix === value.length && suffix === 0) return highlightCode(value);
  const middleEnd = suffix ? value.length - suffix : value.length;
  return <>{highlightCode(value.slice(0, prefix))}<mark>{highlightCode(value.slice(prefix, middleEnd))}</mark>{highlightCode(value.slice(middleEnd))}</>;
}

interface SplitRow {
  left?: GitDiffLine;
  right?: GitDiffLine;
}

function splitRows(lines: GitDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'context' || line.kind === 'notice') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const deletions: GitDiffLine[] = [];
    const additions: GitDiffLine[] = [];
    while (index < lines.length && lines[index].kind === 'deletion') deletions.push(lines[index++]);
    while (index < lines.length && lines[index].kind === 'addition') additions.push(lines[index++]);
    if (deletions.length === 0 && additions.length === 0) {
      rows.push({ left: line.kind === 'deletion' ? line : undefined, right: line.kind === 'addition' ? line : undefined });
      index += 1;
      continue;
    }
    const count = Math.max(deletions.length, additions.length);
    for (let pair = 0; pair < count; pair += 1) rows.push({ left: deletions[pair], right: additions[pair] });
  }
  return rows;
}

function ChangeLine({ line, wrap, selectable, selected, onToggle }: { line: GitDiffLine; wrap: boolean; selectable?: boolean; selected?: boolean; onToggle?: () => void }) {
  const marker = line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' ';
  return <div className={`git-diff-line ${line.kind}${wrap ? ' wrap' : ''}`}>
    <span className="git-diff-old-number">{line.oldLineNumber ?? ''}</span>
    <span className="git-diff-new-number">{line.newLineNumber ?? ''}</span>
    <span className="git-diff-marker">{selectable ? <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`${selected ? 'Exclude' : 'Include'} ${line.kind} line`} /> : marker}</span>
    <code>{highlightCode(line.content)}</code>
  </div>;
}

function InlineHunk({ hunk, wrap, mode, comparisonKind, busy, selectedLines, onToggleLine, onAction, onSelectedAction }: { hunk: GitDiffHunk; wrap: boolean; mode: GitDiffViewMode; comparisonKind: GitDiffRequest['kind']; busy?: string; selectedLines: Set<string>; onToggleLine: (key: string) => void; onAction: (action: GitHunkAction, hunk: GitDiffHunk) => void; onSelectedAction: (action: GitHunkAction, hunk: GitDiffHunk, indexes: number[]) => void }) {
  const selectedIndexes = hunk.lines.flatMap((line, index) => selectedLines.has(`${hunk.id}:${index}`) && (line.kind === 'addition' || line.kind === 'deletion') ? [index] : []);
  const action = comparisonKind === 'staged' ? 'unstage' : 'stage';
  return <section className="git-diff-hunk" id={hunk.id} data-diff-hunk>
    <header>
      <code>{hunk.header}</code>
      {(mode === 'hunks' || mode === 'inline') && <div className="git-hunk-actions">
        {mode === 'hunks' && selectedIndexes.length > 0 && <button className="selected-lines" disabled={Boolean(busy)} onClick={() => onSelectedAction(action, hunk, selectedIndexes)}>{comparisonKind === 'staged' ? 'Unstage' : 'Stage'} {selectedIndexes.length} selected</button>}
        {mode === 'hunks' && comparisonKind === 'working' && selectedIndexes.length > 0 && <button className="danger" disabled={Boolean(busy)} onClick={() => onSelectedAction('discard', hunk, selectedIndexes)}>Discard selected</button>}
        {comparisonKind === 'working' && <button disabled={Boolean(busy)} data-hunk-action="stage" onClick={() => onAction('stage', hunk)}>Stage hunk</button>}
        {comparisonKind === 'staged' && <button disabled={Boolean(busy)} data-hunk-action="unstage" onClick={() => onAction('unstage', hunk)}>Unstage hunk</button>}
        {comparisonKind === 'working' && <button disabled={Boolean(busy)} className="danger" data-hunk-action="discard" onClick={() => onAction('discard', hunk)}>Discard</button>}
      </div>}
    </header>
    {hunk.lines.map((line, index) => <ChangeLine line={line} wrap={wrap} selectable={mode === 'hunks' && (line.kind === 'addition' || line.kind === 'deletion')} selected={selectedLines.has(`${hunk.id}:${index}`)} onToggle={() => onToggleLine(`${hunk.id}:${index}`)} key={`${hunk.id}-${index}`} />)}
  </section>;
}

function SplitHunk({ hunk, wrap }: { hunk: GitDiffHunk; wrap: boolean }) {
  return <section className="git-diff-hunk git-diff-split-hunk" id={hunk.id} data-diff-hunk>
    <header><code>{hunk.header}</code></header>
    {splitRows(hunk.lines).map((row, index) => <div className="git-diff-split-row" key={`${hunk.id}-split-${index}`}>
      <div className={`git-diff-split-cell ${row.left?.kind ?? 'empty'}${wrap ? ' wrap' : ''}`}>
        <span>{row.left?.oldLineNumber ?? ''}</span><code>{row.left ? changedContent(row.left.content, row.right?.content, 'before') : ''}</code>
      </div>
      <div className={`git-diff-split-cell ${row.right?.kind ?? 'empty'}${wrap ? ' wrap' : ''}`}>
        <span>{row.right?.newLineNumber ?? ''}</span><code>{row.right ? changedContent(row.left?.content, row.right.content, 'after') : ''}</code>
      </div>
    </div>)}
  </section>;
}

function buildSelectedLinePatch(hunk: GitDiffHunk, selectedIndexes: number[]): string {
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
  return `${fileHeader}@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@${suffix}\n${body.join('\n')}\n`;
}

export function GitDiffWorkspace({ repositoryPath, request, initialPath, onClose, onStatusChanged }: GitDiffWorkspaceProps) {
  const [document, setDocument] = useState<GitDiffDocument>();
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [viewMode, setViewMode] = useState<GitDiffViewMode>('split');
  const [wrap, setWrap] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [activeHunk, setActiveHunk] = useState(0);
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set());
  const [auxiliaryView, setAuxiliaryView] = useState<'history' | 'blame'>();
  const [fileHistory, setFileHistory] = useState<GitFileHistoryEntry[]>([]);
  const [blame, setBlame] = useState<GitBlameLine[]>([]);
  const [auxiliaryLoading, setAuxiliaryLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const contextLines = viewMode === 'hunks' ? 3 : viewMode === 'split' ? 8 : 20;
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.praxis.git.getComparison(repositoryPath, { ...request, contextLines, ignoreWhitespace });
      setDocument(next);
      setSelectedFileId(current => {
        if (current && next.files.some(file => file.id === current)) return current;
        return next.files.find(file => file.displayPath === initialPath)?.id ?? next.files[0]?.id;
      });
      setActiveHunk(0);
      setSelectedLines(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [repositoryPath, request.kind, request.left, request.right, viewMode, ignoreWhitespace]);
  const selectedFile = document?.files.find(file => file.id === selectedFileId);
  const visibleFiles = useMemo(() => {
    const needle = fileQuery.trim().toLowerCase();
    return document?.files.filter(file => !needle || file.displayPath.toLowerCase().includes(needle)) ?? [];
  }, [document, fileQuery]);

  const goToHunk = (direction: number) => {
    if (!selectedFile?.hunks.length) return;
    const next = (activeHunk + direction + selectedFile.hunks.length) % selectedFile.hunks.length;
    setActiveHunk(next);
    contentRef.current?.querySelector<HTMLElement>(`#${selectedFile.hunks[next].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const applyHunk = async (action: GitHunkAction, hunk: GitDiffHunk, patch = hunk.patch) => {
    if (!selectedFile) return;
    if (action === 'stage' && request.kind !== 'working') return;
    if (action === 'unstage' && request.kind !== 'staged') return;
    if (action === 'discard' && request.kind !== 'working') return;
    if (action === 'discard' && !window.confirm(`Discard this change from ${selectedFile.displayPath}? This cannot be undone by Praxis.`)) return;
    setBusy(`${action}:${hunk.id}`);
    setError(undefined);
    try {
      await window.praxis.git.applyHunk(repositoryPath, { action, path: selectedFile.displayPath, patch });
      await onStatusChanged?.();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const applyFile = async () => {
    if (!selectedFile || (request.kind !== 'working' && request.kind !== 'staged')) return;
    setBusy(`file:${selectedFile.id}`);
    setError(undefined);
    try {
      if (request.kind === 'working') await window.praxis.git.stage(repositoryPath, [selectedFile.displayPath]);
      else await window.praxis.git.unstage(repositoryPath, [selectedFile.displayPath]);
      await onStatusChanged?.();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const discardFile = async () => {
    if (!selectedFile || request.kind !== 'working') return;
    if (!window.confirm(`Discard every unstaged change in ${selectedFile.displayPath}? This cannot be undone by Praxis.`)) return;
    setBusy(`discard-file:${selectedFile.id}`);
    setError(undefined);
    try {
      await window.praxis.git.discard(repositoryPath, [selectedFile.displayPath]);
      await onStatusChanged?.();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const openAuxiliary = async (view: 'history' | 'blame') => {
    if (!selectedFile) return;
    if (auxiliaryView === view) { setAuxiliaryView(undefined); return; }
    setAuxiliaryView(view);
    setAuxiliaryLoading(true);
    setError(undefined);
    const ref = request.kind === 'commit' ? request.left : request.kind === 'compare' ? request.right : undefined;
    try {
      if (view === 'history') setFileHistory(await window.praxis.git.getFileHistory(repositoryPath, selectedFile.displayPath, ref));
      else setBlame(await window.praxis.git.getBlame(repositoryPath, selectedFile.displayPath, ref));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuxiliaryLoading(false);
    }
  };

  return <section className="git-diff-workspace" aria-label="Diff workspace" data-testid="git-diff-workspace">
    <header className="git-diff-commandbar">
      <button className="git-diff-back" onClick={onClose} aria-label="Back to Git graph">←</button>
      <div className="git-diff-title">
        <div><span>Git Graph</span><b>›</b><strong>{document?.title ?? 'Diff'}</strong>{selectedFile && <><b>›</b><span>{fileName(selectedFile.displayPath)}</span></>}</div>
        <small>{document?.subtitle ?? 'Preparing comparison…'}</small>
      </div>
      <div className="git-diff-totals" aria-label="Change totals"><span>+{document?.additions ?? 0}</span><b>−{document?.deletions ?? 0}</b></div>
      <div className="git-diff-view-switch" aria-label="Diff view">
        {(['inline', 'split', 'hunks'] as const).map(mode => <button className={viewMode === mode ? 'active' : ''} key={mode} onClick={() => setViewMode(mode)}>{mode === 'hunks' ? 'Hunks' : mode[0].toUpperCase() + mode.slice(1)}</button>)}
      </div>
      <button className={`git-diff-icon-button${wrap ? ' active' : ''}`} aria-label="Toggle word wrap" title="Word wrap" onClick={() => setWrap(value => !value)}>↩</button>
      <button className={`git-diff-icon-button${ignoreWhitespace ? ' active' : ''}`} aria-label="Ignore whitespace" title="Ignore whitespace" onClick={() => setIgnoreWhitespace(value => !value)}>␠</button>
      <button className="git-diff-icon-button" aria-label="Refresh diff" onClick={() => void load()}>↻</button>
    </header>

    {error && <div className="git-diff-error" role="alert"><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    <div className="git-diff-layout">
      <aside className="git-diff-files" aria-label="Changed files">
        <header><strong>Changed files</strong><span>{document?.files.length ?? 0}</span></header>
        <label className="git-diff-file-search"><span>⌕</span><input value={fileQuery} onChange={event => setFileQuery(event.target.value)} placeholder="Filter files" aria-label="Filter changed files" /></label>
        <div className="git-diff-file-list">
          {visibleFiles.map(file => <button key={file.id} className={selectedFileId === file.id ? 'selected' : ''} onClick={() => { setSelectedFileId(file.id); setActiveHunk(0); }}>
            <i className={`status-${file.status}`}>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : file.status === 'binary' ? 'B' : 'M'}</i>
            <span><b>{fileName(file.displayPath)}</b><small>{directoryName(file.displayPath) || STATUS_LABELS[file.status]}</small></span>
            <em><span>+{file.additions}</span><b>−{file.deletions}</b></em>
          </button>)}
        </div>
      </aside>

      <main className="git-diff-editor">
        {loading && !document ? <div className="git-diff-state"><span className="git-spinner" /><strong>Building a clear comparison</strong><small>Praxis is reading the selected changes.</small></div>
          : !selectedFile ? <div className="git-diff-state"><strong>No changes to show</strong><small>This comparison is clean.</small></div>
          : <>
            <header className="git-diff-filebar">
              <div><i className={`status-${selectedFile.status}`}>{selectedFile.status[0].toUpperCase()}</i><span><strong>{selectedFile.displayPath}</strong><small>{STATUS_LABELS[selectedFile.status]} · {languageFor(selectedFile.displayPath)}</small></span></div>
              <div className="git-diff-file-actions"><button className={auxiliaryView === 'history' ? 'active' : ''} onClick={() => void openAuxiliary('history')}>History</button><button className={auxiliaryView === 'blame' ? 'active' : ''} onClick={() => void openAuxiliary('blame')}>Blame</button>{(request.kind === 'working' || request.kind === 'staged') && <button className="git-diff-primary-action" disabled={Boolean(busy)} onClick={() => void applyFile()}>{request.kind === 'working' ? 'Stage file' : 'Unstage file'}</button>}{request.kind === 'working' && <button className="git-diff-discard-file" disabled={Boolean(busy)} onClick={() => void discardFile()}>Discard file</button>}<div className="git-diff-change-nav"><button onClick={() => goToHunk(-1)} aria-label="Previous change">↑</button><span>{selectedFile.hunks.length ? activeHunk + 1 : 0} of {selectedFile.hunks.length}</span><button onClick={() => goToHunk(1)} aria-label="Next change">↓</button></div></div>
            </header>
            {auxiliaryView ? <section className="git-diff-auxiliary" aria-label={auxiliaryView === 'history' ? 'File history' : 'File blame'}>
              <header><div><strong>{auxiliaryView === 'history' ? 'File history' : 'Line blame'}</strong><small>{selectedFile.displayPath}</small></div><button onClick={() => setAuxiliaryView(undefined)}>Close</button></header>
              {auxiliaryLoading ? <div className="git-diff-state"><span className="git-spinner" /></div>
                : auxiliaryView === 'history' ? <div className="git-file-history-list">{fileHistory.map(entry => <div key={entry.hash}><code>{entry.shortHash}</code><span><strong>{entry.message}</strong><small>{entry.author} · {new Date(entry.date).toLocaleDateString()}</small></span></div>)}{fileHistory.length === 0 && <div className="git-diff-state"><small>No history was found for this file.</small></div>}</div>
                  : <div className="git-blame-list">{blame.map(line => <div key={`${line.commit}-${line.lineNumber}`}><code>{line.lineNumber}</code><span title={`${line.author} · ${new Date(line.date).toLocaleString()}`}>{line.author}<small>{line.shortHash}</small></span><pre>{line.content || ' '}</pre></div>)}{blame.length === 0 && <div className="git-diff-state"><small>No blame information was found.</small></div>}</div>}
            </section> : <>{viewMode === 'split' && <div className="git-diff-split-head"><span>Original</span><span>Updated</span></div>}
            <div className="git-diff-content" ref={contentRef}>
              {selectedFile.isBinary ? <div className="git-diff-state"><strong>Binary file changed</strong><small>Praxis cannot render a line-by-line comparison for this file.</small></div>
                : selectedFile.hunks.map(hunk => viewMode === 'split'
                  ? <SplitHunk hunk={hunk} wrap={wrap} key={hunk.id} />
                  : <InlineHunk hunk={hunk} wrap={wrap} mode={viewMode} comparisonKind={request.kind} busy={busy} selectedLines={selectedLines} onToggleLine={key => setSelectedLines(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onAction={(action, selectedHunk) => void applyHunk(action, selectedHunk)} onSelectedAction={(action, selectedHunk, indexes) => void applyHunk(action, selectedHunk, buildSelectedLinePatch(selectedHunk, indexes))} key={hunk.id} />)}
            </div></>}
          </>}
      </main>
    </div>
  </section>;
}
