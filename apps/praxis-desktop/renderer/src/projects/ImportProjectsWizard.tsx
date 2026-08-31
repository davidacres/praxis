import { useState } from 'react';
import type { ProjectImportRow } from '@praxis/core';

export interface ImportProjectsWizardProps {
  /** Workspace the imported projects are added to. */
  workspaceId: string;
  /**
   * Called when the wizard closes — either after a successful import, or when
   * the user backs out without importing.
   */
  onDone: () => void;
}

/**
 * Two-step "import plans folders as projects" wizard.
 *
 * Step 1 — pick a parent folder and scan below it. Every Git repository that
 * actually has a plans structure becomes a row; bare plans-only folders are the
 * fallback when no repositories are found. A repository with no discoverable
 * plans is not offered — it used to be guessed at as `<repo>/docs/plans`, which
 * produced projects pointed at empty directories.
 * Step 2 — tick the rows to import and edit their name/key (already-imported
 * rows are shown but locked), then create them all in one batch.
 *
 * Each created project is `storage: 'folder'`, so the markdown files on disk
 * stay the source of truth and its board reads them directly.
 */
export function ImportProjectsWizard({ workspaceId, onDone }: ImportProjectsWizardProps) {
  const [folderPath, setFolderPath] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [rows, setRows] = useState<ProjectImportRow[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
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
      const found = await window.praxis.projects.discoverImports(path);
      setRows(found);
      setSelectedPaths(new Set(found.filter(row => !row.alreadyAdded).map(row => row.repositoryRootPath)));
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
    const picked = await window.praxis.dialog.pickFolder();
    if (picked) {
      setFolderPath(picked);
      void runDiscover(picked);
    }
  };

  const updateRow = (index: number, field: 'projectKey' | 'projectName', value: string) => {
    setRows(current =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row))
    );
  };

  const selectedRows = rows.filter(row => row.alreadyAdded || selectedPaths.has(row.repositoryRootPath));
  const newCount = rows.filter(row => !row.alreadyAdded && selectedPaths.has(row.repositoryRootPath)).length;

  const toggleRow = (row: ProjectImportRow) => {
    if (row.alreadyAdded) return;
    setSelectedPaths(current => {
      const next = new Set(current);
      if (next.has(row.repositoryRootPath)) next.delete(row.repositoryRootPath);
      else next.add(row.repositoryRootPath);
      return next;
    });
  };

  const onSubmit = async () => {
    const validationError = await window.praxis.projects.validateImports(selectedRows);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await window.praxis.projects.createFromImports(selectedRows, workspaceId);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled = submitting || newCount === 0;

  return (
    <div className="conn-form" data-testid="import-projects-wizard">
      <header className="view-header">
        <span className="view-title">Import plans folders as projects</span>
        <span className="spacer" />
        {step === 'details' && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="import-submit-btn"
            disabled={submitDisabled}
            onClick={() => void onSubmit()}
          >
            {submitting ? 'Importing…' : `Import ${newCount} project${newCount === 1 ? '' : 's'}`}
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-testid="import-cancel-btn"
          disabled={submitting}
          onClick={onDone}
        >
          Cancel
        </button>
      </header>
      <div className="conn-form-body">
        {error && (
          <div className="error-banner" data-testid="import-error">
            {error}
          </div>
        )}

        {step === 'folder' && (
          <>
            <p className="placeholder-text">
              Choose a parent folder. Every Git repository below it that has a plans structure
              becomes a project; plans-only folders are used when no repositories are found.
              Nothing is written to your repositories until you import.
            </p>
            <div className="form-row">
              <input
                className="input"
                type="text"
                data-testid="import-folder-input"
                placeholder={'C:\\path\\to\\plans-parent'}
                value={folderPath}
                onChange={event => setFolderPath(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                data-testid="import-pick-folder-btn"
                onClick={() => void onBrowse()}
              >
                Browse…
              </button>
              <button
                type="button"
                className="btn"
                data-testid="import-discover-btn"
                disabled={discovering}
                onClick={() => void runDiscover(folderPath)}
              >
                {discovering ? 'Finding…' : 'Find plans folders'}
              </button>
            </div>

            {discovering && (
              <p className="placeholder-text" data-testid="import-loading">
                Searching for repositories and plans folders…
              </p>
            )}

            {!discovering && emptyDiscovery && (
              <p className="placeholder-text" data-testid="import-empty">
                No plans folders found under that folder.
              </p>
            )}
          </>
        )}

        {step === 'details' && (
          <>
            <p className="placeholder-text">
              Tick the folders to import and edit their details. Folders already imported are shown
              but locked — they won't be added twice.
            </p>
            <div className="board-draft-header">
              <span>Import</span>
              <span>Folder</span>
              <span>Project code</span>
              <span>Project name</span>
            </div>
            <div className="board-draft-list">
              {rows.map((row, index) => (
                <div
                  key={row.repositoryRootPath}
                  className={`board-draft-row${row.alreadyAdded ? ' already-added' : ''}`}
                  data-testid="import-row"
                >
                  <label className="board-draft-select">
                    <input
                      type="checkbox"
                      checked={row.alreadyAdded || selectedPaths.has(row.repositoryRootPath)}
                      disabled={row.alreadyAdded}
                      aria-label={`Import ${row.repositoryName}`}
                      data-testid="import-row-select"
                      onChange={() => toggleRow(row)}
                    />
                  </label>
                  <div className="board-draft-info">
                    <div className="board-draft-name">{row.repositoryName}</div>
                    <div className="board-draft-path">{row.plansFolderPath}</div>
                    {row.alreadyAdded && <span className="board-draft-badge">Already imported</span>}
                  </div>
                  <input
                    className="input"
                    type="text"
                    aria-label="Project code"
                    data-testid="import-row-projectKey"
                    value={row.projectKey}
                    disabled={row.alreadyAdded}
                    onChange={event => updateRow(index, 'projectKey', event.target.value)}
                  />
                  <input
                    className="input"
                    type="text"
                    aria-label="Project name"
                    data-testid="import-row-projectName"
                    value={row.projectName}
                    disabled={row.alreadyAdded}
                    onChange={event => updateRow(index, 'projectName', event.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="form-row">
              <button
                type="button"
                className="btn"
                data-testid="import-back-btn"
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
