import { useState } from 'react';
import type {
  AgentToolMode, Board, Connection, ProjectRecord, ProjectStartingPoint, ProjectType,
  ProjectWorkflowCategory, ProjectWorkflowStage
} from '@praxis/core';
// Deep import on purpose: `@praxis/core`'s barrel pulls in node-only services
// (chokidar, node:fs) that cannot be bundled for the browser — importing
// PROJECT_BRIEF_FIELDS from the package root fails the vite build.
import { PROJECT_BRIEF_FIELDS } from '@praxis/core/out/projects/projectTemplates';
import { Icon } from '../ui/Icon';

const CATEGORY_LABEL: Record<ProjectWorkflowCategory, string> = {
  todo: 'Not started',
  indeterminate: 'In flight',
  done: 'Done'
};

const TOOL_MODE_LABEL: Record<AgentToolMode, string> = {
  'project-only': 'Project tools',
  'read-only': 'Read-only tools',
  full: 'Full tools'
};

export function ProjectHome({ project, boards, connections, onChanged }: { project: ProjectRecord; boards: Board[]; connections: Connection[]; onChanged: (project: ProjectRecord) => void; onOpenBoard: (boardId: string) => void; onOpenGit: () => void }) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<ProjectType>(project.type);
  const [toolMode, setToolMode] = useState<AgentToolMode>(project.defaultAiToolMode);
  const [purpose, setPurpose] = useState(project.purpose);
  const [brief, setBrief] = useState(project.brief);
  const [stages, setStages] = useState<ProjectWorkflowStage[]>(project.workflowStages);
  const [error, setError] = useState<string>();
  const [attachMode, setAttachMode] = useState<ProjectStartingPoint>('existing-folder');
  const [attachPath, setAttachPath] = useState('');
  const [folderName, setFolderName] = useState('');

  const candidates = boards.filter(board => board.connectionId
    && connections.find(connection => connection.id === board.connectionId)?.settings.projectId !== project.id
    && !project.linkedBoards.some(link => link.connectionId === board.connectionId && link.boardId === board.id));
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

  const cancelEdit = () => { setEditing(false); setType(project.type); setToolMode(project.defaultAiToolMode); setPurpose(project.purpose); setBrief(project.brief); setStages(project.workflowStages); setError(undefined); };

  // How many tickets sit on each stage, so renaming or removing one can say
  // what it will move rather than silently re-resolving.
  const ticketsOn = (stageName: string) =>
    project.workItems.filter(item => item.status === stageName).length;
  const moveStage = (index: number, delta: number) => setStages(current => {
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const editStage = (index: number, patch: Partial<ProjectWorkflowStage>) =>
    setStages(current => current.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)));
  const addStage = () => setStages(current => [
    ...current.slice(0, current.length - 1),
    { id: `stage-${Date.now().toString(36)}`, name: 'New stage', category: 'indeterminate' },
    ...current.slice(current.length - 1)
  ]);
  const removeStage = (index: number) => setStages(current => current.filter((_, i) => i !== index));
  const save = async () => { try { onChanged(await window.praxis.projects.update(project.id, { type, purpose, brief, defaultAiToolMode: toolMode, workflowStages: stages })); setEditing(false); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const chooseAttach = async () => { const value = await window.praxis.dialog.pickFolder(attachMode === 'new-folder' ? 'Choose parent folder' : 'Choose existing project folder'); if (value) setAttachPath(value); };
  const attach = async () => { try { const result = await window.praxis.projects.attachFolder(project.id, { startingPoint: attachMode as 'new-folder' | 'existing-folder', folderPath: attachPath, folderName: folderName || undefined, createProjectFile: true }); onChanged(result.project); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };

  return <div className="project-home" data-testid="project-home">
    <header className="project-home-hero">
      <div className="project-home-id">
        <h1>{project.name}</h1>
        {/* A project created during a test run carries today's date, so this is
            tagged for snapshot masking — otherwise every baseline showing this
            header expires at midnight. */}
        <p>{project.key} · {project.type} · <span data-testid="project-created-date">{new Date(project.createdAt).toLocaleDateString()}</span></p>
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

      <section className="project-panel" data-testid="project-workflow">
        <div className="ph-section-head">
          <h2>Workflow</h2>
          <span className="ph-count">{(editing ? stages : project.workflowStages).length}</span>
        </div>
        <p className="ph-hint">The columns this project&rsquo;s board shows, in order. The last stage is what &ldquo;done&rdquo; means.</p>
        {(editing ? stages : project.workflowStages).map((stage, index, all) => editing
          ? <div className="ph-stage is-editing" key={stage.id} data-testid={`workflow-stage-${index}`}>
              <input
                className="input"
                aria-label={`Stage ${index + 1} name`}
                value={stage.name}
                onChange={e => editStage(index, { name: e.target.value })}
              />
              <select
                className="input"
                aria-label={`Stage ${index + 1} category`}
                value={stage.category ?? 'indeterminate'}
                onChange={e => editStage(index, { category: e.target.value as ProjectWorkflowCategory })}
              >
                {(['todo', 'indeterminate', 'done'] as const).map(value =>
                  <option key={value} value={value}>{CATEGORY_LABEL[value]}</option>)}
              </select>
              <div className="ph-stage-actions">
                <button className="icon-btn icon-btn-sm" title="Move up" aria-label={`Move ${stage.name} up`} disabled={index === 0} onClick={() => moveStage(index, -1)}><Icon name="arrow-up" size={12} /></button>
                <button className="icon-btn icon-btn-sm" title="Move down" aria-label={`Move ${stage.name} down`} disabled={index === all.length - 1} onClick={() => moveStage(index, 1)}><Icon name="chevron-down" size={12} /></button>
                <button className="icon-btn icon-btn-sm" title="Remove stage" aria-label={`Remove ${stage.name}`} disabled={all.length <= 2} onClick={() => removeStage(index)}><Icon name="trash" size={12} /></button>
              </div>
            </div>
          : <div className="ph-stage" key={stage.id} data-testid={`workflow-stage-${index}`}>
              <span className={`ph-stage-dot is-${stage.category ?? 'indeterminate'}`} aria-hidden="true" />
              <strong>{stage.name}</strong>
              <span className="ph-stage-meta">{CATEGORY_LABEL[stage.category ?? 'indeterminate']}{ticketsOn(stage.name) > 0 ? ` · ${ticketsOn(stage.name)} ticket${ticketsOn(stage.name) === 1 ? '' : 's'}` : ''}</span>
            </div>)}
        {editing && <>
          <button className="btn btn-quiet" onClick={addStage} data-testid="workflow-add-stage">+ Add stage</button>
          {stages.some((stage, index) => stage.name !== project.workflowStages[index]?.name && ticketsOn(project.workflowStages[index]?.name ?? '') > 0) &&
            <p className="ph-hint is-warn" data-testid="workflow-rename-warning">
              Renaming a stage re-resolves the tickets on it to the closest remaining stage.
            </p>}
          {project.workflowStages.some(stage =>
            ticketsOn(stage.name) > 0 && !stages.some(next => next.name === stage.name)) &&
            <p className="ph-hint is-warn" data-testid="workflow-remove-warning">
              A removed stage&rsquo;s tickets move to the closest remaining stage of the same kind.
            </p>}
        </>}
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
