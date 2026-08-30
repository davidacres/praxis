import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  type AgentToolMode,
  type CreateProjectInput,
  type FolderInspection,
  type ProjectRecord,
  type ProjectStartingPoint,
  type ProjectType
} from '@praxis/core';
// Deep import on purpose: `@praxis/core`'s barrel pulls in node-only services
// (chokidar, node:fs) that cannot be bundled for the browser — importing
// PROJECT_BRIEF_FIELDS from the package root fails the vite build.
import { PROJECT_BRIEF_FIELDS, defaultProjectTickets, defaultProjectWorkflow } from '@praxis/core/out/projects/projectTemplates';
import { Icon } from '../ui/Icon';

const TYPES: Array<{ id: ProjectType; title: string; description: string }> = [
  { id: 'software', title: 'Software Development', description: 'Build or change a software system.' },
  { id: 'product', title: 'Product Development', description: 'Define and deliver a product outcome.' },
  { id: 'research', title: 'Research', description: 'Gather evidence and produce recommendations.' },
  { id: 'experiment', title: 'Experiment / Prototype', description: 'Test a hypothesis within a timebox.' }
];

type BriefPrompt = { question: string; example: string; hint: string };
type PlanChoice = 'standard' | 'none' | 'custom';

const BRIEF_DEFAULTS: Record<ProjectType, Record<string, string>> = {
  software: {
    problem: 'Confirm the user or operational problem before committing to a solution.', outcome: 'Define an observable result that will show the software is useful.', stack: 'Prefer the existing project stack unless a change is justified.', integrations: 'Treat external systems and data boundaries as explicit dependencies.', constraints: 'Respect platform, security, time, and budget limits as they are discovered.', quality: 'Prioritise usability, reliability, and practical verification.'
  },
  product: {
    users: 'Start with the primary users closest to the problem and refine the audience with evidence.', problem: 'Validate the users’ current difficulty before choosing a solution.', outcomes: 'Define an observable improvement in user behaviour or results.', mvp: 'Deliver the smallest coherent release that can test the core value.', nonGoals: 'Defer adjacent features that are not required to test the first release.', constraints: 'Respect known time, policy, technology, and commercial limits.'
  },
  research: {
    questions: 'Frame answerable questions that support a concrete decision.', scope: 'Keep the investigation bounded by audience, topic, and time.', evidence: 'Use more than one form of evidence for important conclusions.', sources: 'Prefer primary and current sources, recording access limits explicitly.', deliverable: 'Produce a concise evidence-led recommendation with confidence noted.'
  },
  experiment: {
    hypothesis: 'State a falsifiable belief linking a change to an expected result.', method: 'Use the smallest safe test that can distinguish the expected effect.', timebox: 'Set a time or sample boundary before the experiment begins.', success: 'Choose a measurable success threshold before reviewing results.', stopping: 'Stop early when safety, validity, cost, or futility limits are reached.'
  }
};

const BRIEF_UNSURE = 'Not decided yet — confirm during the first planning pass.';

const BRIEF_GUIDANCE: Record<ProjectType, Record<string, BriefPrompt>> = {
  software: {
    problem: { question: 'What problem should this software solve?', example: 'Teams lose time copying release status between three separate tools.', hint: 'Describe the pain or limitation, not the proposed feature.' },
    outcome: { question: 'What should be different when the project succeeds?', example: 'A release owner can see readiness and publish an update in under two minutes.', hint: 'Focus on an observable result for a user or the business.' },
    stack: { question: 'Which technologies should the project use?', example: 'TypeScript, React, Electron, and SQLite.', hint: 'Include fixed choices and anything the team is free to decide.' },
    integrations: { question: 'What other systems must it work with?', example: 'GitHub, Jira Cloud, and the existing company identity provider.', hint: 'Name APIs, services, data sources, or devices at the boundary.' },
    constraints: { question: 'What limits or rules must the team work within?', example: 'Must run offline, support macOS and Windows, and store no credentials in project files.', hint: 'Consider platforms, security, deadlines, compatibility, and budget.' },
    quality: { question: 'What does good quality look like for this project?', example: 'Keyboard accessible, fast with 10,000 records, and covered by packaged Electron tests.', hint: 'State the standards that should shape implementation and verification.' }
  },
  product: {
    users: { question: 'Who are you creating this product for?', example: 'Support leads at growing SaaS companies who manage 5–20 agents.', hint: 'Name the primary user and the situation they are in.' },
    problem: { question: 'What is difficult for those users today?', example: 'They cannot see which customer conversations are at risk without checking every queue.', hint: 'Describe their current struggle in their own terms.' },
    outcomes: { question: 'What outcome should those users achieve?', example: 'A lead can identify and reassign every at-risk conversation before the daily stand-up.', hint: 'Prefer a measurable change in behaviour or result.' },
    mvp: { question: 'What is the smallest useful first release?', example: 'One shared risk queue with owner, age, sentiment, and reassignment.', hint: 'Include only what is needed to test the core value.' },
    nonGoals: { question: 'What should this project deliberately not include?', example: 'No customer-facing chat, workforce scheduling, or billing in the first release.', hint: 'Clear boundaries prevent the initial plan from quietly expanding.' },
    constraints: { question: 'Which constraints or commitments must the plan respect?', example: 'Pilot in six weeks, use the existing design system, and retain data in the EU.', hint: 'Capture time, policy, technology, and commercial limits.' }
  },
  research: {
    questions: { question: 'What do you need the research to answer?', example: 'Why do trial users abandon setup before connecting their first repository?', hint: 'Write questions that evidence can answer, not a topic area.' },
    scope: { question: 'What is inside and outside this investigation?', example: 'UK self-serve trials from the last six months; enterprise onboarding is excluded.', hint: 'Set boundaries for audience, geography, time, and product area.' },
    evidence: { question: 'What standard of evidence will be convincing?', example: 'At least 12 interviews plus behavioural data that confirms the same pattern.', hint: 'Say how findings should be corroborated and how uncertainty is handled.' },
    sources: { question: 'Which sources should the research use or avoid?', example: 'Interview recordings, funnel analytics, support tickets, and current onboarding copy.', hint: 'List trusted sources, access limitations, and prohibited sources.' },
    deliverable: { question: 'What should the research produce?', example: 'A decision memo with ranked causes, evidence, confidence, and three recommendations.', hint: 'Describe the format and the decision it needs to support.' }
  },
  experiment: {
    hypothesis: { question: 'What do you believe, and why?', example: 'Showing setup progress will increase first-project completion because users can see the remaining effort.', hint: 'Use a clear cause-and-effect statement that could be disproved.' },
    method: { question: 'How will you test the hypothesis?', example: 'Run a 50/50 prototype test with new trial users and compare completion behaviour.', hint: 'Explain the treatment, comparison, audience, and measurement.' },
    timebox: { question: 'How long should the experiment run?', example: 'Two weeks or until each variant reaches 500 eligible users.', hint: 'Use a time or sample boundary so the test cannot drift indefinitely.' },
    success: { question: 'What result would count as success?', example: 'At least a 10% relative increase in completion with no increase in setup errors.', hint: 'Choose a threshold before seeing the results.' },
    stopping: { question: 'When should the team stop early?', example: 'Stop if error rate rises above 3%, or instrumentation misses more than 5% of events.', hint: 'Include safety, validity, cost, and futility conditions.' }
  }
};

