import { useState } from 'react';

export function WorkspaceDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (name: string, description: string, storageFolder?: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [storageFolder, setStorageFolder] = useState<string>();
  const chooseLocation = async () => {
    const folder = await window.praxis.dialog.pickFolder('Choose workspace storage folder');
    if (folder) setStorageFolder(folder);
  };
  return <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
      <div className="workspace-dialog-header"><div><span className="git-eyebrow">PRAXIS CONTEXT</span><h2 id="workspace-dialog-title">Create workspace</h2></div><button className="icon-btn" aria-label="Close" onClick={onCancel}>×</button></div>
      <p className="workspace-dialog-intro">Group related projects, boards, and repository work into a context you can return to.</p>
      <label className="field-label" htmlFor="workspace-name">Name</label>
      <input id="workspace-name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Client Delivery" onKeyDown={event => { if (event.key === 'Enter' && name.trim()) onCreate(name.trim(), description.trim(), storageFolder); }} />
      <label className="field-label" htmlFor="workspace-description">Description <span>(optional)</span></label>
      <textarea id="workspace-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this workspace for?" rows={3} />
      <label className="field-label">Storage location</label>
      <div className="workspace-location-picker"><span>{storageFolder || 'Praxis user folder'}</span><button className="btn" type="button" onClick={() => void chooseLocation()}>{storageFolder ? 'Change folder' : 'Choose folder'}</button></div>
      <p className="workspace-location-help">Choose a repository folder to keep this workspace portable. Credentials remain on this device.</p>
      <div className="workspace-dialog-actions"><button className="btn" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), description.trim(), storageFolder)}>Create workspace</button></div>
    </div>
  </div>;
}
