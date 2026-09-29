import { useState } from 'react';

export function WorkspaceDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (name: string, description: string) => void }) {
  const [name, setName] = useState('');
  return <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
      <div className="workspace-dialog-header"><div><span className="git-eyebrow">PRAXIS CONTEXT</span><h2 id="workspace-dialog-title">Create workspace</h2></div><button className="icon-btn" aria-label="Close" onClick={onCancel}>×</button></div>
      <p className="workspace-dialog-intro">Group projects you want to return to together. You can make the workspace portable later.</p>
      <label className="field-label" htmlFor="workspace-name">Name</label>
      <input id="workspace-name" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Client Delivery" onKeyDown={event => { if (event.key === 'Enter' && name.trim()) onCreate(name.trim(), ''); }} />
      <div className="workspace-dialog-actions"><button className="btn" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), '')}>Create workspace</button></div>
    </div>
  </div>;
}