const CREATE_STEP_COPY = [
  { title: 'Choose a project type', detail: 'Pick the planning model that best matches the outcome you want to create.' },
  { title: 'Name and locate your project', detail: 'Give the project a name and choose whether it needs a folder on this computer.' },
  { title: 'Shape the brief', detail: 'Use the recommended brief for this project type, or customize only what matters now.' },
  { title: 'Set up the initial plan', detail: 'Choose how much starting structure you want. Every choice remains editable later.' },
  { title: 'Choose tool access', detail: 'Set the default permissions for future sessions without starting AI now.' },
  { title: 'Review and create', detail: 'Confirm exactly what Praxis will create.' }
] as const;

const EXISTING_STEP_COPY = [
  { title: 'Choose the existing folder', detail: 'Praxis will inspect this folder without changing it.' },
  { title: 'Describe the project', detail: 'Confirm its type and identity. Detected files remain untouched.' },
  { title: 'Shape the brief', detail: 'Use the recommended brief for this project type, or customize anything the folder cannot explain.' },
  { title: 'Set up the initial plan', detail: 'Choose how much starting structure you want. Every choice remains editable later.' },
  { title: 'Choose tool access', detail: 'Set the default permissions for future sessions without starting AI now.' },
  { title: 'Review and add', detail: 'Confirm what Praxis will record alongside the existing folder.' }
] as const;

