import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';

interface GettingStartedProps {
  workspaces: WorkspaceRecord[];
  recentWorkspaceIds: string[];
  createdWorkspace?: WorkspaceRecord;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenWorkspaceFile: () => void;
  onOpenExistingFolder: () => Promise<boolean | void>;
  onCreateWorkspace: (name: string) => Promise<void>;
  onSkipSetup: () => void;
  onCreateProject: () => void;
  onContinueEmpty: () => void;
}

export function GettingStarted({
  workspaces,
  recentWorkspaceIds,
  createdWorkspace,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  onOpenExistingFolder,
  onCreateWorkspace,
  onSkipSetup,
  onCreateProject,
  onContinueEmpty
}: GettingStartedProps) {
  const [showSetup, setShowSetup] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [openingFolder, setOpeningFolder] = useState(false);
  const ordered = useMemo(() => {
    const rank = new Map(recentWorkspaceIds.map((id, index) => [id, index]));
    return [...workspaces].sort((left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || right.updatedAt.localeCompare(left.updatedAt));
  }, [recentWorkspaceIds, workspaces]);
  const visible = showAll ? ordered : ordered.slice(0, 5);

  useEffect(() => {
    if (createdWorkspace) setShowSetup(false);
  }, [createdWorkspace]);
  const showWorkspaceForm = showSetup && !createdWorkspace;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onCreateWorkspace(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  const openExistingFolder = async () => {
    if (openingFolder) return;
    setOpeningFolder(true);
    setError(undefined);
    try {
      const completed = await onOpenExistingFolder();
      if (completed === false) setOpeningFolder(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setOpeningFolder(false);
    }
  };

  return (
    <main className="getting-started" data-testid="getting-started">
      <section className="getting-started-copy" aria-labelledby="getting-started-title">
        <div className="getting-started-brand"><span>PRAXIS</span><i /></div>
        {createdWorkspace ? (
          <div className="getting-started-complete" data-testid="workspace-created-actions">
            <span className="getting-started-eyebrow">Workspace ready</span>
            <h1 id="getting-started-title">Start building in {createdWorkspace.name}</h1>
            <p>Your workspace is open. Add a project when you are ready, or continue with an empty workspace.</p>
            <div className="getting-started-primary-actions">
              <button className="getting-started-action primary" type="button" onClick={onCreateProject}>
                <span><Icon name="plus" size={18} /></span><strong>Add Project</strong><small>Create a project or connect an existing folder.</small><Icon name="chevron-right" size={16} />
              </button>
            </div>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="getting-started-text-action" type="button" onClick={onContinueEmpty}>Continue with Empty Workspace</button>
          </div>
        ) : showWorkspaceForm ? (
          <form className="getting-started-form" onSubmit={submit}>
            <span className="getting-started-eyebrow">Create your workspace</span>
            <h1 id="getting-started-title">Give your work a home</h1>
            <p>A workspace groups projects you want to return to together. You can make it portable later.</p>
            <label htmlFor="getting-started-workspace-name">Workspace name</label>
            <input id="getting-started-workspace-name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Product delivery" />
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="getting-started-form-actions">
              <button className="btn" type="button" onClick={() => setShowSetup(false)}>Back</button>
              <button className="btn btn-primary" type="submit" disabled={!name.trim() || saving}>{saving ? 'Creating…' : 'Create Workspace'}</button>
            </div>
          </form>
        ) : (
          <div className="getting-started-open">
            <span className="getting-started-eyebrow">Getting started</span>
            <h1 id="getting-started-title">Open a workspace</h1>
            <p>Open a recent workspace, start with an existing folder, or create a fresh context.</p>
            <div className="getting-started-recents" aria-label={showAll ? 'All workspaces' : 'Recent workspaces'}>
              {visible.map(workspace => (
                <button key={workspace.id} type="button" className="getting-started-recent" onClick={() => onOpenWorkspace(workspace.id)}>
                  <span className="getting-started-recent-mark"><Icon name="organization" size={17} /></span>
                  <span><strong>{workspace.name}</strong><small>{workspace.description || `${workspace.projectIds.length} project${workspace.projectIds.length === 1 ? '' : 's'}`}</small></span>
                  <Icon name="chevron-right" size={15} />
                </button>
              ))}
            </div>
            {!showAll && ordered.length > 5 && <button className="getting-started-text-action" type="button" onClick={() => setShowAll(true)}>View all workspaces</button>}
            {showAll && <button className="getting-started-text-action" type="button" onClick={() => setShowAll(false)}>Show recent workspaces</button>}
            <div className="getting-started-primary-actions">
              <button className="getting-started-action primary" type="button" onClick={() => void openExistingFolder()} disabled={openingFolder}>
                <span><Icon name="folder-open" size={18} /></span><strong>{openingFolder ? 'Opening folder…' : 'Open Folder'}</strong><small>Use a project folder as your starting point.</small><Icon name="chevron-right" size={16} />
              </button>
              <button className="getting-started-action" type="button" onClick={() => { setError(undefined); setShowSetup(true); }}>
                <span><Icon name="plus" size={18} /></span><strong>New Workspace</strong><small>Create an empty workspace for one or more projects.</small><Icon name="chevron-right" size={16} />
              </button>
            </div>
            <div className="getting-started-secondary-actions">
              <button className="getting-started-text-action" type="button" onClick={onOpenWorkspaceFile}>Open Workspace File</button>
              {workspaces.length === 0 && <button className="getting-started-text-action" type="button" onClick={onSkipSetup}>Continue without opening</button>}
            </div>
          </div>
        )}
      </section>

      <ProductPreview />
    </main>
  );
}

function ProductPreview() {
  return (
    <section className="getting-started-preview" aria-label="Workspace, project, and board structure preview">
      <div className="preview-window">
        <div className="preview-titlebar"><i /><i /><i /><span>Product Delivery</span></div>
        <div className="preview-layout">
          <aside className="preview-sidebar">
            <div className="preview-switcher"><Icon name="organization" size={12} /><b>Product Delivery</b><Icon name="chevron-down" size={10} /></div>
            <span className="preview-label">PROJECTS</span>
            <div className="preview-project active"><Icon name="folder-open" size={12} /><span>Praxis Desktop</span></div>
            <div className="preview-tree"><i /><span>Repository</span></div>
            <div className="preview-tree"><i /><span>Sessions</span></div>
            <div className="preview-project"><Icon name="folder-open" size={12} /><span>Website</span></div>
            <span className="preview-label lower">WORKSPACE</span>
            <div className="preview-link"><Icon name="home" size={11} /> Overview</div>
            <div className="preview-link"><Icon name="plug" size={11} /> Connections</div>
          </aside>
          <div className="preview-board">
            <header><div><small>PRAXIS DESKTOP</small><strong>Project workspace</strong></div><span>Files</span></header>
            <div className="preview-columns">
              <PreviewColumn title="FILES" count="3" cards={['README.md', 'src']} />
              <PreviewColumn title="SESSIONS" count="1" cards={['Start a session']} active />
              <PreviewColumn title="PLANNING" count="0" cards={['Add a board later']} />
            </div>
          </div>
        </div>
        <div className="preview-relationship"><span>Workspace</span><i /><span>Project</span><i /><span>Files</span></div>
      </div>
    </section>
  );
}

function PreviewColumn({ title, count, cards, active = false }: { title: string; count: string; cards: string[]; active?: boolean }) {
  return <div className={`preview-column${active ? ' active' : ''}`}><div><b>{title}</b><span>{count}</span></div>{cards.map((card, index) => <article key={card}><i className={index ? 'gold' : ''} /><strong>{card}</strong><small>{title === 'FILES' ? 'PROJECT FILE' : title === 'PLANNING' ? 'OPTIONAL' : 'PROJECT CONTEXT'}</small></article>)}</div>;
}
