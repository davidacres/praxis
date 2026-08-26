import { useEffect, useMemo, useState } from 'react';
import {
  type AgentToolMode,
  type CreateProjectInput,
  type FolderInspection,
  type ProjectRecord,
  type ProjectStartingPoint,
  type ProjectType
} from '@ticket-manager/core';
import { PROJECT_BRIEF_FIELDS, defaultProjectTickets, defaultProjectWorkflow } from '@ticket-manager/core/out/projects/projectTemplates';
import projectTypeArtwork from './assets/project-types.png';

const TYPES: Array<{ id: ProjectType; title: string; description: string }> = [
  { id: 'software', title: 'Software Development', description: 'Build or change a software system.' },
  { id: 'product', title: 'Product Development', description: 'Define and deliver a product outcome.' },
  { id: 'research', title: 'Research', description: 'Gather evidence and produce recommendations.' },
  { id: 'experiment', title: 'Experiment / Prototype', description: 'Test a hypothesis within a timebox.' }
];

const CREATE_STEP_COPY = [
  { title: 'Choose a project type', detail: 'Pick the planning model that best matches the outcome you want to create.' },
  { title: 'Name and locate your project', detail: 'Set the project identity and choose where its working files will live.' },
  { title: 'Shape the brief', detail: 'Capture enough context to make the first work items useful and focused.' },
  { title: 'Set up the initial plan', detail: 'Review the workflow and starter tickets. Everything remains editable later.' },
  { title: 'Choose tool access', detail: 'Set the default permissions for future sessions without starting AI now.' },
  { title: 'Review and create', detail: 'Confirm exactly what Ticket Manager will create.' }
] as const;

const EXISTING_STEP_COPY = [
  { title: 'Choose the existing folder', detail: 'Ticket Manager will inspect this folder without changing it.' },
  { title: 'Describe the project', detail: 'Confirm its type and identity. Detected files remain untouched.' },
  { title: 'Shape the brief', detail: 'Capture the context that is not obvious from the repository itself.' },
  { title: 'Set up the initial plan', detail: 'Review the local workflow and starter tickets added to Ticket Manager.' },
  { title: 'Choose tool access', detail: 'Set the default permissions for future sessions without starting AI now.' },
  { title: 'Review and add', detail: 'Confirm what Ticket Manager will record alongside the existing folder.' }
] as const;