export function NewProjectWizard({ workspaceId, workspaceName, presentation = 'dialog', mode = 'create', onCancel, onCreated }: { workspaceId: string; workspaceName?: string; presentation?: 'dialog' | 'onboarding'; mode?: 'create' | 'existing'; onCancel: () => void; onCreated: (project: ProjectRecord) => void }) {
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
  const [existingProject, setExistingProject] = useState<ProjectRecord>();
  const [existingDecision, setExistingDecision] = useState<'use' | 'create'>();
  const [brief, setBrief] = useState<Record<string, string>>(() => ({ ...BRIEF_DEFAULTS.software }));
  const [includedBrief, setIncludedBrief] = useState<Record<string, boolean>>({});
  const [selectedBriefKey, setSelectedBriefKey] = useState<string>();
  const [briefDraft, setBriefDraft] = useState('');
  const [briefDraftSkipped, setBriefDraftSkipped] = useState(false);
  const [briefEditorOpen, setBriefEditorOpen] = useState(false);
  const [stages, setStages] = useState(() => defaultProjectWorkflow('software'));
  const [tickets, setTickets] = useState(() => mode === 'existing' ? [] : defaultProjectTickets('software'));
  const [workflowChoice, setWorkflowChoice] = useState<PlanChoice>('standard');
  const [ticketChoice, setTicketChoice] = useState<PlanChoice>('standard');
  const [toolMode, setToolMode] = useState<AgentToolMode>('full');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const workflowEditorRef = useRef<HTMLDivElement>(null);
  const ticketEditorRef = useRef<HTMLDivElement>(null);
  const briefSectionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stepCopy = mode === 'existing' ? EXISTING_STEP_COPY : CREATE_STEP_COPY;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || creating) return;
      if (briefEditorOpen) {
        event.preventDefault();
        setBriefEditorOpen(false);
        window.requestAnimationFrame(() => selectedBriefKey && briefSectionRefs.current[selectedBriefKey]?.focus());
        return;
      }
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [briefEditorOpen, creating, onCancel, selectedBriefKey]);

  useEffect(() => {
    if (startingPoint === 'app-storage' && type !== 'product' && type !== 'research') setStartingPoint('new-folder');
    setStages(defaultProjectWorkflow(type)); setTickets(mode === 'existing' ? [] : defaultProjectTickets(type)); setBrief({ ...BRIEF_DEFAULTS[type] }); setIncludedBrief({});
    setSelectedBriefKey(undefined); setBriefDraft(''); setBriefDraftSkipped(false); setBriefEditorOpen(false); setWorkflowChoice('standard'); setTicketChoice('standard');
    setToolMode(type === 'software' || type === 'experiment' ? 'full' : 'read-only');
  }, [type]);
  useEffect(() => {
    if (!keyEdited) setKey(slugKey(name));
    if (!folderNameEdited) setFolderName(slugFolder(name));
  }, [name, keyEdited, folderNameEdited]);
  useEffect(() => { if (startingPoint === 'app-storage') setToolMode('project-only'); else setToolMode(type === 'software' || type === 'experiment' ? 'full' : 'read-only'); }, [startingPoint, type]);
  useEffect(() => {
    if (step !== 3) return;
    const editor = workflowChoice === 'custom' ? workflowEditorRef.current : ticketChoice === 'custom' ? ticketEditorRef.current : undefined;
    if (!editor) return;
    const frame = window.requestAnimationFrame(() => editor.scrollIntoView({ block: 'nearest' }));
    return () => window.cancelAnimationFrame(frame);
  }, [step, workflowChoice, ticketChoice]);

  const previewPath = startingPoint === 'new-folder' && folderPath ? `${folderPath.replace(/[\\/]$/, '')}/${folderName}` : folderPath;
  const briefFields = PROJECT_BRIEF_FIELDS[type];
  const selectedBriefField = briefFields.find(field => field.key === selectedBriefKey);
  const selectedBriefPrompt = selectedBriefField ? BRIEF_GUIDANCE[type][selectedBriefField.key] : undefined;
  const isBriefEditorOpen = Boolean(briefEditorOpen && selectedBriefField);
  const selectedBrief = Object.fromEntries(briefFields.filter(field => includedBrief[field.key]).map(field => [field.key, brief[field.key] ?? BRIEF_DEFAULTS[type][field.key]]));
  const input: CreateProjectInput = useMemo(() => ({
    name, key, type, purpose, brief: selectedBrief, startingPoint, folderPath: folderPath || undefined,
    folderName: folderName || undefined, workflowStages: stages, starterTickets: tickets, defaultAiToolMode: toolMode
  }), [name, key, type, purpose, selectedBrief, startingPoint, folderPath, folderName, stages, tickets, toolMode]);

  const chooseFolder = async () => {
    const chosen = await window.praxis.dialog.pickFolder(startingPoint === 'new-folder' ? 'Choose where to save the project' : 'Choose existing project folder');
    if (!chosen) return;
    setFolderPath(chosen); setError(undefined); setExistingProject(undefined); setExistingDecision(undefined);
    if (startingPoint === 'existing-folder') {
      const result = await window.praxis.projects.inspectFolder(chosen);
      setInspection(result);
      const normalized = result.path.replace(/[\\/]$/, '').toLowerCase();
      const projects = await window.praxis.projects.list();
      setExistingProject(projects.find(project => project.workspaceFolder?.replace(/[\\/]$/, '').toLowerCase() === normalized));
    }
    else setInspection(undefined);
  };
  const applyDetectedIdentity = (result: FolderInspection) => {
    const folderNameFromPath = result.path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    if (!name.trim() && folderNameFromPath) setName(folderNameFromPath);
    if (!keyEdited && folderNameFromPath) setKey(slugKey(folderNameFromPath));
  };
  const continueStep = async () => {
    setError(undefined);
    try {
      if (step === 0 && mode === 'existing') {
        if (!folderPath) throw new Error('Choose the existing project folder.');
        const result = inspection ?? await window.praxis.projects.inspectFolder(folderPath);
        if (!result.exists || !result.isDirectory) throw new Error('Choose an existing folder.');
        setInspection(result);
        if (existingProject && !existingDecision) throw new Error('This folder is already a project. Choose whether to use it or create a new project.');
        if (existingProject && existingDecision === 'use') {
          setCreating(true);
          onCreated(await window.praxis.projects.useExisting(existingProject.id, workspaceId));
          return;
        }
        applyDetectedIdentity(result);
        // The folder supplies the project identity and location; avoid making
        // users re-enter those details before showing the brief and plan.
        setStep(2);
        return;
      }
      if (step === 1) {
        if (!name.trim()) throw new Error('Enter a project name.');
        if (!/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(key)) throw new Error('Use a 1-15 character key starting with a letter.');
        if (startingPoint !== 'app-storage' && !folderPath) throw new Error(mode === 'existing' ? 'Choose the existing folder.' : 'Choose where to save the project.');
        if (startingPoint === 'new-folder') {
          if (!folderName.trim()) throw new Error('Enter a project folder name.');
          const result = await window.praxis.projects.inspectFolder(previewPath);
          if (result.exists) throw new Error('That folder already exists. Select Existing Folder instead.');
        }
      }
      if (step === 3 && (stages.length < 2 || ((startingPoint !== 'existing-folder') && (tickets.length < 1 || tickets.some(ticket => !ticket.summary.trim()))))) throw new Error('Keep at least two stages and one starter ticket with a title.');
      setStep(value => Math.min(5, value + 1));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const create = async () => {
    setCreating(true); setError(undefined);
    try { onCreated(await window.praxis.projects.create(input, workspaceId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCreating(false); }
  };
  const chooseWorkflow = (choice: PlanChoice) => {
    setWorkflowChoice(choice);
    const nextStages = choice === 'none'
      ? [{ id: 'stage-1', name: 'To do' }, { id: 'stage-2', name: 'Done' }]
      : defaultProjectWorkflow(type);
    setStages(nextStages);
    setTickets(current => current.map(ticket => ({ ...ticket, status: nextStages[0].name })));
  };
  const chooseTickets = (choice: PlanChoice) => {
    setTicketChoice(choice);
    setTickets(choice === 'none' ? [] : defaultProjectTickets(type).map(ticket => ({ ...ticket, status: stages[0]?.name ?? ticket.status })));
  };
  const closeBriefEditor = () => {
    const keyToFocus = selectedBriefKey;
    setBriefEditorOpen(false);
    window.setTimeout(() => keyToFocus && briefSectionRefs.current[keyToFocus]?.focus(), 380);
  };
  const openBriefEditor = (fieldKey: string) => {
    setSelectedBriefKey(fieldKey);
    setBriefDraft(brief[fieldKey] ?? '');
    setBriefDraftSkipped(!includedBrief[fieldKey]);
    setBriefEditorOpen(true);
  };
  const commitBriefDraft = () => {
    if (!selectedBriefKey) return;
    setIncludedBrief(current => ({ ...current, [selectedBriefKey]: briefDraftSkipped ? false : Boolean(current[selectedBriefKey]) }));
    setBrief(current => ({ ...current, [selectedBriefKey]: briefDraft || BRIEF_DEFAULTS[type][selectedBriefKey] }));
    closeBriefEditor();
  };
  const toggleBriefIncluded = (fieldKey: string) => setIncludedBrief(current => ({ ...current, [fieldKey]: !current[fieldKey] }));
  const goBack = () => {
    setError(undefined);
    setStep(value => value - 1);
  };

  return <div className={`project-wizard project-wizard-${presentation}`} data-testid="new-project-wizard">
    <header className="project-wizard-header">
      <div className="project-dialog-heading"><span className="project-dialog-brand">PRAXIS<i /></span><div><h1 id="new-project-dialog-title">{mode === 'existing' ? 'Create from existing folder' : 'Create new project'}</h1><p>{workspaceName ? `${workspaceName} workspace` : mode === 'existing' ? 'Scan plans and connect this folder to a project without changing its source files.' : 'A durable brief, local board, and focused starter work.'}</p></div></div>
      <div className="project-dialog-header-actions"><div className="step-count">Step {step + 1} of 6</div><button className="project-dialog-close" aria-label="Close new project dialog" onClick={onCancel}>×</button></div>
    </header>
    <div className="wizard-progress" aria-label={`Step ${step + 1} of 6`}>{Array.from({ length: 6 }, (_, index) => <span key={index} className={index <= step ? 'active' : ''} />)}</div>
    <div className="project-wizard-body">
      <div className="wizard-step-intro"><div><h2>{stepCopy[step].title}</h2><p>{stepCopy[step].detail}</p></div></div>
      {step === 0 && (mode === 'create' ? <ProjectTypeCards type={type} onChange={setType} /> : <div className="existing-folder-step"><div className="existing-folder-picker"><div className="existing-folder-visual">↳</div><div><strong>Select the project folder</strong><p>We look for Git, README files, manifests, languages, and frameworks.</p></div><button className="btn btn-primary" onClick={chooseFolder}>Choose folder…</button></div>{inspection ? <Inspection result={inspection} existingProject={existingProject} decision={existingDecision} onUseExisting={async () => { if (!existingProject) return; setCreating(true); try { onCreated(await window.praxis.projects.useExisting(existingProject.id, workspaceId)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCreating(false); } }} onCreateNew={() => { setExistingDecision('create'); setError(undefined); }} /> : <div className="inspection-placeholder"><span>Workspace detection will appear here</span><small>No files are created or modified during inspection.</small></div>}</div>)}
      {step === 1 && <div className="project-form-grid">
        {mode === 'existing' && <div className="span-2"><h3 className="wizard-section-title first">Project type</h3><ProjectTypeCards type={type} onChange={setType} compact /></div>}
        <label className="field span-2"><span>Project name</span><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
        {mode === 'create' && (type === 'product' || type === 'research') && <section className="project-location-section span-2" aria-labelledby="project-location-title"><div className="project-location-heading"><h3 id="project-location-title">Where should this project live?</h3><p>A folder is useful when the project has documents or source files. Praxis-only projects keep the plan and board in the app.</p></div><div className="project-location-options"><Choice checked={startingPoint === 'new-folder'} title="Create a project folder" detail="Keep project files on this computer and connect sessions to them." onClick={() => setStartingPoint('new-folder')} /><Choice checked={startingPoint === 'app-storage'} title="Keep in Praxis only" detail="Create the plan and board without local files. You can connect a folder later." onClick={() => setStartingPoint('app-storage')} /></div></section>}
        {mode === 'create' && (type === 'software' || type === 'experiment') && <div className="project-location-note span-2"><span className="project-location-note-icon">↳</span><div><strong>Praxis will create a project folder</strong><p>This project type works with files and sessions, so it needs a location on this computer.</p></div></div>}
        {mode === 'existing' && <label className="field"><span>Existing folder</span><div className="folder-picker"><input className="input" value={folderPath} readOnly /><button className="btn" onClick={chooseFolder}>Change…</button></div></label>}
        {mode === 'create' && startingPoint !== 'app-storage' && <label className="field span-2"><span>Save project in</span><div className="folder-picker"><input className="input" value={folderPath} placeholder="Choose a location…" readOnly /><button className="btn" onClick={chooseFolder}>Choose…</button></div><small>{folderPath ? <>Praxis will create <strong>{folderName || 'a project folder'}</strong> here.</> : 'Choose the folder that should contain your new project.'}</small></label>}
        <details className="project-advanced-details span-2"><summary>Project identifiers</summary><p>Praxis generates these automatically. Change them only if your team uses a specific convention.</p><div className="project-advanced-grid"><label className="field"><span>Ticket prefix</span><input className="input" value={key} onChange={e => { setKeyEdited(true); setKey(e.target.value.toUpperCase()); }} /><small>Used for ticket IDs such as {key || 'PROJ'}-1.</small></label>{startingPoint === 'new-folder' && <label className="field"><span>Folder name</span><input className="input" value={folderName} onChange={e => { setFolderNameEdited(true); setFolderName(e.target.value); }} /><small>{previewPath || 'Generated automatically.'}</small></label>}</div></details>
        {mode === 'existing' && <label className="field span-2"><span>Purpose <em>Optional</em></span><textarea className="input textarea" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Why does this project exist?" /></label>}
        {mode === 'existing' && inspection && <Inspection result={inspection} existingProject={existingProject} decision={existingDecision} onUseExisting={async () => { if (!existingProject) return; setCreating(true); try { onCreated(await window.praxis.projects.useExisting(existingProject.id, workspaceId)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setCreating(false); } }} onCreateNew={() => { setExistingDecision('create'); setError(undefined); }} />}
      </div>}
      {step === 2 && <BriefStep
        type={type}
        fields={briefFields}
        brief={brief}
        included={includedBrief}
        draft={briefDraft}
        draftSkipped={briefDraftSkipped}
        selectedKey={selectedBriefKey}
        editorOpen={isBriefEditorOpen}
        selectedField={selectedBriefField}
        selectedPrompt={selectedBriefPrompt}
        sectionRefs={briefSectionRefs}
        onToggleIncluded={toggleBriefIncluded}
        onCustomize={openBriefEditor}
        onDraftChange={(value) => { setBriefDraft(value); setBriefDraftSkipped(false); }}
        onDraftSkip={() => { setBriefDraft(''); setBriefDraftSkipped(true); }}
        onCancel={closeBriefEditor}
        onDone={commitBriefDraft}
      />}
      {step === 3 && <InitialPlanStep type={type} stages={stages} tickets={tickets} workflowChoice={workflowChoice} ticketChoice={ticketChoice} allowEmptyTickets={startingPoint === 'existing-folder'} workflowEditorRef={workflowEditorRef} ticketEditorRef={ticketEditorRef} onChooseWorkflow={chooseWorkflow} onChooseTickets={chooseTickets} onStagesChange={setStages} onTicketsChange={setTickets} />}
      {step === 4 && <ToolAccessStep mode={toolMode} folderless={startingPoint === 'app-storage'} onChange={setToolMode} />}
      {step === 5 && <ReviewStep type={type} name={name} projectKey={key} purpose={purpose} workspaceName={workspaceName} folderless={startingPoint === 'app-storage'} previewPath={previewPath} briefCount={briefFields.filter(field => includedBrief[field.key]).length} stages={stages} ticketCount={tickets.length} toolMode={toolMode} />}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
    <footer className="project-wizard-footer"><button className="btn" onClick={onCancel}>Cancel</button><div className="footer-actions">{step > 0 && <button className="btn" onClick={goBack}>Back</button>}<button className="btn btn-primary" disabled={creating} onClick={step === 5 ? create : continueStep}>{step === 5 ? creating ? (mode === 'existing' ? 'Adding…' : 'Creating…') : mode === 'existing' ? 'Add project' : 'Create project' : 'Continue'}</button></div></footer>
  </div>;
}

function ProjectTypeCards({ type, onChange, compact = false }: { type: ProjectType; onChange: (type: ProjectType) => void; compact?: boolean }) { return <div className={`project-card-grid${compact ? ' compact' : ''}`}>{TYPES.map(option => <button key={option.id} type="button" className={`project-choice project-choice-${option.id}${type === option.id ? ' selected' : ''}`} aria-pressed={type === option.id} onClick={() => onChange(option.id)}><ProjectTypePreview type={option.id} /><span className="project-choice-copy"><span className="project-choice-kicker">{previewKicker(option.id)}</span><strong>{option.title}</strong><span>{option.description}</span><small>{previewDetail(option.id)}</small></span><span className="project-choice-check">✓</span></button>)}</div>; }

function BriefStep({ type, fields, brief, included, draft, draftSkipped, selectedKey, editorOpen, selectedField, selectedPrompt, sectionRefs, onToggleIncluded, onCustomize, onDraftChange, onDraftSkip, onCancel, onDone }: {
  type: ProjectType;
  fields: Array<{ key: string; label: string }>;
  brief: Record<string, string>;
  included: Record<string, boolean>;
  draft: string;
  draftSkipped: boolean;
  selectedKey?: string;
  editorOpen: boolean;
  selectedField?: { key: string; label: string };
  selectedPrompt?: BriefPrompt;
  sectionRefs: MutableRefObject<Record<string, HTMLButtonElement | null>>;
  onToggleIncluded: (fieldKey: string) => void;
  onCustomize: (fieldKey: string) => void;
  onDraftChange: (value: string) => void;
  onDraftSkip: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const pendingIncluded = selectedField ? (draftSkipped ? false : Boolean(included[selectedField.key])) : false;
  useEffect(() => {
    if (!editorOpen) return;
    const frame = window.requestAnimationFrame(() => answerRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [editorOpen, selectedKey]);
  return <section className={`brief-section-layout${editorOpen ? ' editor-open' : ''}`}>
    <div className="brief-section-menu"><div className="brief-section-options">{fields.map(field => {
        const isIncluded = Boolean(included[field.key]);
        const isCustomized = brief[field.key] !== BRIEF_DEFAULTS[type][field.key];
        return <article key={field.key} className={`brief-section-option${isIncluded ? ' included' : ''}${editorOpen && field.key === selectedKey ? ' current' : ''}`}>
          <button ref={element => { sectionRefs.current[field.key] = element; }} type="button" className="brief-section-select" aria-label={`${isIncluded ? 'Deselect' : 'Select'} ${field.label}`} aria-pressed={isIncluded} onClick={() => onToggleIncluded(field.key)}><span><strong>{field.label}</strong><small>{brief[field.key] || BRIEF_DEFAULTS[type][field.key]}</small><em>{isIncluded ? isCustomized ? 'Selected · Customized' : 'Selected · Recommended' : 'Skipped'}</em></span><span className="brief-section-selected" aria-hidden="true">✓</span></button>
          <button type="button" className="brief-section-customize" aria-label={`Customize ${field.label}`} title={`Customize ${field.label}`} onClick={() => onCustomize(field.key)}><Icon name="pencil" size={13} /><span>Customize</span></button>
        </article>;
      })}</div></div>
    <div className="brief-editor-reveal" aria-hidden={!editorOpen}>
      <div className="brief-editor-panel" key={selectedKey}>{selectedField && selectedPrompt && <>
        <div className={`brief-editor-selection-state${pendingIncluded ? ' included' : ''}`}><span>{pendingIncluded ? '✓ Selected' : 'Skipped'}</span><small>{pendingIncluded ? 'This section will be included in the project brief.' : 'Customize the text here, then select its card to include it.'}</small></div>
        <span className="brief-editor-kicker">{typeLabel(type)} · {selectedField.label}</span><h3>{selectedPrompt.question}</h3><p>{selectedPrompt.hint}</p>
        <div className="brief-starters" aria-label={`${selectedField.label} starting answers`}><span>Start with</span><button type="button" tabIndex={editorOpen ? undefined : -1} onClick={() => onDraftChange(BRIEF_DEFAULTS[type][selectedField.key])}>Recommended</button><button type="button" tabIndex={editorOpen ? undefined : -1} onClick={() => onDraftChange(selectedPrompt.example)}>Use example</button><button type="button" tabIndex={editorOpen ? undefined : -1} onClick={() => onDraftChange(BRIEF_UNSURE)}>I’m not sure</button><button type="button" tabIndex={editorOpen ? undefined : -1} onClick={onDraftSkip}>Skip this section</button></div>
        <label><span>Your answer <em>Editable</em></span><textarea ref={answerRef} className="input" aria-label={selectedField.label} tabIndex={editorOpen ? undefined : -1} value={draft} onChange={event => onDraftChange(event.target.value)} placeholder={selectedPrompt.example} /></label>
        {draftSkipped && <span className="brief-draft-skipped">This section is skipped. Choose an answer above or type your own to include it.</span>}
        <div className="brief-editor-foot"><span>Changes apply when you select Done</span><div><button type="button" className="btn" tabIndex={editorOpen ? undefined : -1} onClick={onCancel}>Cancel</button><button type="button" className="btn btn-primary" tabIndex={editorOpen ? undefined : -1} onClick={onDone}>Done</button></div></div>
      </>}</div>
    </div>
  </section>;
}

function InitialPlanStep({ type, stages, tickets, workflowChoice, ticketChoice, allowEmptyTickets, workflowEditorRef, ticketEditorRef, onChooseWorkflow, onChooseTickets, onStagesChange, onTicketsChange }: {
  type: ProjectType;
  stages: Array<{ id: string; name: string }>;
  tickets: Array<{ summary: string; description: string; issueType: string; status: string }>;
  workflowChoice: PlanChoice;
  ticketChoice: PlanChoice;
  allowEmptyTickets: boolean;
  workflowEditorRef: MutableRefObject<HTMLDivElement | null>;
  ticketEditorRef: MutableRefObject<HTMLDivElement | null>;
  onChooseWorkflow: (choice: PlanChoice) => void;
  onChooseTickets: (choice: PlanChoice) => void;
  onStagesChange: Dispatch<SetStateAction<Array<{ id: string; name: string }>>>;
  onTicketsChange: Dispatch<SetStateAction<Array<{ summary: string; description: string; issueType: string; status: string }>>>;
}) {
  return <div className="initial-plan-step">
    <section className="plan-section"><div className="plan-section-heading"><div><h3>Workflow</h3><p>Choose how work moves across the first board.</p></div></div><div className="plan-choice-grid"><PlanOption selected={workflowChoice === 'standard'} eyebrow="Recommended" title={`Standard ${typeLabel(type).toLowerCase()} workflow`} detail={defaultProjectWorkflow(type).map(stage => stage.name).join(' → ')} onClick={() => onChooseWorkflow('standard')} /><PlanOption selected={workflowChoice === 'none'} eyebrow="Simple" title="To do and Done" detail="A minimal board with room to grow later." onClick={() => onChooseWorkflow('none')} /><PlanOption selected={workflowChoice === 'custom'} eyebrow="Custom" title="Choose the stages" detail="Edit the suggested workflow before creating the project." onClick={() => onChooseWorkflow('custom')} /></div>{workflowChoice === 'custom' && <div className="plan-custom-editor" ref={workflowEditorRef}><div className="section-heading"><h2>Workflow stages</h2><button className="btn" onClick={() => onStagesChange(current => [...current, { id: `stage-${Date.now()}`, name: 'New stage' }])}>Add stage</button></div>{stages.map((stage, index) => <div className="editable-row" key={stage.id}><span>{index + 1}</span><input className="input" aria-label={`Workflow stage ${index + 1}`} value={stage.name} onChange={event => { const value = event.target.value; onStagesChange(current => current.map(item => item.id === stage.id ? { ...item, name: value } : item)); onTicketsChange(current => current.map(ticket => ticket.status === stage.name ? { ...ticket, status: value } : ticket)); }} /><button className="icon-btn" aria-label="Remove stage" onClick={() => onStagesChange(current => current.filter(item => item.id !== stage.id))}>×</button></div>)}</div>}</section>
    <section className="plan-section"><div className="plan-section-heading"><div><h3>Starter tickets</h3><p>{allowEmptyTickets ? 'Existing project detected. Keep its current plan and skip creating starter tickets here, or add prompts if needed.' : 'Choose suggested prompts or customize them. At least one titled ticket is required to start the board.'}</p></div></div><div className="plan-choice-grid"><PlanOption selected={ticketChoice === 'standard'} eyebrow="Recommended" title="Add suggested tickets" detail={`${defaultProjectTickets(type).length} editable prompts for this project type.`} onClick={() => onChooseTickets('standard')} />{allowEmptyTickets && <PlanOption selected={ticketChoice === 'none'} eyebrow="Existing plan" title="No starter tickets" detail="Use the tickets already in this project folder." onClick={() => onChooseTickets('none')} />}<PlanOption selected={ticketChoice === 'custom'} eyebrow="Custom" title="Edit starter tickets" detail="Review, rename, add, or remove the suggestions." onClick={() => onChooseTickets('custom')} /></div>{ticketChoice === 'custom' && <div className="plan-custom-editor" ref={ticketEditorRef}><div className="section-heading"><h2>Starter tickets</h2><button className="btn" onClick={() => onTicketsChange(current => [...current, { summary: '', description: '', issueType: 'Task', status: stages[0]?.name ?? '' }])}>Add ticket</button></div>{tickets.map((ticket, index) => <div className="ticket-edit" key={index}><input className="input" aria-label={`Starter ticket ${index + 1}`} value={ticket.summary} onChange={event => onTicketsChange(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, summary: event.target.value } : item))} /><select className="input" aria-label={`Starter ticket ${index + 1} stage`} value={ticket.status} onChange={event => onTicketsChange(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, status: event.target.value } : item))}>{stages.map(stage => <option key={stage.id}>{stage.name}</option>)}</select><button className="icon-btn" aria-label="Remove ticket" onClick={() => onTicketsChange(current => current.filter((_, itemIndex) => index !== itemIndex))}>×</button></div>)}</div>}</section>
  </div>;
}

function ToolAccessStep({ mode, folderless, onChange }: { mode: AgentToolMode; folderless: boolean; onChange: (mode: AgentToolMode) => void }) {
  return <div className="tool-access-step">
    <div className="access-choice-grid">{folderless ? <button type="button" className="access-choice selected locked" aria-pressed="true"><span>Recommended</span><span className="access-choice-check" aria-hidden="true">✓</span><strong>Project-board tools only</strong><small>Use the brief, boards, and tickets. File and terminal tools become available after a folder is connected.</small></button> : <><button type="button" className={`access-choice${mode === 'full' ? ' selected' : ''}`} aria-pressed={mode === 'full'} onClick={() => onChange('full')}><span>Build</span><span className="access-choice-check" aria-hidden="true">✓</span><strong>Full project tools</strong><small>Read and edit files, run commands, and work with the project board.</small></button><button type="button" className={`access-choice${mode === 'read-only' ? ' selected' : ''}`} aria-pressed={mode === 'read-only'} onClick={() => onChange('read-only')}><span>Inspect</span><span className="access-choice-check" aria-hidden="true">✓</span><strong>Read-only project tools</strong><small>Read files and project context without changing either.</small></button></>}</div>
    <div className="tool-access-note"><span>✓</span><div><strong>Nothing starts now</strong><p>This only sets the starting permission level. Provider, model, and permissions can still be reviewed when a session begins.</p></div></div>
  </div>;
}

function ReviewStep({ type, name, projectKey, purpose, workspaceName, folderless, previewPath, briefCount, stages, ticketCount, toolMode }: { type: ProjectType; name: string; projectKey: string; purpose: string; workspaceName?: string; folderless: boolean; previewPath: string; briefCount: number; stages: Array<{ id: string; name: string }>; ticketCount: number; toolMode: AgentToolMode }) {
  return <div className="review-summary">
    <header className="review-summary-heading"><span>Ready to create</span><div><h2>{name}</h2><code>{projectKey}</code></div>{purpose && <p>{purpose}</p>}<p>Praxis will add this project to <strong>{workspaceName ?? 'the current workspace'}</strong> and open its default board.</p></header>
    <dl className="review-summary-list">
      <div><dt>Project type</dt><dd><strong>{typeLabel(type)}</strong><small>{briefCount} brief sections prepared</small></dd></div>
      <div><dt>Project files</dt><dd><strong>{folderless ? 'Praxis only — no local folder' : previewPath}</strong><small>{folderless ? 'A folder can be connected later.' : 'Praxis creates PROJECT.md without replacing an existing file.'}</small></dd></div>
      <div><dt>Default board</dt><dd><strong>{ticketCount ? `${ticketCount} starter tickets` : 'Empty board'}</strong><small>{stages.map(stage => stage.name).join(' → ')}</small></dd></div>
      <div><dt>Session access</dt><dd><strong>{toolModeLabel(toolMode)}</strong><small>No AI session starts during project creation.</small></dd></div>
    </dl>
    <p className="review-summary-note"><span>✓</span>Everything can be changed after the project is created.</p>
  </div>;
}

function ProjectTypePreview({ type }: { type: ProjectType }) {
  if (type === 'software') return <span className="project-type-preview software" aria-hidden="true"><span className="project-preview-bar"><i /><i /><i /><b>src/app.ts</b></span><span className="project-preview-code"><i /><i /><i className="short" /><i /><i className="medium" /></span><span className="project-preview-terminal"><b>›</b><i /><span>passed</span></span></span>;
  if (type === 'product') return <span className="project-type-preview product" aria-hidden="true"><span className="project-preview-bar"><b>Delivery board</b><em>Board</em></span><span className="project-preview-board"><span><b>BACKLOG</b><i /><i /></span><span className="active"><b>DOING</b><i /></span><span><b>DONE</b><i /><i /></span></span></span>;
  if (type === 'research') return <span className="project-type-preview research" aria-hidden="true"><span className="project-preview-bar"><b>Evidence review</b><em>6 sources</em></span><span className="project-preview-research"><span><i /><i /><i /></span><article><b>Key finding</b><i /><i className="short" /><small>SUPPORTED</small></article></span></span>;
  return <span className="project-type-preview experiment" aria-hidden="true"><span className="project-preview-bar"><b>Hypothesis 01</b><em>Running</em></span><span className="project-preview-metrics"><span><small>SUCCESS</small><strong>68%</strong></span><span className="project-preview-chart"><i /><i /><i /><i /><i /></span></span><span className="project-preview-meter"><i /></span></span>;
}

function PlanOption({ selected, eyebrow, title, detail, onClick }: { selected: boolean; eyebrow: string; title: string; detail: string; onClick: () => void }) {
  return <button type="button" className={`plan-option${selected ? ' selected' : ''}`} aria-label={`${eyebrow}: ${title}`} aria-pressed={selected} onClick={onClick}><span className="plan-option-eyebrow">{eyebrow}</span><span className="plan-option-check" aria-hidden="true">✓</span><strong>{title}</strong><small>{detail}</small></button>;
}

function previewKicker(type: ProjectType) { return type === 'software' ? 'BUILD' : type === 'product' ? 'DELIVER' : type === 'research' ? 'UNDERSTAND' : 'VALIDATE'; }
function previewDetail(type: ProjectType) { return type === 'software' ? 'Repository · implementation · verification' : type === 'product' ? 'Users · outcomes · roadmap' : type === 'research' ? 'Questions · evidence · synthesis' : 'Hypothesis · method · decision'; }

function Choice({ checked, title, detail, onClick }: { checked: boolean; title: string; detail: string; onClick: () => void }) { return <button className={`start-choice${checked ? ' selected' : ''}`} onClick={onClick}><span className="radio-dot" /><span><strong>{title}</strong><small>{detail}</small></span></button>; }
function Inspection({ result, existingProject, decision, onUseExisting, onCreateNew }: { result: FolderInspection; existingProject?: ProjectRecord; decision?: 'use' | 'create'; onUseExisting?: () => void; onCreateNew?: () => void }) { return <div className="inspection-card span-2"><strong>Workspace detected</strong><span>{result.hasGit ? 'Git repository' : 'No Git repository'} · {result.readme ?? 'No README'}</span><span>{result.languages.join(', ') || 'No languages detected'}</span><span>{[...result.manifests, ...result.frameworks].join(', ') || 'No manifests or frameworks detected'}</span>{result.planFiles?.length ? <span className="inspection-plans"><Icon name="markdown" size={13} />{result.planFiles.length} planning file{result.planFiles.length === 1 ? '' : 's'} identified</span> : <span className="inspection-plans muted"><Icon name="info" size={13} />No planning files identified yet</span>}{result.projectFileExists && <span>Existing PROJECT.md will be retained.</span>}{existingProject && <div className="existing-project-match"><div><strong>This folder is already a project</strong><small>{existingProject.name} · {existingProject.key}</small></div><div className="footer-actions"><button type="button" className={`btn${decision === 'use' ? ' btn-primary' : ''}`} onClick={onUseExisting}>Use existing project</button><button type="button" className={`btn${decision === 'create' ? ' btn-primary' : ''}`} onClick={onCreateNew}>Create a new project</button></div></div>}</div>; }
function slugKey(value: string) { return value.replace(/[^A-Za-z0-9]+/g, '').slice(0, 8).toUpperCase(); }
function slugFolder(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function typeLabel(type: ProjectType) { return TYPES.find(item => item.id === type)?.title ?? type; }
function toolModeLabel(mode: AgentToolMode) { return mode === 'project-only' ? 'project-board tools only' : mode === 'read-only' ? 'read-only tools' : 'full tools'; }
