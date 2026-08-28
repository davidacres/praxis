import * as vscode from 'vscode';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface WizardState {
  currentStep: number;
  project: {
    name: string;
    description: string;
    category: string;
    priority: string;
    timeline: string;
  };
  objectives: Array<{ title: string; description: string }>;
  successCriteria: Array<{ metric: string; target: string; method: string }>;
  technicalRequirements: string[];
  businessRequirements: string[];
  constraints: string[];
  roles: Array<{
    title: string;
    description: string;
    skills: string[];
    seniority: string;
    count: number;
  }>;
  teamMembers: Array<{
    name: string;
    email: string;
    role: string;
    availability: number;
  }>;
  aiReviews: {
    requirements?: AiReviewResult;
    team?: AiReviewResult;
    final?: AiReviewResult;
  };
}

interface AiReviewResult {
  score: number;
  gaps: string[];
  suggestions: string[];
  questions: string[];
  status: 'ready' | 'needs-attention' | 'critical';
  checklist?: Array<{ label: string; status: 'pass' | 'fail' | 'warning' }>;
  riskLevel?: 'low' | 'medium' | 'high';
}

function createInitialState(): WizardState {
  return {
    currentStep: 0,
    project: { name: '', description: '', category: '', priority: 'Medium', timeline: '' },
    objectives: [{ title: '', description: '' }],
    successCriteria: [{ metric: '', target: '', method: '' }],
    technicalRequirements: [''],
    businessRequirements: [''],
    constraints: [''],
    roles: [],
    teamMembers: [],
    aiReviews: {}
  };
}

/* ------------------------------------------------------------------ */
/*  Mock AI                                                           */
/* ------------------------------------------------------------------ */

function generateMockAiReview(reviewType: string, state: WizardState): AiReviewResult {
  const hasName = state.project.name.trim().length > 0;
  const hasDesc = state.project.description.trim().length > 0;
  const hasCat = state.project.category.length > 0;
  const hasTimeline = state.project.timeline.length > 0;
  const objCount = state.objectives.filter(o => o.title.trim()).length;
  const critCount = state.successCriteria.filter(c => c.metric.trim()).length;
  const techCount = state.technicalRequirements.filter(r => r.trim()).length;
  const bizCount = state.businessRequirements.filter(r => r.trim()).length;
  const roleCount = state.roles.length;
  const memberCount = state.teamMembers.length;

  if (reviewType === 'requirements') {
    const filled = [hasName, hasDesc, hasCat, hasTimeline, objCount > 0, critCount > 0, techCount > 0, bizCount > 0];
    const score = Math.round((filled.filter(Boolean).length / filled.length) * 100);
    const gaps: string[] = [];
    const suggestions: string[] = [];
    const questions: string[] = [];
    if (!hasName) { gaps.push('Project name is missing'); }
    if (!hasDesc) { gaps.push('Project description is empty'); }
    if (!hasCat) { gaps.push('No category selected'); }
    if (!hasTimeline) { gaps.push('Timeline not defined'); }
    if (objCount === 0) { gaps.push('No objectives defined'); suggestions.push('Add at least 2-3 clear objectives'); }
    if (critCount === 0) { gaps.push('No success criteria'); suggestions.push('Define measurable success criteria'); }
    if (techCount === 0) { suggestions.push('Consider adding technical requirements'); }
    if (bizCount === 0) { suggestions.push('Consider adding business requirements'); }
    if (hasDesc && state.project.description.length < 50) { suggestions.push('Expand the project description for more clarity'); }
    questions.push('Have stakeholders reviewed these requirements?');
    questions.push('Are there regulatory or compliance constraints?');
    return { score, gaps, suggestions, questions, status: score >= 70 ? 'ready' : score >= 40 ? 'needs-attention' : 'critical' };
  }

  if (reviewType === 'team') {
    const score = roleCount === 0 ? 15 : memberCount >= roleCount ? 85 : 55;
    const gaps: string[] = [];
    const suggestions: string[] = [];
    if (roleCount === 0) { gaps.push('No roles have been defined'); suggestions.push('Define roles based on your project category'); }
    else if (memberCount < roleCount) { gaps.push(`${roleCount - memberCount} role(s) still need team members`); }
    suggestions.push('Ensure clear ownership for each deliverable');
    return {
      score, gaps, suggestions,
      questions: ['Is the team capacity sufficient for the timeline?', 'Do team members have backup coverage?'],
      status: score >= 70 ? 'ready' : score >= 40 ? 'needs-attention' : 'critical',
      riskLevel: score >= 70 ? 'low' : score >= 40 ? 'medium' : 'high'
    };
  }

  // final
  const checks: Array<{ label: string; status: 'pass' | 'fail' | 'warning' }> = [
    { label: 'Project name defined', status: hasName ? 'pass' : 'fail' },
    { label: 'Description provided', status: hasDesc ? 'pass' : 'fail' },
    { label: 'Category selected', status: hasCat ? 'pass' : 'warning' },
    { label: 'Timeline set', status: hasTimeline ? 'pass' : 'warning' },
    { label: 'Objectives defined', status: objCount > 0 ? 'pass' : 'fail' },
    { label: 'Success criteria set', status: critCount > 0 ? 'pass' : 'warning' },
    { label: 'Roles defined', status: roleCount > 0 ? 'pass' : 'fail' },
    { label: 'Team members assigned', status: memberCount > 0 ? 'pass' : 'warning' },
  ];
  const passCount = checks.filter(c => c.status === 'pass').length;
  const score = Math.round((passCount / checks.length) * 100);
  return {
    score, gaps: [], suggestions: [], questions: [],
    status: score >= 70 ? 'ready' : score >= 40 ? 'needs-attention' : 'critical',
    checklist: checks,
    riskLevel: score >= 70 ? 'low' : score >= 40 ? 'medium' : 'high'
  };
}

