import { useCallback, useEffect, useState } from 'react';
import type { AgentSessionRecord, GitChangedFile, GitStatusSnapshot } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { isTerminalAgentState } from './aiSessionState';

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

  if (!repositoryPath || !checked) return null;
  const files = status?.files ?? [];
  if (files.length === 0) {
    // Nothing to review. Stay silent rather than showing an empty box.
    return error ? null : null;
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
      title: 'Commit these changes',
      label: 'Commit message',
      initialValue: suggestedMessage(session),
      confirmLabel: 'Commit',
      validate: value => (value.trim() ? undefined : 'Enter a commit message.')
    });
    if (!message) return;
    await run('commit', async () => {
      await window.praxis.git.stage(repositoryPath, files.map(file => file.path));
      await window.praxis.git.commit(repositoryPath, message.trim());
    });
  };

  const discardAll = async () => {
    const ok = await confirm({
      title: `Discard all ${files.length} change${files.length === 1 ? '' : 's'}?`,
      message: `${repositoryPath}\n\nEverything this session changed is thrown away. This cannot be undone by Praxis.`,
      confirmLabel: 'Discard everything',
      danger: true
    });
    if (!ok) return;
    await run('discard', () => window.praxis.git.discard(repositoryPath, files.map(file => file.path)));
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

  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <div className="agent-runtime-block session-changes" data-testid="session-changes">
      <div className="session-changes-heading">
        <span className="rail-sub">Changes</span>
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
            <span className={`session-changes-status is-${statusLabel(file)}`}>{statusLabel(file)}</span>
            <span className="session-changes-path" title={file.path}>{file.path}</span>
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
          disabled={Boolean(busy) || !finished}
          title={finished ? undefined : 'Wait for the session to finish'}
          onClick={() => void commit()}
        >
          <Icon name="check-square" size={13} /> {busy === 'commit' ? 'Committing…' : 'Commit changes'}
        </button>
        <button
          type="button"
          className="btn-quiet"
          data-testid="session-discard-all"
          disabled={Boolean(busy)}
          onClick={() => void discardAll()}
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard all'}
        </button>
      </div>
      {error && <p className="hint is-danger" data-testid="session-changes-error">{error}</p>}
    </div>
  );
}
