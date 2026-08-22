import { useState } from 'react';
import type { Connection, IdentifiedPlanFolder } from '@ticket-manager/core';

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
 * Step 1 — pick a folder containing plans roots and discover them via the
 * main-process scanner.
 * Step 2 — once at least one plans root is identified, choose one and fill in
 * the board/project metadata, then write the new board through the IPC.
 *
 * Single component, single root with the `conn-form` shell so the wizard and
 * the existing picker share the same layout idiom (view header + body).
 */
export function CreateBoardWizard({ connection, onDone }: CreateBoardWizardProps) {
  const [folderPath, setFolderPath] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [plansRoots, setPlansRoots] = useState<IdentifiedPlanFolder[]>([]);
  const [selectedRootPath, setSelectedRootPath] = useState<string | undefined>();
  const [emptyDiscovery, setEmptyDiscovery] = useState(false);
  const [name, setName] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [projectName, setProjectName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const runDiscover = async (path: string) => {
    if (!path.trim()) {
      return;
    }
    setDiscovering(true);
    setError(undefined);
    setPlansRoots([]);
    setSelectedRootPath(undefined);
    setEmptyDiscovery(false);
    try {
      const found = await window.ticketManager.userWorkspace.discoverPlans(path);
      setPlansRoots(found);
      if (found.length === 0) {
        setEmptyDiscovery(true);
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

  const onSubmit = async () => {
    if (!selectedRootPath) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await window.ticketManager.userWorkspace.createBoard(connection.id, {
        name: name.trim(),
        projectKey: projectKey.trim(),
        projectName: projectName.trim() || undefined,
        liveFolderPath: selectedRootPath
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled =
    submitting || !name.trim() || !projectKey.trim() || !selectedRootPath;

  return (
    <div className="conn-form" data-testid="uw-wizard">
      <header className="view-header">
        <span className="view-title">Create board — {connection.name}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="uw-wizard-submit-btn"
          disabled={submitDisabled}
          onClick={() => void onSubmit()}
        >
          {submitting ? 'Creating…' : 'Create board'}
        </button>
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
            {discovering ? 'Discovering…' : 'Discover plans'}
          </button>
        </div>

        {discovering && (
          <p className="placeholder-text" data-testid="uw-wizard-loading">
            Scanning for plans folders…
          </p>
        )}

        {!discovering && emptyDiscovery && (
          <p className="placeholder-text" data-testid="uw-wizard-empty">
            No plans folders found under that folder.
          </p>
        )}

        {!discovering && plansRoots.length > 0 && (
          <>
            <div className="board-picker-list">
              {plansRoots.map(root => (
                <label
                  key={root.plansRootPath}
                  className="board-picker-row"
                  data-testid="uw-plan-root-row"
                >
                  <input
                    type="radio"
                    name="uw-plan-root"
                    checked={selectedRootPath === root.plansRootPath}
                    onChange={() => setSelectedRootPath(root.plansRootPath)}
                  />
                  <span className="board-picker-name">{root.plansRootPath}</span>
                  <span className="board-picker-id">
                    {root.featureEntries.length} features
                  </span>
                </label>
              ))}
            </div>

            <div className="form-row">
              <input
                className="input"
                type="text"
                data-testid="uw-field-name"
                placeholder="Board name"
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </div>

            <div className="form-row">
              <input
                className="input"
                type="text"
                data-testid="uw-field-projectKey"
                placeholder="PROJ"
                value={projectKey}
                onChange={event => setProjectKey(event.target.value)}
              />
            </div>

            <div className="form-row">
              <input
                className="input"
                type="text"
                data-testid="uw-field-projectName"
                placeholder="Project name (optional)"
                value={projectName}
                onChange={event => setProjectName(event.target.value)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
