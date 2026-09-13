import { useCallback, useEffect, useState } from 'react';
import type { AgentSessionRecord, GitChangedFile, GitDiffFile, GitDiffHunk, GitFileContent, GitStatusSnapshot } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { highlightCode, languageFor } from '../ui/codeHighlight';
import { isTerminalAgentState } from './aiSessionState';
import { reportedSessionPaths } from './sessionNav';

/**
 * What a session actually changed on disk, and the two things you want to do
 * about it: keep it, or throw it away.
 *
 * The transcript shows each edit as its own collapsed tool row, which is fine
 * for watching and useless for reviewing — a change touching six files is six
 * places in a chat log. This reads the working tree instead, so it reports the
 * real state after the agent finished, including anything it changed without
 * announcing a diff.
 *
 * It reads the session's own repository: the worktree when the session ran in
 * one, otherwise its working folder. Those differ, and pointing this at the
 * project folder for a worktree session would show the wrong changes entirely.
 */

export interface SessionChangesProps {
  session: AgentSessionRecord;
  /** Called after a commit or a discard changes the tree, so callers can refresh. */
  onChanged?: () => void;
}

/** A short, conventional-ish subject line derived from the session's goal. */
function suggestedMessage(session: AgentSessionRecord): string {
  const goal = session.taskDefinition.goal.split('\n')[0].trim().replace(/\s+/g, ' ');
  if (!goal) return 'Apply agent session changes';
  const trimmed = goal.length > 72 ? `${goal.slice(0, 69).trimEnd()}…` : goal;
  return trimmed;
}

function statusLabel(file: GitChangedFile): string {
  if (file.conflicted) return 'conflicted';
  const code = (file.worktreeStatus || file.indexStatus || '').trim();
  if (code === '?' || code === '??') return 'new';
  if (code === 'D') return 'deleted';
  if (code === 'A') return 'added';
  if (code === 'R') return 'renamed';
  return 'modified';
}

