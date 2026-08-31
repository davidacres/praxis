import { useState } from 'react';
import type { AgentToolMode, Board, ProjectRecord, ProjectStartingPoint, ProjectType } from '@praxis/core';
// Deep import on purpose: `@praxis/core`'s barrel pulls in node-only services
// (chokidar, node:fs) that cannot be bundled for the browser — importing
// PROJECT_BRIEF_FIELDS from the package root fails the vite build.
import { PROJECT_BRIEF_FIELDS } from '@praxis/core/out/projects/projectTemplates';
import { Icon } from '../ui/Icon';

const TOOL_MODE_LABEL: Record<AgentToolMode, string> = {
  'project-only': 'Project tools',
  'read-only': 'Read-only tools',
  full: 'Full tools'
};

export function ProjectHome({ project, boards, onChanged }: { project: ProjectRecord; boards: Board[]; onChanged: (project: ProjectRecord) => void; onOpenBoard: (boardId: string) => void; onOpenGit: () => void }) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<ProjectType>(project.type);
  const [toolMode, setToolMode] = useState<AgentToolMode>(project.defaultAiToolMode);
  const [purpose, setPurpose] = useState(project.purpose);
  const [brief, setBrief] = useState(project.brief);
  const [error, setError] = useState<string>();
  const [attachMode, setAttachMode] = useState<ProjectStartingPoint>('existing-folder');
  const [attachPath, setAttachPath] = useState('');
  const [folderName, setFolderName] = useState('');

  const candidates = boards.filter(board => !board.connectionId?.startsWith('project:') && board.connectionId && !project.linkedBoards.some(link => link.connectionId === board.connectionId && link.boardId === board.id));
  const briefFields = PROJECT_BRIEF_FIELDS[editing ? type : project.type];
  const filled = (project.purpose.trim() ? 1 : 0) + briefFields.filter(field => (project.brief[field.key] ?? '').trim()).length;
  const briefTotal = briefFields.length + 1;
  const inspection = project.folderInspection;
  const stack = inspection ? [...inspection.languages, ...inspection.frameworks, ...inspection.manifests] : [];
  const workspaceName = project.workspaceFolder?.split(/[\\/]/).filter(Boolean).pop();
  const boardCount = project.linkedBoards.length;
  const gitState: { label: string; on: boolean } = !project.workspaceFolder
    ? { label: 'No folder', on: false }
    : inspection?.hasGit
      ? { label: 'Git repo', on: true }
      : { label: inspection ? 'No repo' : 'Folder attached', on: false };

  const cancelEdit = () => { setEditing(false); setType(project.type); setToolMode(project.defaultAiToolMode); setPurpose(project.purpose); setBrief(project.brief); };
  const save = async () => { try { onChanged(await window.praxis.projects.update(project.id, { type, purpose, brief, defaultAiToolMode: toolMode })); setEditing(false); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const chooseAttach = async () => { const value = await window.praxis.dialog.pickFolder(attachMode === 'new-folder' ? 'Choose parent folder' : 'Choose existing project folder'); if (value) setAttachPath(value); };
  const attach = async () => { try { const result = await window.praxis.projects.attachFolder(project.id, { startingPoint: attachMode as 'new-folder' | 'existing-folder', folderPath: attachPath, folderName: folderName || undefined, createProjectFile: true }); onChanged(result.project); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };

  return <div className="project-home" data-testid="project-home">
    <header className="project-home-hero">
      <div className="project-home-id">
        <h1>{project.name}</h1>
        <p>{project.key} · {project.type} · {new Date(project.createdAt).toLocaleDateString()}</p>
      </div>
      {editing
        ? <div className="project-home-hero-actions"><button className="btn" onClick={cancelEdit}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></div>
        : <button className="icon-btn" title="Edit project brief" aria-label="Edit project brief" onClick={() => setEditing(true)}><Icon name="pencil" size={15} /></button>}
    </header>

    <div className="project-home-chips">
      <span className={`ph-chip${gitState.on ? ' is-on' : ''}`}><Icon name="git-branch" size={12} />{gitState.label}</span>
      <span className="ph-chip"><Icon name="tools" size={12} />{TOOL_MODE_LABEL[project.defaultAiToolMode]}</span>
      <span className="ph-chip"><Icon name="columns" size={12} />{boardCount ? `${boardCount} board${boardCount === 1 ? '' : 's'}` : 'No boards'}</span>
    </div>

    <div className="project-home-sections">
      <section className="project-panel">
        <div className="ph-section-head">
          <h2>Brief</h2>
          <span className="ph-progress"><i><b style={{ width: `${Math.round((filled / briefTotal) * 100)}%` }} /></i>{filled}/{briefTotal}</span>
        </div>
        {editing && <>
          <label className="field"><span>Project type</span><select className="input" value={type} onChange={e => setType(e.target.value as ProjectType)}><option value="software">Software Development</option><option value="product">Product Development</option><option value="research">Research</option><option value="experiment">Experiment / Prototype</option></select></label>
          <label className="field"><span>Default session tools</span><select className="input" value={toolMode} disabled={!project.workspaceFolder} onChange={e => setToolMode(e.target.value as AgentToolMode)}>{!project.workspaceFolder && <option value="project-only">Project-board tools only</option>}<option value="read-only">Read-only tools</option><option value="full">Full tools</option></select></label>
        </>}
        {editing
          ? <label className="field"><span>Purpose</span><textarea className="input textarea" value={purpose} onChange={e => setPurpose(e.target.value)} /></label>
          : <div className={`ph-brief-row${project.purpose.trim() ? ' is-filled' : ''}`}><Icon name={project.purpose.trim() ? 'check' : 'dot'} size={12} /><div><strong>Purpose</strong>{project.purpose.trim() && <p>{project.purpose}</p>}</div></div>}
        {briefFields.map(field => editing
          ? <label className="field" key={field.key}><span>{field.label}</span><textarea className="input textarea" value={brief[field.key] ?? ''} onChange={e => setBrief(current => ({ ...current, [field.key]: e.target.value }))} /></label>
          : <div className={`ph-brief-row${project.brief[field.key]?.trim() ? ' is-filled' : ''}`} key={field.key}><Icon name={project.brief[field.key]?.trim() ? 'check' : 'dot'} size={12} /><div><strong>{field.label}</strong>{project.brief[field.key]?.trim() && <p>{project.brief[field.key]}</p>}</div></div>)}
      </section>

      <section className="project-panel">
        <div className="ph-section-head"><h2>Workspace</h2></div>
        {project.workspaceFolder ? <>
          <div className="ph-path"><Icon name="folder-open" size={14} /><div><strong>{workspaceName}</strong><code>{project.workspaceFolder}</code></div></div>
          {stack.length > 0 && <div className="ph-tags">{stack.map(item => <span key={item}>{item}</span>)}</div>}
          {inspection && stack.length === 0 && <p className="muted">No languages or frameworks detected.</p>}
        </> : <>
          <p className="muted">Attach a folder to enable file and shell tools.</p>
          <div className="segmented"><button className={attachMode === 'existing-folder' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => setAttachMode('existing-folder')}>Existing</button><button className={attachMode === 'new-folder' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => setAttachMode('new-folder')}>New</button></div>
          <div className="folder-picker"><input className="input" value={attachPath} readOnly /><button className="btn" onClick={chooseAttach}>Choose…</button></div>
          {attachMode === 'new-folder' && <input className="input" placeholder="Folder name" value={folderName} onChange={e => setFolderName(e.target.value)} />}
          <button className="btn btn-primary" disabled={!attachPath} onClick={attach}>Attach folder</button>
        </>}
      </section>

      <section className="project-panel">
        <div className="ph-section-head"><h2>Planning sources</h2>{boardCount > 0 && <span className="ph-count">{boardCount}</span>}</div>
        {boardCount === 0 && <p className="muted">No board is linked yet. Boards connected to this project will appear here.</p>}
        {project.linkedBoards.map(link => <div className="linked-board" key={`${link.connectionId}:${link.boardId}`}>
          <div><strong>{link.displayName}</strong><small>{link.connectionId.startsWith('project-plans-') ? 'Local plans · read-only' : 'Linked board'}</small></div>
          <button className="icon-btn" title="Remove from planning sources" aria-label={`Remove ${link.displayName} from planning sources`} onClick={async () => onChanged(await window.praxis.projects.unlinkBoard(project.id, link.connectionId, link.boardId))}><Icon name="trash" size={14} /></button>
        </div>)}
        {candidates.length > 0 && <select className="input" defaultValue="" onChange={async e => { const board = candidates.find(item => `${item.connectionId}:${item.id}` === e.target.value); if (board?.connectionId) onChanged(await window.praxis.projects.linkBoard(project.id, { connectionId: board.connectionId, boardId: board.id, displayName: board.name })); e.target.value = ''; }}><option value="">Link an existing board…</option>{candidates.map(board => <option key={`${board.connectionId}:${board.id}`} value={`${board.connectionId}:${board.id}`}>{board.name}</option>)}</select>}
      </section>
    </div>
    {error && <div className="form-error">{error}</div>}
  </div>;
}