/* ------------------------------------------------------------------ */
/*  Panel                                                             */
/* ------------------------------------------------------------------ */

export class NewProjectWizardPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private wizardState: WizardState = createInitialState();

  public open(): void {
    this.wizardState = createInitialState();
    this.ensurePanel();
    this.panel!.webview.html = this.getHtml();
    this.panel!.reveal(vscode.ViewColumn.Active, false);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): void {
    if (this.panel) { return; }
    this.panel = vscode.window.createWebviewPanel(
      'praxis.newProjectWizard',
      'New Project',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage(
      message => { void this.handleMessage(message); },
      undefined, []
    );
  }

  private rerender(): void {
    if (!this.panel) { return; }
    this.panel.webview.html = this.getHtml();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) { return; }
    const type = asString(message.type);

    if (type === 'navigateStep') {
      const step = typeof message.step === 'number' ? message.step : 0;
      this.wizardState.currentStep = Math.max(0, Math.min(2, step));
      this.rerender();
      return;
    }

    if (type === 'updateField') {
      this.applyFieldUpdate(message);
      return;
    }

    if (type === 'addListItem') {
      this.addListItem(asString(message.list) ?? '');
      this.rerender();
      return;
    }

    if (type === 'removeListItem') {
      const idx = typeof message.index === 'number' ? message.index : -1;
      this.removeListItem(asString(message.list) ?? '', idx);
      this.rerender();
      return;
    }

    if (type === 'suggestRoles') {
      this.suggestRoles();
      this.rerender();
      return;
    }

    if (type === 'addMember') {
      const name = asString(message.name) ?? '';
      const email = asString(message.email) ?? '';
      const role = asString(message.role) ?? '';
      const avail = typeof message.availability === 'number' ? message.availability : 100;
      if (name.trim()) {
        this.wizardState.teamMembers.push({ name: name.trim(), email: email.trim(), role, availability: avail });
        this.rerender();
      }
      return;
    }

    if (type === 'removeMember') {
      const idx = typeof message.index === 'number' ? message.index : -1;
      if (idx >= 0 && idx < this.wizardState.teamMembers.length) {
        this.wizardState.teamMembers.splice(idx, 1);
        this.rerender();
      }
      return;
    }

    if (type === 'aiReview') {
      const reviewType = asString(message.reviewType) ?? 'requirements';
      const result = generateMockAiReview(reviewType, this.wizardState);
      if (reviewType === 'requirements') { this.wizardState.aiReviews.requirements = result; }
      else if (reviewType === 'team') { this.wizardState.aiReviews.team = result; }
      else { this.wizardState.aiReviews.final = result; }
      this.rerender();
      return;
    }

    if (type === 'saveDraft') {
      void vscode.window.showInformationMessage('Project draft saved.');
      return;
    }

    if (type === 'createProject') {
      void vscode.window.showInformationMessage('Project created! 🚀');
      return;
    }
  }

  private applyFieldUpdate(msg: Record<string, unknown>): void {
    const field = asString(msg.field) ?? '';
    const value = asString(msg.value) ?? '';
    const s = this.wizardState;

    // project fields
    if (field === 'project.name') { s.project.name = value; }
    else if (field === 'project.description') { s.project.description = value; }
    else if (field === 'project.category') { s.project.category = value; }
    else if (field === 'project.priority') { s.project.priority = value; }
    else if (field === 'project.timeline') { s.project.timeline = value; }
    // list item updates (e.g. "objectives.0.title")
    else {
      const parts = field.split('.');
      if (parts.length === 3) {
        const listName = parts[0];
        const idx = parseInt(parts[1], 10);
        const prop = parts[2];
        const arr = (s as unknown as Record<string, unknown>)[listName];
        if (Array.isArray(arr) && idx >= 0 && idx < arr.length) {
          if (typeof arr[idx] === 'string') { arr[idx] = value; }
          else if (isRecord(arr[idx])) { (arr[idx] as Record<string, unknown>)[prop] = value; }
        }
      } else if (parts.length === 4 && parts[0] === 'roles') {
        // roles.0.skills or roles.0.count etc
        const idx = parseInt(parts[1], 10);
        const prop = parts[2];
        if (idx >= 0 && idx < s.roles.length) {
          if (prop === 'title') { s.roles[idx].title = value; }
          else if (prop === 'description') { s.roles[idx].description = value; }
          else if (prop === 'seniority') { s.roles[idx].seniority = value; }
          else if (prop === 'count') { s.roles[idx].count = parseInt(value, 10) || 1; }
          else if (prop === 'skills' && parts[3] === 'add') {
            if (value.trim() && !s.roles[idx].skills.includes(value.trim())) {
              s.roles[idx].skills.push(value.trim());
            }
          } else if (prop === 'skills' && parts[3] === 'remove') {
            const si = parseInt(value, 10);
            if (si >= 0) { s.roles[idx].skills.splice(si, 1); }
          }
        }
      }
    }
    // Don't rerender on every keystroke for text fields
  }

  private addListItem(list: string): void {
    const s = this.wizardState;
    if (list === 'objectives') { s.objectives.push({ title: '', description: '' }); }
    else if (list === 'successCriteria') { s.successCriteria.push({ metric: '', target: '', method: '' }); }
    else if (list === 'technicalRequirements') { s.technicalRequirements.push(''); }
    else if (list === 'businessRequirements') { s.businessRequirements.push(''); }
    else if (list === 'constraints') { s.constraints.push(''); }
    else if (list === 'roles') { s.roles.push({ title: '', description: '', skills: [], seniority: 'Mid', count: 1 }); }
  }

  private removeListItem(list: string, idx: number): void {
    const s = this.wizardState;
    const arr = (s as unknown as Record<string, unknown>)[list];
    if (Array.isArray(arr) && idx >= 0 && idx < arr.length && arr.length > 0) {
      arr.splice(idx, 1);
    }
  }

  private suggestRoles(): void {
    const cat = this.wizardState.project.category;
    const suggestions: Record<string, Array<{ title: string; description: string; skills: string[]; seniority: string; count: number }>> = {
      'Software': [
        { title: 'Developer', description: 'Full-stack software developer', skills: ['TypeScript', 'React', 'Node.js'], seniority: 'Mid', count: 2 },
        { title: 'QA Engineer', description: 'Quality assurance and testing', skills: ['Testing', 'Automation'], seniority: 'Mid', count: 1 },
        { title: 'Designer', description: 'UI/UX designer', skills: ['Figma', 'UI Design'], seniority: 'Mid', count: 1 },
        { title: 'Project Manager', description: 'Project coordination', skills: ['Agile', 'Scrum'], seniority: 'Senior', count: 1 }
      ],
      'Infrastructure': [
        { title: 'DevOps Engineer', description: 'CI/CD and infrastructure', skills: ['Docker', 'Kubernetes', 'Terraform'], seniority: 'Senior', count: 2 },
        { title: 'SRE', description: 'Site reliability', skills: ['Monitoring', 'Linux'], seniority: 'Mid', count: 1 }
      ],
      'Research': [
        { title: 'Research Lead', description: 'Lead research initiatives', skills: ['Data Analysis', 'Research Methods'], seniority: 'Senior', count: 1 },
        { title: 'Analyst', description: 'Data collection and analysis', skills: ['Statistics', 'Python'], seniority: 'Mid', count: 2 }
      ]
    };
    const toAdd = suggestions[cat] ?? suggestions['Software'] ?? [];
    for (const r of toAdd) {
      if (!this.wizardState.roles.some(existing => existing.title === r.title)) {
        this.wizardState.roles.push({ ...r });
      }
    }
  }

  /* ================================================================ */
  /*  HTML — fully server-rendered (matching working panels)          */
  /* ================================================================ */

  private getHtml(): string {
    const nonce = createNonce();
    const s = this.wizardState;
    const step = s.currentStep;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Project</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 20px 40px;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 13px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    .root { max-width: 860px; margin: 0 auto; }

    /* Step indicator */
    .steps { display: flex; align-items: center; justify-content: center; gap: 0; margin-bottom: 28px; }
    .step-node { display: flex; flex-direction: column; align-items: center; gap: 4px; z-index: 1; }
    .step-circle {
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px;
      border: 2px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      transition: all .2s;
    }
    .step-circle.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-focusBorder);
      color: var(--vscode-button-foreground, #fff);
    }
    .step-circle.done {
      border-color: var(--vscode-testing-iconPassed, #4caf50);
      background: var(--vscode-testing-iconPassed, #4caf50);
      color: #fff;
    }
    .step-label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .step-label.active { color: var(--vscode-editor-foreground); font-weight: 600; }
    .step-connector { width: 80px; height: 2px; background: var(--vscode-panel-border); margin-bottom: 20px; }
    .step-connector.done { background: var(--vscode-testing-iconPassed, #4caf50); }

    /* Cards */
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 16px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .card-title {
      font-size: 14px; font-weight: 600; margin-bottom: 14px;
      display: flex; align-items: center; gap: 8px;
    }
    .card-title .icon { font-size: 16px; }

    /* AI card */
    .ai-card {
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 16px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 6%, var(--vscode-editor-background));
    }

    /* Form */
    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--vscode-editor-foreground); }
    .field .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    input[type="text"], input[type="number"], input[type="email"], textarea, select {
      width: 100%;
      padding: 7px 10px;
      font: inherit;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--vscode-focusBorder); }
    textarea { resize: vertical; min-height: 60px; }

    .row { display: flex; gap: 12px; }
    .row .field { flex: 1; min-width: 0; }

    /* Chips */
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      padding: 4px 14px;
      border-radius: 14px;
      font-size: 12px; font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-editor-foreground);
      transition: all .15s;
    }
    .chip:hover { border-color: var(--vscode-focusBorder); }
    .chip.selected {
      background: var(--vscode-focusBorder);
      color: var(--vscode-button-foreground, #fff);
      border-color: var(--vscode-focusBorder);
    }

    /* Buttons */
    button {
      padding: 7px 16px;
      font: inherit;
      font-size: 13px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { opacity: .9; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border-color: var(--vscode-panel-border);
    }
    .btn-small { padding: 4px 10px; font-size: 12px; }
    .btn-icon { background: transparent; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); padding: 2px 5px; font-size: 15px; }
    .btn-icon:hover { color: var(--vscode-testing-iconFailed, red); }

    /* Dynamic list */
    .list-item {
      position: relative;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
    }
    .list-item .remove-btn {
      position: absolute; top: 6px; right: 8px;
    }

    /* Skill tags */
    .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .tag {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 10px; font-size: 11px;
      background: var(--vscode-badge-background, var(--vscode-focusBorder));
      color: var(--vscode-badge-foreground, #fff);
    }
    .tag .remove-tag { cursor: pointer; font-size: 13px; opacity: .8; }
    .tag .remove-tag:hover { opacity: 1; }

    /* Member chips */
    .member-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 16px; margin: 2px;
      background: var(--vscode-badge-background, var(--vscode-focusBorder));
      color: var(--vscode-badge-foreground, #fff);
      font-size: 12px;
    }
    .member-chip .avatar {
      width: 20px; height: 20px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
      background: rgba(255,255,255,.2);
    }

    /* Progress ring */
    .ring-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }
    .ring-wrap svg { transform: rotate(-90deg); }
    .ring-wrap .track { fill: none; stroke: var(--vscode-panel-border); stroke-width: 6; }
    .ring-wrap .fill { fill: none; stroke-width: 6; stroke-linecap: round; transition: stroke-dashoffset .5s; }
    .ring-label { position: absolute; font-weight: 700; font-size: 16px; }

    /* Status badges */
    .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge-pass { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 15%, transparent); color: var(--vscode-testing-iconPassed, #4caf50); }
    .badge-warning { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #ff9800) 15%, transparent); color: var(--vscode-editorWarning-foreground, #ff9800); }
    .badge-fail { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f44336) 15%, transparent); color: var(--vscode-testing-iconFailed, #f44336); }

    /* Checklist */
    .checklist { list-style: none; padding: 0; }
    .checklist li { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; }
    .checklist li:last-child { border-bottom: none; }

    /* Summary grid */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .stat-card { padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; text-align: center; }
    .stat-card .stat-value { font-size: 22px; font-weight: 700; }
    .stat-card .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

    /* Footer */
    .footer { display: flex; justify-content: space-between; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer-right { display: flex; gap: 8px; }

    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .mt-8 { margin-top: 8px; }
    .mt-12 { margin-top: 12px; }
    .mb-4 { margin-bottom: 4px; }
    .mb-12 { margin-bottom: 12px; }
    .gap-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  </style>
</head>
<body>
<div class="root">

  ${this.renderStepIndicator(step)}

  ${step === 0 ? this.renderStep0(s) : step === 1 ? this.renderStep1(s) : this.renderStep2(s)}

  ${this.renderFooter(step)}

</div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();

  function post(type, data) {
    vscodeApi.postMessage(Object.assign({ type: type }, data || {}));
  }

  document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const data = Object.assign({}, btn.dataset);
    delete data.action;

    if (action === 'navigate') { post('navigateStep', { step: parseInt(data.step, 10) }); }
    else if (action === 'addListItem') { post('addListItem', { list: data.list }); }
    else if (action === 'removeListItem') { post('removeListItem', { list: data.list, index: parseInt(data.index, 10) }); }
    else if (action === 'suggestRoles') { post('suggestRoles'); }
    else if (action === 'removeMember') { post('removeMember', { index: parseInt(data.index, 10) }); }
    else if (action === 'removeSkill') { post('updateField', { field: 'roles.' + data.role + '.skills.remove', value: data.skill }); post('navigateStep', { step: 1 }); }
    else if (action === 'aiReview') { post('aiReview', { reviewType: data.reviewtype }); }
    else if (action === 'saveDraft') { post('saveDraft'); }
    else if (action === 'createProject') { post('createProject'); }
    else if (action === 'selectPriority') {
      post('updateField', { field: 'project.priority', value: data.priority });
      post('navigateStep', { step: 0 });
    }
  });

  document.addEventListener('change', function(e) {
    const el = e.target;
    if (el.dataset && el.dataset.field) {
      post('updateField', { field: el.dataset.field, value: el.value });
    }
  });

  document.addEventListener('input', function(e) {
    const el = e.target;
    if (el.dataset && el.dataset.field) {
      post('updateField', { field: el.dataset.field, value: el.value });
    }
  });

  // Skill tag input on Enter
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.skillinput !== undefined) {
      e.preventDefault();
      var val = e.target.value.trim();
      if (val) {
        post('updateField', { field: 'roles.' + e.target.dataset.roleidx + '.skills.add', value: val });
        post('navigateStep', { step: 1 });
      }
    }
  });

  // Add member form
  var addMemberBtn = document.getElementById('addMemberBtn');
  if (addMemberBtn) {
    addMemberBtn.addEventListener('click', function() {
      var name = document.getElementById('memberName');
      var email = document.getElementById('memberEmail');
      var role = document.getElementById('memberRole');
      var avail = document.getElementById('memberAvail');
      if (name && name.value.trim()) {
        post('addMember', {
          name: name.value,
          email: email ? email.value : '',
          role: role ? role.value : '',
          availability: avail ? parseInt(avail.value, 10) || 100 : 100
        });
      }
    });
  }
