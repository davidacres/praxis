import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';

interface GettingStartedProps {
  workspaces: WorkspaceRecord[];
  recentWorkspaceIds: string[];
  createdWorkspace?: WorkspaceRecord;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenWorkspaceFile: () => void;
  onCreateWorkspace: (name: string, description: string, storageFolder?: string) => Promise<void>;
  onStartFirstProject: (wizardMode: 'create' | 'existing') => Promise<void>;
  onSkipSetup: () => void;
  onCreateProject: () => void;
  onAddExistingProject: () => void;
  onContinueEmpty: () => void;
}

export function GettingStarted({
  workspaces,
  recentWorkspaceIds,
  createdWorkspace,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  onCreateWorkspace,
  onStartFirstProject,
  onSkipSetup,
  onCreateProject,
  onAddExistingProject,
  onContinueEmpty
}: GettingStartedProps) {
  const [showSetup, setShowSetup] = useState(false);
  const [setupChosen, setSetupChosen] = useState(false);
  const [nameWorkspaceFirst, setNameWorkspaceFirst] = useState(false);
  const firstRun = workspaces.length === 0;
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [storageFolder, setStorageFolder] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ordered = useMemo(() => {
    const rank = new Map(recentWorkspaceIds.map((id, index) => [id, index]));
    return [...workspaces].sort((left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || right.updatedAt.localeCompare(left.updatedAt));
  }, [recentWorkspaceIds, workspaces]);
  const visible = showAll ? ordered : ordered.slice(0, 5);

  useEffect(() => {
    if (workspaces.length > 0 && !setupChosen) setShowSetup(false);
  }, [setupChosen, workspaces.length]);
  const showFirstProject = firstRun && !nameWorkspaceFirst && !setupChosen && !createdWorkspace;
  const showWorkspaceForm = showSetup || (firstRun && nameWorkspaceFirst) || (firstRun && !showFirstProject && !createdWorkspace);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onCreateWorkspace(name.trim(), description.trim(), storageFolder);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
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
            <p>Your workspace is open. Add its first project now, bring in an existing folder, or continue with an empty workspace.</p>
            <div className="getting-started-primary-actions">
              <button className="getting-started-action primary" type="button" onClick={onCreateProject}>
                <span><Icon name="plus" size={18} /></span><strong>Create New Project</strong><small>Start with a brief, board, and focused starter work.</small><Icon name="chevron-right" size={16} />
              </button>
              <button className="getting-started-action" type="button" onClick={onAddExistingProject}>
                <span><Icon name="folder-open" size={18} /></span><strong>Create from existing folder</strong><small>Scan its plans and connect the work to this workspace.</small><Icon name="chevron-right" size={16} />
              </button>
            </div>
            <button className="getting-started-text-action" type="button" onClick={onContinueEmpty}>Continue with Empty Workspace</button>
          </div>
        ) : showFirstProject ? (
          <div className="getting-started-complete" data-testid="first-project-actions">
            <span className="getting-started-eyebrow">Welcome to Praxis</span>
            <h1 id="getting-started-title">Create your first project</h1>
            <p>A project holds a brief, a board, and focused starter work. Praxis groups projects into a workspace — one is set up for you now, and you can rename it any time.</p>
            <div className="getting-started-primary-actions">
              <button className="getting-started-action primary" type="button" onClick={() => void onStartFirstProject('create')}>
                <span><Icon name="plus" size={18} /></span><strong>New project</strong><small>Start with a brief, board, and focused starter work.</small><Icon name="chevron-right" size={16} />
              </button>
              <button className="getting-started-action" type="button" onClick={() => void onStartFirstProject('existing')}>
                <span><Icon name="folder-open" size={18} /></span><strong>Create from an existing folder</strong><small>Scan its plans and connect the work to a project.</small><Icon name="chevron-right" size={16} />
              </button>
            </div>
            <div className="getting-started-secondary-actions">
              <button className="getting-started-text-action" type="button" onClick={() => setNameWorkspaceFirst(true)}>Name a workspace first</button>
              <button className="getting-started-text-action" type="button" onClick={onOpenWorkspaceFile}>Open a workspace file</button>
              <button className="getting-started-text-action" type="button" onClick={onSkipSetup}>Skip for now</button>
            </div>
          </div>
        ) : showWorkspaceForm ? (
          <form className="getting-started-form" onSubmit={submit}>
            <span className="getting-started-eyebrow">Create your workspace</span>
            <h1 id="getting-started-title">Give your work a home</h1>
            <p>A workspace is the top-level context in Praxis. Projects, their boards, and repository work live inside it.</p>
            <label htmlFor="getting-started-workspace-name">Workspace name</label>
            <input id="getting-started-workspace-name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Product delivery" />
            <label htmlFor="getting-started-workspace-description">Description <span>(optional)</span></label>
            <textarea id="getting-started-workspace-description" value={description} onChange={event => setDescription(event.target.value)} rows={3} placeholder="What belongs in this workspace?" />
            <label htmlFor="getting-started-workspace-location">Storage location</label>
            <div className="workspace-location-picker" id="getting-started-workspace-location"><span>{storageFolder || 'Praxis user folder'}</span><button className="btn" type="button" onClick={async () => { const folder = await window.praxis.dialog.pickFolder('Choose workspace storage folder'); if (folder) setStorageFolder(folder); }}>{storageFolder ? 'Change folder' : 'Choose folder'}</button></div>
            <p className="workspace-location-help">A selected folder keeps the workspace file with your repository. Credentials stay on this device.</p>
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="getting-started-form-actions">
              <button className="btn" type="button" onClick={onSkipSetup}>Skip for now</button>
              {(workspaces.length > 0 || nameWorkspaceFirst) && <button className="btn" type="button" onClick={() => { setShowSetup(false); setNameWorkspaceFirst(false); }}>Back</button>}
              <button className="btn btn-primary" type="submit" disabled={!name.trim() || saving}>{saving ? 'Creating…' : 'Create Workspace'}</button>
            </div>
          </form>
        ) : (
          <div className="getting-started-open">
            <span className="getting-started-eyebrow">Getting started</span>
            <h1 id="getting-started-title">Open a workspace</h1>
            <p>Choose a recent workspace to continue with its projects and boards, or create a fresh context.</p>
            <div className="getting-started-recents" aria-label={showAll ? 'All workspaces' : 'Recent workspaces'}>
              {visible.map(workspace => (
                <button key={workspace.id} type="button" className="getting-started-recent" onClick={() => onOpenWorkspace(workspace.id)}>
                  <span className="getting-started-recent-mark"><Icon name="organization" size={17} /></span>
                  <span><strong>{workspace.name}</strong><small>{workspace.description || `${workspace.projectIds.length} project${workspace.projectIds.length === 1 ? '' : 's'}`}</small></span>
                  <Icon name="chevron-right" size={15} />
                </button>
              ))}
            </div>
            {!showAll && <button className="getting-started-text-action" type="button" onClick={() => setShowAll(true)}>View all workspaces</button>}
            {showAll && <button className="getting-started-text-action" type="button" onClick={() => setShowAll(false)}>Show recent workspaces</button>}
            <div className="getting-started-secondary-actions">
              <button className="btn btn-primary" type="button" onClick={() => { setSetupChosen(true); setShowSetup(true); }}><Icon name="plus" size={14} /> Create Workspace</button>
              <button className="btn" type="button" onClick={onOpenWorkspaceFile}><Icon name="folder-open" size={14} /> Open Workspace File</button>
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
            <div className="preview-tree"><i /><span>Planning board</span></div>
            <div className="preview-tree"><i /><span>Repository</span></div>
            <div className="preview-project"><Icon name="folder-open" size={12} /><span>Website</span></div>
            <span className="preview-label lower">WORKSPACE</span>
            <div className="preview-link"><Icon name="home" size={11} /> Overview</div>
            <div className="preview-link"><Icon name="plug" size={11} /> Connections</div>
          </aside>
          <div className="preview-board">
            <header><div><small>PRAXIS DESKTOP</small><strong>Planning board</strong></div><span>Board</span></header>
            <div className="preview-columns">
              <PreviewColumn title="BACKLOG" count="3" cards={['Workspace onboarding', 'Project creation']} />
              <PreviewColumn title="IN PROGRESS" count="1" cards={['Getting Started']} active />
              <PreviewColumn title="DONE" count="2" cards={['Workspace model', 'Theme tokens']} />
            </div>
          </div>
        </div>
        <div className="preview-relationship"><span>Workspace</span><i /><span>Project</span><i /><span>Board</span></div>
      </div>
    </section>
  );
}

function PreviewColumn({ title, count, cards, active = false }: { title: string; count: string; cards: string[]; active?: boolean }) {
  return <div className={`preview-column${active ? ' active' : ''}`}><div><b>{title}</b><span>{count}</span></div>{cards.map((card, index) => <article key={card}><i className={index ? 'gold' : ''} /><strong>{card}</strong><small>{index ? 'TASK' : 'FEATURE'} · P{index + 1}</small></article>)}</div>;
}
