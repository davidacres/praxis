import { useState } from 'react';

export function WorkspaceDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (name: string, description: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
      <div className="workspace-dialog-header"><div><span className="git-eyebrow">PRAXIS CONTEXT</span><h2 id="workspace-dialog-title">Create workspace</h2></div><button className="icon-btn" aria-label="Close" onClick={onCancel}>×</button></div>
      <p className="workspace-dialog-intro">Group related projects, boards, and repository work into a context you can return to.</p>
      <label className="field-label" htmlFor="workspace-name">Name</label>
      <input id="workspace-name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Client Delivery" onKeyDown={event => { if (event.key === 'Enter' && name.trim()) onCreate(name.trim(), description.trim()); }} />
      <label className="field-label" htmlFor="workspace-description">Description <span>(optional)</span></label>
      <textarea id="workspace-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this workspace for?" rows={3} />
      <div className="workspace-dialog-actions"><button className="btn" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), description.trim())}>Create workspace</button></div>
    </div>
  </div>;
}
