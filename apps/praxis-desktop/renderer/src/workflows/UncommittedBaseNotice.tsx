import { useState } from 'react';
import { Icon } from '../ui/Icon';

/**
 * Thrown before a run is created when the checkout has uncommitted product files: a run works from a
 * copy of the last commit, so those files would be left out. Carrying the files lets the dialog show
 * exactly what would be omitted and offer to continue anyway.
 */
export class UncommittedBaseError extends Error {
  constructor(
    public readonly files: readonly string[],
    public readonly projectId: string
  ) {
    super(`${files.length} uncommitted ${files.length === 1 ? 'file' : 'files'} would not be in the run.`);
    this.name = 'UncommittedBaseError';
  }
}

export type UncommittedChoice = 'include' | 'omit';

/** Resolves when a run can start, or rejects with the files that stand in the way. */
export async function assertRunBaseOrThrow(projectId: string, uncommittedChanges: UncommittedChoice | undefined): Promise<void> {
  if (uncommittedChanges) return;
  const { blockingFiles } = await window.praxis.workflows.checkRunBase(projectId);
  if (blockingFiles.length > 0) throw new UncommittedBaseError(blockingFiles, projectId);
}

const PREVIEW_LIMIT = 6;

export function UncommittedBaseNotice({
  files,
  projectId,
  busy,
  onChoose,
  onCommitted,
  onDismiss
}: {
  files: readonly string[];
  projectId: string;
  busy: boolean;
  onChoose: (choice: UncommittedChoice) => void;
  /** The files are now committed; retry starting with no choice needed. */
  onCommitted: () => void;
  onDismiss: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | undefined>();
  const commit = async () => {
    setCommitting(true);
    setCommitError(undefined);
    try {
      await window.praxis.workflows.commitRunBase(projectId, 'WIP: save changes before starting a run');
      onCommitted();
    } catch (cause) {
      setCommitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCommitting(false);
    }
  };
  const shown = files.slice(0, PREVIEW_LIMIT);
  return (
    <div className="error-banner uncommitted-base-notice" role="alert" data-testid="uncommitted-base-notice">
      <div className="uncommitted-base-body">
        <strong>
          {files.length} uncommitted {files.length === 1 ? 'file' : 'files'} in this checkout
        </strong>
        <p>
          Runs work in their own copy of your project. Include these changes so the agent and QA see what you have open
          (your files stay untouched; the run&rsquo;s branch gets a snapshot commit), or start from the last commit without them.
        </p>
        <ul>
          {shown.map(file => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
          {files.length > shown.length && <li>…and {files.length - shown.length} more</li>}
        </ul>
        {commitError && <p role="alert">{commitError}</p>}
        <div className="uncommitted-base-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || committing} onClick={() => onChoose('include')} data-testid="uncommitted-base-include">
            Include my changes
          </button>
          <button type="button" className="btn btn-sm" disabled={busy || committing} onClick={() => void commit()} data-testid="uncommitted-base-commit">
            {committing ? 'Committing…' : 'Commit changes'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onChoose('omit')} data-testid="uncommitted-base-omit">
            Start from last commit
          </button>
        </div>
      </div>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