export function SessionChanges({ session, onChanged }: SessionChangesProps) {
  const { confirm, prompt } = useDialogs();
  const [status, setStatus] = useState<GitStatusSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [checked, setChecked] = useState(false);
  /** Path expanded inline, which of the two views it's showing, and that
   *  view's content once loaded. Diff and file view are mutually exclusive —
   *  only one row is open at a time. */
  const [openPath, setOpenPath] = useState<string>();
  const [openMode, setOpenMode] = useState<'diff' | 'file'>();
  const [openDiff, setOpenDiff] = useState<GitDiffFile>();
  const [openFile, setOpenFile] = useState<GitFileContent>();

  // The worktree is the session's repository when it ran in one.
  const repositoryPath = session.worktreePath?.trim() || session.workingDirectory?.trim();
  const finished = isTerminalAgentState(session.state);

  const refresh = useCallback(async () => {
    if (!repositoryPath) return;
    try {
      setStatus(await window.praxis.git.status(repositoryPath));
      setError(undefined);
    } catch (cause) {
      // A working folder that is not a git repository is an ordinary case, not
      // a failure worth shouting about — just show nothing.
      setStatus(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecked(true);
    }
  }, [repositoryPath]);

  useEffect(() => {
    setChecked(false);
    setStatus(undefined);
    setError(undefined);
    void refresh();
  }, [refresh, session.issueKey, session.state]);

  // As a section this stayed silent when there was nothing to show, which was
  // right while it sat inside a larger scrolling rail. As a *tab* silence reads
  // as a bug — you click Changes and get a blank pane — so each reason for
  // having nothing now says so.
  if (!checked) {
    return <div className="empty-state" data-testid="session-changes-loading"><span>Checking the working tree…</span></div>;
  }
  if (!repositoryPath) {
    return (
      <div className="empty-state" data-testid="session-changes-no-repo">
        <Icon name="git-branch" size={24} />
        <span>This session&rsquo;s folder isn&rsquo;t a git repository, so there is nothing to compare.</span>
      </div>
    );
  }
  const files = status?.files ?? [];
  if (files.length === 0) {
    return (
      <div className="empty-state" data-testid="session-changes-clean">
        <Icon name="check" size={24} />
        <span>No uncommitted changes in this session&rsquo;s working tree.</span>
        {error && <p className="hint is-danger" data-testid="session-changes-error">{error}</p>}
      </div>
    );
  }

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await action();
      await refresh();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const commit = async () => {
    const message = await prompt({
      title: `Commit ${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} this session changed`,
      label: 'Commit message',
      initialValue: suggestedMessage(session),
      confirmLabel: 'Commit',
      validate: value => (value.trim() ? undefined : 'Enter a commit message.')
    });
    if (!message) return;
    await run('commit', async () => {
      await window.praxis.git.stage(repositoryPath, sessionFiles.map(file => file.path));
      await window.praxis.git.commit(repositoryPath, message.trim());
    });
  };

  const discardAll = async () => {
    const ok = await confirm({
      title: `Discard ${sessionFiles.length} change${sessionFiles.length === 1 ? '' : 's'} from this session?`,
      // Says exactly what is thrown away and what is not. The old wording
      // claimed to discard "everything this session changed" while actually
      // discarding the entire working tree.
      message: [
        repositoryPath,
        '',
        sessionFiles.map(file => file.path).join('\n'),
        '',
        otherFileCount > 0
          ? `${otherFileCount} other changed file${otherFileCount === 1 ? '' : 's'} in this folder ${otherFileCount === 1 ? 'is' : 'are'} left alone.`
          : '',
        'This cannot be undone by Praxis.'
      ].filter(Boolean).join('\n'),
      confirmLabel: `Discard ${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'}`,
      danger: true
    });
    if (!ok) return;
    await run('discard', () => window.praxis.git.discard(repositoryPath, sessionFiles.map(file => file.path)));
  };

  const discardOne = async (file: GitChangedFile) => {
    const ok = await confirm({
      title: 'Discard this file?',
      message: `${file.path}\n\nThis cannot be undone by Praxis.`,
      confirmLabel: 'Discard',
      danger: true
    });
    if (!ok) return;
    await run(file.path, () => window.praxis.git.discard(repositoryPath, [file.path]));
  };

  const closeRow = () => {
    setOpenPath(undefined);
    setOpenMode(undefined);
    setOpenDiff(undefined);
    setOpenFile(undefined);
  };

  const loadDiff = async (file: GitChangedFile): Promise<GitDiffFile | undefined> => {
    const document = await window.praxis.git.getComparison(repositoryPath, {
      kind: file.staged ? 'staged' : 'working',
      path: file.path
    });
    return document.files.find(entry => entry.displayPath === file.path) ?? document.files[0];
  };

  /**
   * Reviewing a change means reading the diff, not the whole file — so this
   * reuses the git comparison the diff workspace already uses, scoped to one
   * path, rather than adding a file-read channel of its own.
   */
  const toggleDiff = async (file: GitChangedFile) => {
    if (openPath === file.path && openMode === 'diff') {
      closeRow();
      return;
    }
    setOpenPath(file.path);
    setOpenMode('diff');
    setOpenDiff(undefined);
    setOpenFile(undefined);
    try {
      setOpenDiff(await loadDiff(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      closeRow();
    }
  };

  /**
   * "The agent got a hunk wrong" no longer means discarding the whole file or
   * writing a follow-up message asking for a fix — just this change goes,
   * the file's other edits stay. Reuses the same hunk-level `applyHunk` the
   * full diff workspace already relies on for staging.
   */
  const discardHunk = async (file: GitChangedFile, hunk: GitDiffHunk) => {
    const ok = await confirm({
      title: 'Discard this hunk?',
      message: `${file.path}\n\nOnly this change is thrown away — the file's other edits are kept. This cannot be undone by Praxis.`,
      confirmLabel: 'Discard hunk',
      danger: true
    });
    if (!ok) return;
    setBusy(`hunk:${hunk.id}`);
    setError(undefined);
    try {
      await window.praxis.git.applyHunk(repositoryPath, { action: 'discard', path: file.path, patch: hunk.patch });
      await refresh();
      onChanged?.();
      const updated = await loadDiff(file).catch(() => undefined);
      if (updated) setOpenDiff(updated);
      else closeRow();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  /**
   * The diff shows what changed; this shows the file as it stands now — the
   * "just let me read it" case a diff can't serve, for a file the session
   * left untouched or one you'd rather see whole.
   */
  const toggleFile = async (file: GitChangedFile) => {
    if (openPath === file.path && openMode === 'file') {
      closeRow();
      return;
    }
    setOpenPath(file.path);
    setOpenMode('file');
    setOpenDiff(undefined);
    setOpenFile(undefined);
    try {
      setOpenFile(await window.praxis.git.getFileContent(repositoryPath, file.path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      closeRow();
    }
  };

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  /**
   * The files Commit and Discard are allowed to act on.
   *
   * The list above deliberately still shows everything `git status` reports —
   * when an agent breaks the build through a shell command, the file it wrote
   * is exactly what you need to see. But the two destructive buttons are
   * labelled for *this session*, so they act only on what this session's tools
   * reported writing. Before this they staged and discarded the whole working
   * tree, which swept up unrelated work in progress under a dialog that
   * promised "everything this session changed".
   */
  const sessionPaths = reportedSessionPaths(session.events, repositoryPath);
  const sessionFiles = files.filter(file => sessionPaths.has(file.path));
  const otherFileCount = files.length - sessionFiles.length;
  /**
   * No host reports a shell command's writes, and Copilot reports nothing at
   * all — so an empty set means "nothing was reported", never "nothing was
   * changed". The actions are withheld rather than silently doing nothing.
   */
  const nothingAttributed = sessionFiles.length === 0;

  return (
    <div className="session-changes" data-testid="session-changes">
      <div className="session-changes-heading">
        <span className="session-changes-count" data-testid="session-changes-count">
          {files.length} file{files.length === 1 ? '' : 's'}
          {(additions > 0 || deletions > 0) && (
            <>
              {' '}
              <span className="session-changes-add">+{additions}</span>{' '}
              <span className="session-changes-del">−{deletions}</span>
            </>
          )}
        </span>
      </div>

      <ul className="session-changes-list">
        {files.map(file => (
          <li key={file.path} data-testid="session-changes-file">
            <div className="session-changes-row">
              <span className={`session-changes-status is-${statusLabel(file)}`}>{statusLabel(file)}</span>
              <button
                type="button"
                className="session-changes-path"
                title={`Show the diff for ${file.path}`}
                aria-expanded={openPath === file.path && openMode === 'diff'}
                data-testid="session-changes-open"
                onClick={() => void toggleDiff(file)}
              >
                {file.path}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`View ${file.path}`}
                title="View the whole file, not just the diff"
                aria-expanded={openPath === file.path && openMode === 'file'}
                data-testid="session-changes-view"
                onClick={() => void toggleFile(file)}
              >
                <Icon name="file" size={12} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Discard ${file.path}`}
                title="Discard this file"
                disabled={Boolean(busy)}
                onClick={() => void discardOne(file)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            {openPath === file.path && openMode === 'diff' && (
              <div className="session-changes-diff" data-testid="session-changes-diff">
                {!openDiff ? (
                  <span className="placeholder-text">Loading diff…</span>
                ) : openDiff.isBinary ? (
                  <span className="placeholder-text">Binary file — no text diff.</span>
                ) : (
                  openDiff.hunks.map(hunk => (
                    <div className="session-changes-hunk" key={hunk.id} data-testid="session-changes-hunk">
                      <div className="session-changes-hunk-head">
                        <span className="diff-hunk">{hunk.header}</span>
                        {!file.staged && (
                          <button
                            type="button"
                            className="btn-quiet session-changes-hunk-discard"
                            data-testid="session-changes-hunk-discard"
                            disabled={Boolean(busy)}
                            title="Discard just this change; the file's other edits are kept"
                            onClick={() => void discardHunk(file, hunk)}
                          >
                            {busy === `hunk:${hunk.id}` ? 'Discarding…' : 'Discard hunk'}
                          </button>
                        )}
                      </div>
                      <pre>
                        {hunk.lines.map((line, index) => (
                          <span key={index} className={`diff-${line.kind}`}>
                            {line.content || ' '}{'\n'}
                          </span>
                        ))}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            )}
            {openPath === file.path && openMode === 'file' && (
              <div className="session-changes-file" data-testid="session-changes-file-view">
                {!openFile ? (
                  <span className="placeholder-text">Loading file…</span>
                ) : openFile.isBinary ? (
                  <span className="placeholder-text">Binary file ({(openFile.size / 1024).toFixed(1)} KB) — no text preview.</span>
                ) : (
                  <>
                    <div className="session-changes-file-head">
                      <span>{languageFor(file.path)}</span>
                      {openFile.truncated && <span className="session-changes-file-truncated">showing first {(openFile.content.length / 1024).toFixed(0)} KB of {(openFile.size / 1024).toFixed(0)} KB</span>}
                    </div>
                    <pre className="session-changes-file-body">
                      {openFile.content.split('\n').map((line, index) => (
                        <span key={index} className="session-changes-file-line">
                          <span className="session-changes-file-line-no">{index + 1}</span>
                          <code>{highlightCode(line) || ' '}</code>
                        </span>
                      ))}
                    </pre>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Landing the work is only offered once the agent has stopped — committing
          underneath a running session would capture a half-finished tree. */}
      <div className="session-changes-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="session-commit"
          disabled={Boolean(busy) || !finished || nothingAttributed}
          title={
            !finished
              ? 'Wait for the session to finish'
              : nothingAttributed
                ? 'No changed file here was reported by this session'
                : undefined
          }
          onClick={() => void commit()}
        >
          <Icon name="check-square" size={13} />
          {busy === 'commit' ? 'Committing…' : `Commit ${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'}`}
        </button>
        <button
          type="button"
          className="btn-quiet"
          data-testid="session-discard-all"
          disabled={Boolean(busy) || nothingAttributed}
          title={nothingAttributed ? 'No changed file here was reported by this session' : undefined}
          onClick={() => void discardAll()}
        >
          {busy === 'discard' ? 'Discarding…' : `Discard ${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {/* The distinction the buttons depend on, stated rather than implied —
          otherwise "Commit 2 files" above a list of five reads as a bug. */}
      {nothingAttributed ? (
        <p className="hint" data-testid="session-changes-unattributed">
          None of these files were reported by this session&rsquo;s tools, so committing and
          discarding from here are withheld. Some agents report nothing, and no agent reports
          files written by a shell command it ran.
        </p>
      ) : otherFileCount > 0 && (
        <p className="hint" data-testid="session-changes-scope-note">
          {otherFileCount} other changed file{otherFileCount === 1 ? '' : 's'} in this folder
          {otherFileCount === 1 ? ' is' : ' are'} shown but not acted on — this session&rsquo;s tools
          didn&rsquo;t report {otherFileCount === 1 ? 'it' : 'them'}.
        </p>
      )}
      {error && <p className="hint is-danger" data-testid="session-changes-error">{error}</p>}
    </div>
  );
}
