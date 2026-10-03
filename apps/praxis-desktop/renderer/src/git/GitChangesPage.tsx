import { useEffect, useState } from 'react';
import type { GitDiffRequest, GitRepositorySnapshot, GitStatusSnapshot } from '@praxis/core';
import { GitConflictWorkspace } from './GitConflictWorkspace';
import { GitDiffWorkspace } from './GitDiffWorkspace';
import { useRegisterPageAssistantContext } from '../assistant/AssistantProvider';

interface GitChangesPageProps {
  repositoryPath?: string;
  onOpenGraph: () => void;
}

/**
 * The working tree is deliberately separate from history: reviewing, staging,
 * and committing local files should never displace the branch graph.
 */
export function GitChangesPage({ repositoryPath, onOpenGraph }: GitChangesPageProps) {
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot>();
  const [status, setStatus] = useState<GitStatusSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [commitMessage, setCommitMessage] = useState('');
  const [stashComposerOpen, setStashComposerOpen] = useState(false);
  const [stashMessage, setStashMessage] = useState('Work in progress');
  const [diffRequest, setDiffRequest] = useState<GitDiffRequest>();
  const [diffInitialPath, setDiffInitialPath] = useState<string>();
  const [conflictPath, setConflictPath] = useState<string>();

  useRegisterPageAssistantContext(status ? {
    pageType: 'git',
    title: `Git changes${status.branch ? ` on ${status.branch}` : ''}`,
    summary: `${status.files.length} changed files on ${status.branch ?? 'a detached HEAD'} (ahead ${status.ahead}, behind ${status.behind}).`,
    data: status.files.slice(0, 200).map(file => `${file.staged ? 'staged  ' : 'unstaged'} ${file.indexStatus}${file.worktreeStatus} ${file.path}${file.additions !== undefined ? ` (+${file.additions} -${file.deletions ?? 0})` : ''}`).join('\n'),
    suggestedPrompts: ['Draft conventional commit message', 'Scan diff for leaked secrets or console logs']
  } : undefined);

  const load = async (target?: string, force = false) => {
    if (!target) {
      setSnapshot(undefined);
      setStatus(undefined);
      setError('This project needs a workspace folder before its working tree can be shown.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = force ? await window.praxis.git.refresh(target) : await window.praxis.git.open(target);
      setSnapshot(next);
      const nextStatus = await window.praxis.git.status(next.repositoryPath);
      setStatus(nextStatus);
      setConflictPath(nextStatus.files.find(file => file.conflicted)?.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(repositoryPath); }, [repositoryPath]);

  const refreshStatus = async () => {
    if (!snapshot) return;
    const next = await window.praxis.git.status(snapshot.repositoryPath);
    setStatus(next);
    setConflictPath(next.files.find(file => file.conflicted)?.path);
  };

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusyAction(label);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(undefined);
    }
  };

  const openDiff = (request: GitDiffRequest, path?: string) => {
    setDiffInitialPath(path);
    setDiffRequest(request);
  };

  if (snapshot && diffRequest) {
    return <section className="git-page git-page-diff" aria-label="Git changes" data-testid="git-changes-page">
      <GitDiffWorkspace
        repositoryPath={snapshot.repositoryPath}
        request={diffRequest}
        initialPath={diffInitialPath}
        backLabel="Back to Changes"
        sourceLabel="Changes"
        onClose={() => { setDiffRequest(undefined); setDiffInitialPath(undefined); }}
        onStatusChanged={refreshStatus}
      />
    </section>;
  }

  if (snapshot && conflictPath) {
    return <section className="git-page git-page-diff" aria-label="Git changes" data-testid="git-changes-page">
      <GitConflictWorkspace
        repositoryPath={snapshot.repositoryPath}
        path={conflictPath}
        canAbort={Boolean(status?.operation)}
        onClose={() => setConflictPath(undefined)}
        onResolved={() => refreshStatus()}
        onAbort={async () => { await window.praxis.git.abortConflict(snapshot.repositoryPath); await load(snapshot.repositoryPath, true); }}
      />
    </section>;
  }

  const files = status?.files ?? [];
  const stagedFiles = files.filter(file => file.staged);
  const unstagedFiles = files.filter(file => !file.staged && !file.conflicted);

  return <section className="git-page git-changes-page" aria-label="Git changes" data-testid="git-changes-page">
    <header className="git-header">
      <div>
        <div className="git-eyebrow">WORKING TREE</div>
        <h1><span className="git-logo">⌘</span> Changes <span className="git-repo-name">{snapshot?.repositoryName ?? 'Repository'}</span></h1>
      </div>
      <div className="git-header-actions">
        <button className="git-button" onClick={onOpenGraph}>← Graph</button>
        <button className="git-button" onClick={() => void load(snapshot?.repositoryPath ?? repositoryPath, true)} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        <button className="git-button git-open-button" onClick={() => void window.praxis.dialog.pickFolder('Open Git repository').then(path => { if (path) void load(path); })}>Open repository</button>
      </div>
    </header>

    {error && <div className="git-error" role="alert"><strong>Git is unavailable</strong><span>{error}</span><button onClick={() => void load(snapshot?.repositoryPath ?? repositoryPath, true)}>Try again</button></div>}
    {busyAction && <div className="git-progress" role="status"><span className="git-progress-dot" />{busyAction}…</div>}
    {loading && !snapshot ? <div className="git-empty"><div className="git-spinner" /><h2>Reading working tree</h2><p>Checking local changes, the staging area, and current branch.</p></div>
      : !snapshot ? <div className="git-empty"><div className="git-empty-icon">⌘</div><h2>No repository selected</h2><p>Open a project workspace containing a Git repository to review changes.</p></div>
      : <main className="git-changes-layout">
        <section className="git-changes-worktree" aria-label="Working tree changes">
          <header className="git-changes-page-heading">
            <div><span className="git-eyebrow">LOCAL FILES</span><h2>Working tree <small>{files.length ? `${files.length} changed files` : 'Clean'}</small></h2></div>
            <div className="git-changes-actions">
              {unstagedFiles.length > 0 && <button className="git-action-button" onClick={() => openDiff({ kind: 'working' })}>Review unstaged</button>}
              {stagedFiles.length > 0 && <button className="git-action-button" onClick={() => openDiff({ kind: 'staged' })}>Review staged</button>}
              {files.length > 0 && <button className="git-action-button" onClick={() => setStashComposerOpen(true)}>Stash changes</button>}
              {unstagedFiles.length > 0 && <button className="git-action-button" disabled={Boolean(busyAction)} onClick={() => void runAction('Staging all files', async () => { setStatus(await window.praxis.git.stage(snapshot.repositoryPath, unstagedFiles.map(file => file.path))); })}>Stage all</button>}
            </div>
          </header>

          {stashComposerOpen && <form className="git-stash-composer" onSubmit={event => { event.preventDefault(); void runAction('Stashing changes', async () => { const next = await window.praxis.git.stash(snapshot.repositoryPath, stashMessage.trim() || 'Work in progress'); setStashComposerOpen(false); setStashMessage('Work in progress'); setStatus(await window.praxis.git.status(next.repositoryPath)); }); }}>
            <label>Stash description<input autoFocus value={stashMessage} onChange={event => setStashMessage(event.target.value)} /></label>
            <div><button type="button" className="git-action-button" onClick={() => setStashComposerOpen(false)}>Cancel</button><button className="git-button git-primary-button" disabled={Boolean(busyAction)}>Stash changes</button></div>
          </form>}

          {files.length === 0 ? <div className="git-clean-state"><span>✓</span><div><b>Everything is committed</b><small>No local file changes to stage.</small></div></div>
            : <div className="git-change-list">{files.map(file => <div className={`git-change-row${file.conflicted ? ' conflicted' : ''}`} key={file.path}>
              {file.conflicted ? <span className="git-conflict-indicator">!</span> : <input aria-label={`${file.staged ? 'Unstage' : 'Stage'} ${file.path}`} type="checkbox" checked={file.staged} disabled={Boolean(busyAction)} onChange={() => void runAction(file.staged ? 'Unstaging file' : 'Staging file', async () => { setStatus(file.staged ? await window.praxis.git.unstage(snapshot.repositoryPath, [file.path]) : await window.praxis.git.stage(snapshot.repositoryPath, [file.path])); })} />}
              <span className="git-change-status">{file.indexStatus !== ' ' ? file.indexStatus : file.worktreeStatus}</span>
              <button className="git-change-file" onClick={() => file.conflicted ? setConflictPath(file.path) : openDiff({ kind: file.staged ? 'staged' : 'working' }, file.path)}>{file.path}</button>
              <small>{file.conflicted ? 'resolve' : file.staged ? 'staged' : 'unstaged'}</small>
            </div>)}</div>}
        </section>

        <aside className="git-commit-pane" aria-label="Commit staged changes">
          <span className="git-eyebrow">STAGING AREA</span>
          <h2>Commit staged changes</h2>
          <p>{stagedFiles.length ? `${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'} ready to commit.` : 'Stage one or more files before creating a commit.'}</p>
          <div className="git-stage-summary">{stagedFiles.length ? stagedFiles.map(file => <span key={file.path}>✓ {file.path}</span>) : <span>No staged files yet.</span>}</div>
          <label className="git-commit-message-field">Commit message<textarea aria-label="Commit message" placeholder="Describe the changes…" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} /></label>
          <button className="git-button git-primary-button git-commit-primary" disabled={!stagedFiles.length || !commitMessage.trim() || Boolean(busyAction)} onClick={() => void runAction('Committing changes', async () => { const next = await window.praxis.git.commit(snapshot.repositoryPath, commitMessage); setSnapshot(next); setCommitMessage(''); setStatus(await window.praxis.git.status(next.repositoryPath)); })}>{busyAction === 'Committing changes' ? 'Committing…' : 'Commit staged changes'}</button>
        </aside>
      </main>}
  </section>;
}