</script>
</body>
</html>`;
  }

  /* ================================================================ */
  /*  Server-side rendered sections                                   */
  /* ================================================================ */

  private renderStepIndicator(step: number): string {
    const steps = [
      { icon: '🎯', label: 'Define Goal' },
      { icon: '👥', label: 'Team & Roles' },
      { icon: '🚀', label: 'Review & Launch' }
    ];

    let html = '<div class="steps">';
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) {
        html += `<div class="step-connector${i <= step ? ' done' : ''}"></div>`;
      }
      const cls = i < step ? 'done' : i === step ? 'active' : '';
      html += `<div class="step-node">
        <div class="step-circle ${cls}" data-action="navigate" data-step="${i}" style="cursor:pointer">
          ${i < step ? '✓' : steps[i].icon}
        </div>
        <div class="step-label ${cls}">${steps[i].label}</div>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  private renderFooter(step: number): string {
    return `<div class="footer">
      <div>
        ${step > 0 ? `<button class="btn-secondary" data-action="navigate" data-step="${step - 1}">← Back</button>` : '<span></span>'}
      </div>
      <div class="footer-right">
        ${step < 2
          ? `<button class="btn-primary" data-action="navigate" data-step="${step + 1}">Next →</button>`
          : `<button class="btn-secondary" data-action="saveDraft">Save Draft</button>
             <button class="btn-primary" data-action="createProject">🚀 Create Project</button>`
        }
      </div>
    </div>`;
  }

  /* ---- Step 0: Define Goal ---- */

  private renderStep0(s: WizardState): string {
    const categories = ['Software', 'Infrastructure', 'Research', 'Marketing', 'Operations', 'Other'];
    const timelines = ['1 week', '2 weeks', '1 month', '2 months', '3 months', '6 months', 'Custom'];
    const priorities = ['High', 'Medium', 'Low'];

    let catOpts = '<option value="">Select category…</option>';
    for (const c of categories) { catOpts += `<option value="${esc(c)}"${s.project.category === c ? ' selected' : ''}>${esc(c)}</option>`; }

    let tlOpts = '<option value="">Select timeline…</option>';
    for (const t of timelines) { tlOpts += `<option value="${esc(t)}"${s.project.timeline === t ? ' selected' : ''}>${esc(t)}</option>`; }

    let priorityChips = '';
    for (const p of priorities) { priorityChips += `<span class="chip${s.project.priority === p ? ' selected' : ''}" data-action="selectPriority" data-priority="${esc(p)}">${esc(p)}</span>`; }

    return `
      <div class="card">
        <div class="card-title"><span class="icon">📋</span> Project Overview</div>
        <div class="field">
          <label>Project Name <span style="color:var(--vscode-testing-iconFailed)">*</span></label>
          <input type="text" data-field="project.name" value="${esc(s.project.name)}" placeholder="Enter project name…" />
        </div>
        <div class="field">
          <label>Description</label>
          <textarea data-field="project.description" rows="4" placeholder="Describe the project goals, scope, and expected outcomes…">${esc(s.project.description)}</textarea>
        </div>
        <div class="row">
          <div class="field"><label>Category</label><select data-field="project.category">${catOpts}</select></div>
          <div class="field"><label>Target Timeline</label><select data-field="project.timeline">${tlOpts}</select></div>
        </div>
        <div class="field"><label>Priority</label><div class="chips">${priorityChips}</div></div>
      </div>

      ${this.renderObjectives(s)}
      ${this.renderRequirements(s)}
      ${this.renderAiRequirementsReview(s)}
    `;
  }

  private renderObjectives(s: WizardState): string {
    let objHtml = '';
    s.objectives.forEach((o, i) => {
      objHtml += `<div class="list-item">
        <button class="btn-icon remove-btn" data-action="removeListItem" data-list="objectives" data-index="${i}" title="Remove">✕</button>
        <div class="field mb-4"><label>Objective ${i + 1}</label><input type="text" data-field="objectives.${i}.title" value="${esc(o.title)}" placeholder="Objective title…" /></div>
        <div class="field"><textarea data-field="objectives.${i}.description" rows="2" placeholder="Description…">${esc(o.description)}</textarea></div>
      </div>`;
    });

    let critHtml = '';
    s.successCriteria.forEach((c, i) => {
      critHtml += `<div class="list-item">
        <button class="btn-icon remove-btn" data-action="removeListItem" data-list="successCriteria" data-index="${i}" title="Remove">✕</button>
        <div class="row">
          <div class="field"><label>Metric</label><input type="text" data-field="successCriteria.${i}.metric" value="${esc(c.metric)}" placeholder="e.g. Response time" /></div>
          <div class="field"><label>Target</label><input type="text" data-field="successCriteria.${i}.target" value="${esc(c.target)}" placeholder="e.g. < 200ms" /></div>
          <div class="field"><label>Method</label><input type="text" data-field="successCriteria.${i}.method" value="${esc(c.method)}" placeholder="e.g. Load test" /></div>
        </div>
      </div>`;
    });

    return `<div class="card">
      <div class="card-title"><span class="icon">🎯</span> Objectives & Success Criteria</div>
      <div class="mb-12">
        <div style="display:flex;justify-content:space-between;align-items:center;" class="mb-4">
          <label style="font-weight:600;font-size:12px;">Objectives</label>
          <button class="btn-secondary btn-small" data-action="addListItem" data-list="objectives">➕ Add Objective</button>
        </div>
        ${objHtml}
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;" class="mb-4">
          <label style="font-weight:600;font-size:12px;">Success Criteria</label>
          <button class="btn-secondary btn-small" data-action="addListItem" data-list="successCriteria">➕ Add Criteria</button>
        </div>
        ${critHtml}
      </div>
    </div>`;
  }

  private renderRequirements(s: WizardState): string {
    const renderList = (label: string, listName: string, items: string[], placeholder: string) => {
      let html = `<div class="mb-12">
        <div style="display:flex;justify-content:space-between;align-items:center;" class="mb-4">
          <label style="font-weight:600;font-size:12px;">${label}</label>
          <button class="btn-secondary btn-small" data-action="addListItem" data-list="${listName}">➕ Add</button>
        </div>`;
      items.forEach((item, i) => {
        html += `<div class="gap-row">
          <input type="text" data-field="${listName}.${i}" value="${esc(item)}" placeholder="${placeholder}" style="flex:1" />
          <button class="btn-icon" data-action="removeListItem" data-list="${listName}" data-index="${i}">✕</button>
        </div>`;
      });
      html += '</div>';
      return html;
    };

    return `<div class="card">
      <div class="card-title"><span class="icon">📝</span> Requirements</div>
      ${renderList('Technical Requirements', 'technicalRequirements', s.technicalRequirements, 'e.g. Must support 10k concurrent users')}
      ${renderList('Business Requirements', 'businessRequirements', s.businessRequirements, 'e.g. Reduce onboarding time by 50%')}
      ${renderList('Constraints', 'constraints', s.constraints, 'e.g. Budget limited to $50k')}
    </div>`;
  }

  private renderAiRequirementsReview(s: WizardState): string {
    const review = s.aiReviews.requirements;
    let body = `<button class="btn-primary" data-action="aiReview" data-reviewtype="requirements">✨ Analyze Requirements</button>`;
    if (review) {
      body = this.renderAiResult(review);
    }
    return `<div class="ai-card">
      <div class="card-title"><span class="icon">✨</span> AI Requirements Review</div>
      ${body}
    </div>`;
  }

  /* ---- Step 1: Team & Roles ---- */

  private renderStep1(s: WizardState): string {
    return `
      ${this.renderRoles(s)}
      ${this.renderTeamAssembly(s)}
      ${this.renderAiTeamReview(s)}
    `;
  }

  private renderRoles(s: WizardState): string {
    let rolesHtml = '';
    s.roles.forEach((r, i) => {
      let skillTags = '';
      r.skills.forEach((sk, si) => {
        skillTags += `<span class="tag">${esc(sk)} <span class="remove-tag" data-action="removeSkill" data-role="${i}" data-skill="${si}">✕</span></span>`;
      });

      let senOpts = '';
      for (const sen of ['Junior', 'Mid', 'Senior', 'Lead']) {
        senOpts += `<option value="${sen}"${r.seniority === sen ? ' selected' : ''}>${sen}</option>`;
      }

      rolesHtml += `<div class="list-item">
        <button class="btn-icon remove-btn" data-action="removeListItem" data-list="roles" data-index="${i}" title="Remove">✕</button>
        <div class="row mb-4">
          <div class="field"><label>Role Title</label><input type="text" data-field="roles.${i}.title" value="${esc(r.title)}" placeholder="e.g. Developer" /></div>
          <div class="field"><label>Seniority</label><select data-field="roles.${i}.seniority">${senOpts}</select></div>
          <div class="field" style="max-width:80px"><label>Count</label><input type="number" data-field="roles.${i}.count" value="${r.count}" min="1" /></div>
        </div>
        <div class="field mb-4"><label>Description</label><input type="text" data-field="roles.${i}.description" value="${esc(r.description)}" placeholder="Role description…" /></div>
        <div class="field">
          <label>Skills</label>
          <div class="tags mb-4">${skillTags}</div>
          <input type="text" data-skillinput data-roleidx="${i}" placeholder="Type skill and press Enter…" style="max-width:250px" />
        </div>
      </div>`;
    });

    return `<div class="card">
      <div class="card-title"><span class="icon">🛡️</span> Role Definition</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button class="btn-secondary btn-small" data-action="addListItem" data-list="roles">➕ Add Role</button>
        <button class="btn-secondary btn-small" data-action="suggestRoles">💡 Suggest Roles</button>
      </div>
      ${s.roles.length === 0 ? '<p class="muted">No roles defined yet. Add roles manually or click "Suggest Roles" based on your project category.</p>' : rolesHtml}
    </div>`;
  }

  private renderTeamAssembly(s: WizardState): string {
    let membersHtml = '';
    if (s.teamMembers.length > 0) {
      s.teamMembers.forEach((m, i) => {
        const initials = m.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        membersHtml += `<span class="member-chip">
          <span class="avatar">${esc(initials)}</span>
          ${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ''}${m.availability < 100 ? ` (${m.availability}%)` : ''}
          <span class="btn-icon" data-action="removeMember" data-index="${i}" style="font-size:13px;padding:0 2px;color:inherit;">✕</span>
        </span>`;
      });
    } else {
      membersHtml = '<p class="muted">No team members assigned yet.</p>';
    }

    let roleOpts = '<option value="">Any role</option>';
    for (const r of s.roles) { roleOpts += `<option value="${esc(r.title)}">${esc(r.title)}</option>`; }

    return `<div class="card">
      <div class="card-title"><span class="icon">👥</span> Team Assembly</div>
      <div class="mb-12">${membersHtml}</div>
      <div style="border:1px dashed var(--vscode-panel-border);border-radius:6px;padding:12px;">
        <div style="font-weight:600;font-size:12px;margin-bottom:8px;">Add Team Member</div>
        <div class="row mb-4">
          <div class="field"><label>Name</label><input type="text" id="memberName" placeholder="Full name…" /></div>
          <div class="field"><label>Email</label><input type="email" id="memberEmail" placeholder="Email…" /></div>
        </div>
        <div class="row mb-4">
          <div class="field"><label>Role</label><select id="memberRole">${roleOpts}</select></div>
          <div class="field" style="max-width:120px"><label>Availability %</label><input type="number" id="memberAvail" value="100" min="0" max="100" /></div>
        </div>
        <button class="btn-primary btn-small" id="addMemberBtn">➕ Add Member</button>
      </div>
    </div>`;
  }

  private renderAiTeamReview(s: WizardState): string {
    const review = s.aiReviews.team;
    let body = `<button class="btn-primary" data-action="aiReview" data-reviewtype="team">✨ Analyze Team Composition</button>`;
    if (review) { body = this.renderAiResult(review); }
    return `<div class="ai-card">
      <div class="card-title"><span class="icon">✨</span> AI Team Analysis</div>
      ${body}
    </div>`;
  }

  /* ---- Step 2: Review & Launch ---- */

  private renderStep2(s: WizardState): string {
    const objCount = s.objectives.filter(o => o.title.trim()).length;
    const reqCount = s.technicalRequirements.filter(r => r.trim()).length + s.businessRequirements.filter(r => r.trim()).length;
    const memberCount = s.teamMembers.length;

    let roleBreakdown = '';
    if (s.roles.length > 0) {
      roleBreakdown = '<table style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse;">';
      roleBreakdown += '<tr style="border-bottom:1px solid var(--vscode-panel-border)"><th style="text-align:left;padding:4px 0">Role</th><th style="text-align:center">Needed</th><th style="text-align:center">Assigned</th></tr>';
      for (const r of s.roles) {
        const assigned = s.teamMembers.filter(m => m.role === r.title).length;
        const color = assigned >= r.count ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-editorWarning-foreground)';
        roleBreakdown += `<tr><td style="padding:4px 0">${esc(r.title)}</td><td style="text-align:center">${r.count}</td><td style="text-align:center;color:${color}">${assigned}</td></tr>`;
      }
      roleBreakdown += '</table>';
    }

    return `
      <div class="card">
        <div class="card-title"><span class="icon">📊</span> Project Summary</div>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-value">${esc(s.project.name || '—')}</div>
            <div class="stat-label">Project Name</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${objCount}</div>
            <div class="stat-label">Objectives</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${reqCount}</div>
            <div class="stat-label">Requirements</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${memberCount}</div>
            <div class="stat-label">Team Members</div>
          </div>
        </div>
        ${s.project.category ? `<p class="muted">Category: ${esc(s.project.category)} · Priority: ${esc(s.project.priority)} · Timeline: ${esc(s.project.timeline || 'Not set')}</p>` : ''}
        ${roleBreakdown}
      </div>

      ${this.renderAiFinalReview(s)}
    `;
  }

  private renderAiFinalReview(s: WizardState): string {
    const review = s.aiReviews.final;
    let body = `<button class="btn-primary" data-action="aiReview" data-reviewtype="final">✨ Run Final Review</button>`;
    if (review) { body = this.renderAiResult(review); }
    return `<div class="ai-card">
      <div class="card-title"><span class="icon">✨</span> AI Final Review</div>
      ${body}
    </div>`;
  }

  /* ---- AI result rendering ---- */

  private renderAiResult(review: AiReviewResult): string {
    const size = 80;
    const r = (size - 12) / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ - (review.score / 100) * circ;
    const color = review.score >= 70 ? 'var(--vscode-testing-iconPassed)' : review.score >= 40 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-testing-iconFailed)';
    const statusBadge = review.status === 'ready' ? 'badge-pass' : review.status === 'needs-attention' ? 'badge-warning' : 'badge-fail';
    const statusText = review.status === 'ready' ? 'Ready to Proceed' : review.status === 'needs-attention' ? 'Needs Attention' : 'Critical Issues';

    let html = `<div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;">
      <div class="ring-wrap" style="width:${size}px;height:${size}px;">
        <svg width="${size}" height="${size}">
          <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>
          <circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
        </svg>
        <span class="ring-label">${review.score}%</span>
      </div>
      <div>
        <div style="font-size:16px;font-weight:700;margin-bottom:4px;">Completeness Score</div>
        <span class="badge ${statusBadge}">${statusText}</span>
        ${review.riskLevel ? ` <span class="badge badge-${review.riskLevel === 'low' ? 'pass' : review.riskLevel === 'medium' ? 'warning' : 'fail'}">Risk: ${review.riskLevel}</span>` : ''}
      </div>
    </div>`;

    if (review.checklist && review.checklist.length > 0) {
      html += '<ul class="checklist">';
      for (const item of review.checklist) {
        const icon = item.status === 'pass' ? '✅' : item.status === 'warning' ? '⚠️' : '❌';
        html += `<li>${icon} ${esc(item.label)}</li>`;
      }
      html += '</ul>';
    }

    if (review.gaps.length > 0) {
      html += '<div class="mt-12"><strong>⚠️ Identified Gaps</strong><ul style="margin:4px 0 0 16px;">';
      for (const g of review.gaps) { html += `<li>${esc(g)}</li>`; }
      html += '</ul></div>';
    }

    if (review.suggestions.length > 0) {
      html += '<div class="mt-8"><strong>💡 Suggestions</strong><ul style="margin:4px 0 0 16px;">';
      for (const sg of review.suggestions) { html += `<li>${esc(sg)}</li>`; }
      html += '</ul></div>';
    }

    if (review.questions.length > 0) {
      html += '<div class="mt-8"><strong>❓ Questions to Consider</strong><ol style="margin:4px 0 0 16px;">';
      for (const q of review.questions) { html += `<li>${esc(q)}</li>`; }
      html += '</ol></div>';
    }

    return html;
  }
}
