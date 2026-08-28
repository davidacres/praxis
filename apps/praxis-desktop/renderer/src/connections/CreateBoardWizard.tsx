import { useState } from 'react';
import type { BoardDraftRow, Connection } from '@praxis/core';

export interface CreateBoardWizardProps {
  connection: Connection;
  /**
   * Called when the wizard closes — either after a successful save, or when
   * the user backs out without saving. Mirrors `BoardPicker.onDone`.
   */
  onDone: () => void;
}

/**
 * Two-step "create board" wizard for a User Workspace connection.
 *
 * Step 1 — pick a parent folder and discover board candidates under it via
 * the main-process scanner. Matches the VS Code extension's "Find
 * repositories" behavior: every Git repository root becomes a row (even a
 * brand-new repo with no plans content yet), with any bare plans-only
 * folders as a fallback when no repositories are found.
 * Step 2 — edit the auto-suggested name/project key/project name per row
 * (already-added boards are shown but locked) and create every new row in
 * one batch.
 *
 * Single component, single root with the `conn-form` shell so the wizard and
 * the existing picker share the same layout idiom (view header + body).
 */
export function CreateBoardWizard({ connection, onDone }: CreateBoardWizardProps) {
  const [folderPath, setFolderPath] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [drafts, setDrafts] = useState<BoardDraftRow[]>([]);
  const [step, setStep] = useState<'folder' | 'details'>('folder');
  const [emptyDiscovery, setEmptyDiscovery] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const runDiscover = async (path: string) => {
    if (!path.trim()) {
      return;
    }
    setDiscovering(true);
    setError(undefined);
    setEmptyDiscovery(false);
    try {
      const found = await window.ticketManager.userWorkspace.discoverBoardDrafts(connection.id, path);
      setDrafts(found);
      if (found.length === 0) {
        setEmptyDiscovery(true);
        setStep('folder');
      } else {
        setStep('details');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const onBrowse = async () => {
    const picked = await window.ticketManager.dialog.pickFolder();
    if (picked) {
      setFolderPath(picked);
      void runDiscover(picked);
    }
  };

  const updateDraft = (index: number, field: 'name' | 'projectKey' | 'projectName', value: string) => {
    setDrafts(current =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row))
    );
  };

  const newCount = drafts.filter(row => !row.alreadyAdded).length;

  const onSubmit = async () => {
    const validationError = await window.ticketManager.userWorkspace.validateBoardDrafts(
      connection.id,
      drafts
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      for (const draft of drafts) {
        if (draft.alreadyAdded) {
          continue;
        }
        await window.ticketManager.userWorkspace.createBoard(connection.id, {
          name: draft.name.trim(),
          projectKey: draft.projectKey.trim(),
          projectName: draft.projectName.trim() || undefined,
          liveFolderPath: draft.liveFolderPath
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled = submitting || newCount === 0;

  return (
    <div className="conn-form" data-testid="uw-wizard">
      <header className="view-header">
        <span className="view-title">Create board — {connection.name}</span>
        <span className="spacer" />
        {step === 'details' && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="uw-wizard-submit-btn"
            disabled={submitDisabled}
            onClick={() => void onSubmit()}
          >
            {submitting ? 'Creating…' : `Create ${newCount} board${newCount === 1 ? '' : 's'}`}
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-testid="uw-wizard-cancel-btn"
          disabled={submitting}
          onClick={onDone}
        >
          Cancel
        </button>
      </header>
      <div className="conn-form-body">
        {error && (
          <div className="error-banner" data-testid="uw-wizard-error">
            {error}
          </div>
        )}

        {step === 'folder' && (
          <>
            <p className="placeholder-text">
              Choose a parent folder. Every Git repository found below it becomes a board (a
              brand-new repo with no plans yet is fine); plans-only folders are used as a fallback
              when no repositories are found. Nothing is written to your repositories until you
              create the boards.
            </p>
            <div className="form-row">
              <input
                className="input"
                type="text"
                data-testid="uw-wizard-folder-input"
                placeholder={'C:\\path\\to\\plans-parent'}
                value={folderPath}
                onChange={event => setFolderPath(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                data-testid="uw-wizard-pick-folder-btn"
                onClick={() => void onBrowse()}
              >
                Browse…
              </button>
              <button
                type="button"
                className="btn"
                data-testid="uw-wizard-discover-btn"
                disabled={discovering}
                onClick={() => void runDiscover(folderPath)}
              >
                {discovering ? 'Finding…' : 'Find repositories'}
              </button>
            </div>

            {discovering && (
              <p className="placeholder-text" data-testid="uw-wizard-loading">
                Searching for repositories and plans folders…
              </p>
            )}

            {!discovering && emptyDiscovery && (
              <p className="placeholder-text" data-testid="uw-wizard-empty">
                No repositories or plans folders found under that folder.
              </p>
            )}
          </>
        )}

        {step === 'details' && (
          <>
            <p className="placeholder-text">
              Edit the board details below. Existing boards are shown but locked — they won't be
              created again.
            </p>
            <div className="board-draft-header">
              <span>Repository</span>
              <span>Project code</span>
              <span>Project name</span>
              <span>Board name</span>
            </div>
            <div className="board-draft-list">
              {drafts.map((row, index) => (
                <div
                  key={row.repositoryRootPath}
                  className={`board-draft-row${row.alreadyAdded ? ' already-added' : ''}`}
                  data-testid="uw-draft-row"
                >
                  <div className="board-draft-info">
                    <div className="board-draft-name">{row.repositoryName}</div>
                    <div className="board-draft-path">{row.liveFolderPath}</div>
                    {row.alreadyAdded && <span className="board-draft-badge">Already added</span>}
                  </div>
                  <input
                    className="input"
                    type="text"
                    aria-label="Project code"
                    data-testid="uw-draft-projectKey"
                    value={row.projectKey}
                    disabled={row.alreadyAdded}
                    onChange={event => updateDraft(index, 'projectKey', event.target.value)}
                  />
                  <input
                    className="input"
                    type="text"
                    aria-label="Project name"
                    data-testid="uw-draft-projectName"
                    value={row.projectName}
                    disabled={row.alreadyAdded}
                    onChange={event => updateDraft(index, 'projectName', event.target.value)}
                  />
                  <input
                    className="input"
                    type="text"
                    aria-label="Board name"
                    data-testid="uw-draft-name"
                    value={row.name}
                    disabled={row.alreadyAdded}
                    onChange={event => updateDraft(index, 'name', event.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="form-row">
              <button
                type="button"
                className="btn"
                data-testid="uw-wizard-back-btn"
                onClick={() => setStep('folder')}
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