export function NewProjectWizard({ mode = 'create', onCancel, onCreated }: { mode?: 'create' | 'existing'; onCancel: () => void; onCreated: (project: ProjectRecord) => void }) {
  const [step, setStep] = useState(0);
  const [type, setType] = useState<ProjectType>('software');
  const [startingPoint, setStartingPoint] = useState<ProjectStartingPoint>(mode === 'existing' ? 'existing-folder' : 'new-folder');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  const [inspection, setInspection] = useState<FolderInspection>();
  const [brief, setBrief] = useState<Record<string, string>>({});
  const [stages, setStages] = useState(() => defaultProjectWorkflow('software'));
  const [tickets, setTickets] = useState(() => defaultProjectTickets('software'));
  const [toolMode, setToolMode] = useState<AgentToolMode>('full');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const stepCopy = mode === 'existing' ? EXISTING_STEP_COPY : CREATE_STEP_COPY;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [creating, onCancel]);

  useEffect(() => {
    if (startingPoint === 'app-storage' && type !== 'product' && type !== 'research') setStartingPoint('new-folder');
    setStages(defaultProjectWorkflow(type)); setTickets(defaultProjectTickets(type)); setBrief({});
    setToolMode(type === 'software' || type === 'experiment' ? 'full' : 'read-only');
  }, [type]);
  useEffect(() => {
    if (!keyEdited) setKey(slugKey(name));
    if (!folderNameEdited) setFolderName(slugFolder(name));
  }, [name, keyEdited, folderNameEdited]);
  useEffect(() => { if (startingPoint === 'app-storage') setToolMode('project-only'); else setToolMode(type === 'software' || type === 'experiment' ? 'full' : 'read-only'); }, [startingPoint, type]);

  const previewPath = startingPoint === 'new-folder' && folderPath ? `${folderPath.replace(/[\\/]$/, '')}/${folderName}` : folderPath;
  const input: CreateProjectInput = useMemo(() => ({
    name, key, type, purpose, brief, startingPoint, folderPath: folderPath || undefined,
    folderName: folderName || undefined, workflowStages: stages, starterTickets: tickets, defaultAiToolMode: toolMode
  }), [name, key, type, purpose, brief, startingPoint, folderPath, folderName, stages, tickets, toolMode]);

  const chooseFolder = async () => {
    const chosen = await window.ticketManager.dialog.pickFolder(startingPoint === 'new-folder' ? 'Choose parent folder' : 'Choose existing project folder');
    if (!chosen) return;
    setFolderPath(chosen); setError(undefined);
    if (startingPoint === 'existing-folder') setInspection(await window.ticketManager.projects.inspectFolder(chosen));
    else setInspection(undefined);
  };
  const continueStep = async () => {
    setError(undefined);
    try {
      if (step === 0 && mode === 'existing') {
        if (!folderPath) throw new Error('Choose the existing project folder.');
        const result = inspection ?? await window.ticketManager.projects.inspectFolder(folderPath);
        if (!result.exists || !result.isDirectory) throw new Error('Choose an existing folder.');
        setInspection(result);
      }
      if (step === 1) {
        if (!name.trim()) throw new Error('Enter a project name.');
        if (!/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(key)) throw new Error('Use a 1-15 character key starting with a letter.');
        if (startingPoint !== 'app-storage' && !folderPath) throw new Error(mode === 'existing' ? 'Choose the existing folder.' : 'Choose a parent folder.');
        if (startingPoint === 'new-folder') {
          if (!folderName.trim()) throw new Error('Enter a project folder name.');
          const result = await window.ticketManager.projects.inspectFolder(previewPath);
          if (result.exists) throw new Error('That folder already exists. Select Existing Folder instead.');
        }
      }
      if (step === 3 && (stages.length < 2 || tickets.some(ticket => !ticket.summary.trim()))) throw new Error('Keep at least two stages and give every starter ticket a title.');
      setStep(value => Math.min(5, value + 1));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const create = async () => {
    setCreating(true); setError(undefined);
    try { onCreated(await window.ticketManager.projects.create(input)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCreating(false); }
  };

  return <div className="project-wizard" data-testid="new-project-wizard">
    <header className="project-wizard-header">
      <div className="project-dialog-heading"><span className="project-dialog-mark">{mode === 'existing' ? '↳' : '+'}</span><div><h1 id="new-project-dialog-title">{mode === 'existing' ? 'Add existing project' : 'Create new project'}</h1><p>{mode === 'existing' ? 'Bring an existing workspace into Projects without changing its source files.' : 'Start with a durable brief, a local board, and focused starter work.'}</p></div></div>
      <div className="project-dialog-header-actions"><div className="step-count">Step {step + 1} of 6</div><button className="project-dialog-close" aria-label="Close new project dialog" onClick={onCancel}>×</button></div>
    </header>
    <div className="wizard-progress" aria-label={`Step ${step + 1} of 6`}>{Array.from({ length: 6 }, (_, index) => <span key={index} className={index <= step ? 'active' : ''} />)}</div>
    <div className="project-wizard-body">
      <div className="wizard-step-intro"><span>{String(step + 1).padStart(2, '0')}</span><div><h2>{stepCopy[step].title}</h2><p>{stepCopy[step].detail}</p></div></div>
      {step === 0 && (mode === 'create' ? <ProjectTypeCards type={type} onChange={setType} /> : <div className="existing-folder-step"><div className="existing-folder-picker"><div className="existing-folder-visual">↳</div><div><strong>Select the project folder</strong><p>We look for Git, README files, manifests, languages, and frameworks.</p></div><button className="btn btn-primary" onClick={chooseFolder}>Choose folder…</button></div>{inspection ? <Inspection result={inspection} /> : <div className="inspection-placeholder"><span>Workspace detection will appear here</span><small>No files are created or modified during inspection.</small></div>}</div>)}
      {step === 1 && <div className="project-form-grid">
        {mode === 'existing' && <div className="span-2"><h3 className="wizard-section-title first">Project type</h3><ProjectTypeCards type={type} onChange={setType} compact /></div>}
        <label className="field span-2"><span>Project name</span><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
        <label className="field"><span>Project key</span><input className="input" value={key} onChange={e => { setKeyEdited(true); setKey(e.target.value.toUpperCase()); }} /></label>
        {mode === 'create' && (type === 'product' || type === 'research') && <div className="field"><span>Project storage</span><div className="inline-choice"><button className={startingPoint === 'new-folder' ? 'active' : ''} onClick={() => setStartingPoint('new-folder')}>New folder</button><button className={startingPoint === 'app-storage' ? 'active' : ''} onClick={() => setStartingPoint('app-storage')}>App storage</button></div></div>}
        {mode === 'existing' && <label className="field"><span>Existing folder</span><div className="folder-picker"><input className="input" value={folderPath} readOnly /><button className="btn" onClick={chooseFolder}>Change…</button></div></label>}
        {mode === 'create' && startingPoint !== 'app-storage' && <label className="field"><span>Parent folder</span><div className="folder-picker"><input className="input" value={folderPath} readOnly /><button className="btn" onClick={chooseFolder}>Choose…</button></div></label>}
        {startingPoint === 'new-folder' && <label className="field span-2"><span>Project folder name</span><input className="input" value={folderName} onChange={e => { setFolderNameEdited(true); setFolderName(e.target.value); }} /><small>Will create: {previewPath || 'Choose a parent folder'}</small></label>}
        <label className="field span-2"><span>Purpose</span><textarea className="input textarea" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Why does this project exist?" /></label>
        {mode === 'existing' && inspection && <Inspection result={inspection} />}
      </div>}
      {step === 2 && <div className="brief-grid">{PROJECT_BRIEF_FIELDS[type].map(field => <label className="field" key={field.key}><span>{field.label}</span><textarea className="input textarea" value={brief[field.key] ?? ''} onChange={e => setBrief(current => ({ ...current, [field.key]: e.target.value }))} /></label>)}</div>}
      {step === 3 && <div className="plan-edit-grid"><section><div className="section-heading"><h2>Workflow stages</h2><button className="btn" onClick={() => setStages(current => [...current, { id: `stage-${Date.now()}`, name: 'New stage' }])}>Add stage</button></div>{stages.map((stage, index) => <div className="editable-row" key={stage.id}><span>{index + 1}</span><input className="input" value={stage.name} onChange={e => { const value = e.target.value; setStages(current => current.map(item => item.id === stage.id ? { ...item, name: value } : item)); setTickets(current => current.map(ticket => ticket.status === stage.name ? { ...ticket, status: value } : ticket)); }} /><button className="icon-btn" aria-label="Remove stage" onClick={() => setStages(current => current.filter(item => item.id !== stage.id))}>×</button></div>)}</section>
        <section><div className="section-heading"><h2>Starter tickets</h2><button className="btn" onClick={() => setTickets(current => [...current, { summary: '', description: '', issueType: 'Task', status: stages[0]?.name ?? '' }])}>Add ticket</button></div>{tickets.map((ticket, index) => <div className="ticket-edit" key={index}><input className="input" value={ticket.summary} onChange={e => setTickets(current => current.map((item, i) => i === index ? { ...item, summary: e.target.value } : item))} /><select className="input" value={ticket.status} onChange={e => setTickets(current => current.map((item, i) => i === index ? { ...item, status: e.target.value } : item))}>{stages.map(stage => <option key={stage.id}>{stage.name}</option>)}</select><button className="icon-btn" aria-label="Remove ticket" onClick={() => setTickets(current => current.filter((_, i) => i !== index))}>×</button></div>)}</section></div>}
      {step === 4 && <div className="ai-default-card"><h2>Default session tools</h2><p>Provider and model are still chosen when each session starts.</p>{startingPoint === 'app-storage' ? <div className="locked-default"><strong>Project-board tools only</strong><span>File and shell tools are unavailable because this project has no folder.</span></div> : <div className="project-start-options"><Choice checked={toolMode === 'full'} title="Full tools" detail="Read, edit and run commands in the project folder." onClick={() => setToolMode('full')} /><Choice checked={toolMode === 'read-only'} title="Read-only tools" detail="Inspect the project folder without changing it." onClick={() => setToolMode('read-only')} /></div>}</div>}
      {step === 5 && <div className="project-confirm"><div className="confirm-summary"><span className="project-type-badge">{typeLabel(type)}</span><h2>{name}</h2><code>{key}</code><p>{purpose || 'No purpose supplied.'}</p></div><dl><dt>Storage</dt><dd>{startingPoint === 'app-storage' ? 'App-managed storage (no folder)' : previewPath}</dd><dt>Default board</dt><dd>{tickets.length} editable starter tickets across {stages.length} stages</dd><dt>Project file</dt><dd>{startingPoint === 'app-storage' ? 'None' : 'Create PROJECT.md once; retain any existing file'}</dd><dt>AI</dt><dd>No AI starts automatically · {toolModeLabel(toolMode)}</dd></dl></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
    <footer className="project-wizard-footer"><button className="btn" onClick={onCancel}>Cancel</button><div className="footer-actions">{step > 0 && <button className="btn" onClick={() => { setError(undefined); setStep(value => value - 1); }}>Back</button>}<button className="btn btn-primary" disabled={creating} onClick={step === 5 ? create : continueStep}>{step === 5 ? creating ? (mode === 'existing' ? 'Adding…' : 'Creating…') : mode === 'existing' ? 'Add project' : 'Create project' : 'Continue'}</button></div></footer>
  </div>;
}

function ProjectTypeCards({ type, onChange, compact = false }: { type: ProjectType; onChange: (type: ProjectType) => void; compact?: boolean }) { return <div className={`project-card-grid${compact ? ' compact' : ''}`}>{TYPES.map(option => <button key={option.id} className={`project-choice${type === option.id ? ' selected' : ''}`} onClick={() => onChange(option.id)}><span className={`project-choice-image ${option.id}`} style={{ backgroundImage: `url(${projectTypeArtwork})` }} /><span className="project-choice-copy"><strong>{option.title}</strong><span>{option.description}</span></span><span className="project-choice-check">✓</span></button>)}</div>; }

function Choice({ checked, title, detail, onClick }: { checked: boolean; title: string; detail: string; onClick: () => void }) { return <button className={`start-choice${checked ? ' selected' : ''}`} onClick={onClick}><span className="radio-dot" /><span><strong>{title}</strong><small>{detail}</small></span></button>; }
function Inspection({ result }: { result: FolderInspection }) { return <div className="inspection-card span-2"><strong>Workspace detected</strong><span>{result.hasGit ? 'Git repository' : 'No Git repository'} · {result.readme ?? 'No README'}</span><span>{result.languages.join(', ') || 'No languages detected'}</span><span>{[...result.manifests, ...result.frameworks].join(', ') || 'No manifests or frameworks detected'}</span>{result.projectFileExists && <span>Existing PROJECT.md will be retained.</span>}</div>; }
function slugKey(value: string) { return value.replace(/[^A-Za-z0-9]+/g, '').slice(0, 8).toUpperCase(); }
function slugFolder(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function typeLabel(type: ProjectType) { return TYPES.find(item => item.id === type)?.title ?? type; }
function toolModeLabel(mode: AgentToolMode) { return mode === 'project-only' ? 'project-board tools only' : mode === 'read-only' ? 'read-only tools' : 'full tools'; }
