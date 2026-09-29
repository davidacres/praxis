import type { ProjectStartingPoint } from '@praxis/core';
import { Icon } from '../ui/Icon';

export type AddProjectChoice =
  | { mode: 'existing'; startingPoint: 'existing-folder' }
  | { mode: 'create'; startingPoint: Exclude<ProjectStartingPoint, 'existing-folder'> };

export function AddProjectDialog({ onCancel, onSelect }: {
  onCancel: () => void;
  onSelect: (choice: AddProjectChoice) => void;
}) {
  return <div className="workspace-dialog-backdrop" data-testid="add-project-options" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
      <div className="workspace-dialog-header"><div><span className="git-eyebrow">PROJECT</span><h2 id="add-project-title">Add project</h2></div><button className="icon-btn" aria-label="Close" onClick={onCancel}>×</button></div>
      <p className="workspace-dialog-intro">Choose where the project starts. Boards and planning sources can be added later.</p>
      <div className="getting-started-primary-actions">
        <button className="getting-started-action primary" data-testid="add-project-open-folder" type="button" onClick={() => onSelect({ mode: 'existing', startingPoint: 'existing-folder' })}>
          <span><Icon name="folder-open" size={18} /></span><strong>Open existing folder</strong><small>Use files already on this computer.</small><Icon name="chevron-right" size={16} />
        </button>
        <button className="getting-started-action" data-testid="add-project-new-folder" type="button" onClick={() => onSelect({ mode: 'create', startingPoint: 'new-folder' })}>
          <span><Icon name="plus" size={18} /></span><strong>Create new folder</strong><small>Start a project in a new folder.</small><Icon name="chevron-right" size={16} />
        </button>
        <button className="getting-started-action" data-testid="add-project-no-folder" type="button" onClick={() => onSelect({ mode: 'create', startingPoint: 'app-storage' })}>
          <span><Icon name="organization" size={18} /></span><strong>Project without a folder</strong><small>Start with a brief and connect files later.</small><Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className="workspace-dialog-actions"><button className="btn" onClick={onCancel}>Cancel</button></div>
    </div>
  </div>;
}
