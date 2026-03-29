import * as vscode from 'vscode';

/* ------------------------------------------------------------------ */
/*  Helper utilities (same pattern as other panels in this codebase)  */
/* ------------------------------------------------------------------ */

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value: string): string {
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
/*  State types                                                       */
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
    project: {
      name: '',
      description: '',
      category: '',
      priority: 'Medium',
      timeline: ''
    },
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
/*  Mock AI review generator                                          */
/* ------------------------------------------------------------------ */

function generateMockAiReview(
  reviewType: string,
  state: WizardState
): AiReviewResult {
  if (reviewType === 'requirements') {
    const hasName = state.project.name.trim().length > 0;
    const hasDescription = state.project.description.trim().length > 0;
    const hasCategory = state.project.category.trim().length > 0;
    const hasObjectives = state.objectives.some(o => o.title.trim().length > 0);
    const hasCriteria = state.successCriteria.some(c => c.metric.trim().length > 0);
    const hasTechReqs = state.technicalRequirements.some(r => r.trim().length > 0);
    const hasBusinessReqs = state.businessRequirements.some(r => r.trim().length > 0);

    const checks = [hasName, hasDescription, hasCategory, hasObjectives, hasCriteria, hasTechReqs, hasBusinessReqs];
    const filled = checks.filter(Boolean).length;
    const score = Math.round((filled / checks.length) * 100);

    const gaps: string[] = [];
    if (!hasName) { gaps.push('Project name is missing'); }
    if (!hasDescription) { gaps.push('Project description is empty'); }
    if (!hasCategory) { gaps.push('No project category selected'); }
    if (!hasObjectives) { gaps.push('No objectives have been defined'); }
    if (!hasCriteria) { gaps.push('Success criteria are not specified'); }
    if (!hasTechReqs) { gaps.push('Technical requirements not listed'); }
    if (!hasBusinessReqs) { gaps.push('Business requirements not listed'); }

    const suggestions: string[] = [
      'Add measurable KPIs to each objective for better tracking',
      'Consider adding risk mitigation strategies to constraints',
      'Define acceptance criteria for each requirement'
    ];
    if (!hasDescription) {
      suggestions.unshift('Provide a 2-3 sentence project description summarizing the goals');
    }

    const questions: string[] = [
      'Who are the primary stakeholders for this project?',
      'Are there any external dependencies or third-party integrations?',
      'What is the budget allocation for this project?',
      'Have similar projects been attempted before?'
    ];

    return {
      score,
      gaps,
      suggestions: suggestions.slice(0, 4),
      questions: questions.slice(0, 4),
      status: score >= 70 ? 'ready' : score >= 40 ? 'needs-attention' : 'critical'
    };
  }

  if (reviewType === 'team') {
    const roleCount = state.roles.length;
    const memberCount = state.teamMembers.length;
    const filledRoles = new Set(state.teamMembers.map(m => m.role));
    const unfilledRoles = state.roles.filter(r => !filledRoles.has(r.title));
    const totalNeeded = state.roles.reduce((sum, r) => sum + r.count, 0);
    const score = totalNeeded > 0 ? Math.round((memberCount / totalNeeded) * 100) : (roleCount > 0 ? 50 : 0);

    const gaps: string[] = [];
    if (roleCount === 0) { gaps.push('No roles have been defined'); }
    if (unfilledRoles.length > 0) {
      gaps.push(`${unfilledRoles.length} role(s) still unfilled: ${unfilledRoles.map(r => r.title).join(', ')}`);
    }
    if (memberCount === 0) { gaps.push('No team members have been assigned'); }

    return {
      score: Math.min(score, 100),
      gaps,
      suggestions: [
        'Consider adding a dedicated QA role for quality assurance',
        'Ensure at least one senior team member per functional area',
        'Plan for cross-training to reduce single points of failure'
      ],
      questions: [
        'Is there a designated backup for each critical role?',
        'Are team members available full-time or shared across projects?'
      ],
      status: score >= 70 ? 'ready' : score >= 40 ? 'needs-attention' : 'critical',
      riskLevel: score >= 70 ? 'low' : score >= 40 ? 'medium' : 'high'
    };
  }

  /* final review */
  const reqReview = state.aiReviews.requirements;
  const teamReview = state.aiReviews.team;
  const reqScore = reqReview?.score ?? 0;
  const teamScore = teamReview?.score ?? 0;
  const finalScore = Math.round((reqScore + teamScore) / 2);

  const checklist: Array<{ label: string; status: 'pass' | 'fail' | 'warning' }> = [
    { label: 'Goal Definition Complete', status: state.project.name ? 'pass' : 'fail' },
    { label: 'Project Description Provided', status: state.project.description ? 'pass' : 'warning' },
    { label: 'Category Selected', status: state.project.category ? 'pass' : 'fail' },
    { label: 'Success Criteria Defined', status: state.successCriteria.some(c => c.metric.trim()) ? 'pass' : 'warning' },
    { label: 'Objectives Documented', status: state.objectives.some(o => o.title.trim()) ? 'pass' : 'warning' },
    { label: 'Team Roles Defined', status: state.roles.length > 0 ? 'pass' : 'fail' },
    {
      label: `Team Coverage (${state.teamMembers.length} of ${state.roles.reduce((s, r) => s + r.count, 0)} filled)`,
      status: state.teamMembers.length >= state.roles.reduce((s, r) => s + r.count, 0) ? 'pass' : 'warning'
    },
    { label: 'Timeline Set', status: state.project.timeline ? 'pass' : 'warning' }
  ];

  return {
    score: finalScore,
    gaps: checklist.filter(c => c.status === 'fail').map(c => c.label + ' is incomplete'),
    suggestions: [
      'Address all warning items before launch for best results',
      'Schedule a kick-off meeting within the first week'
    ],
    questions: [
      'Has the project plan been reviewed by all stakeholders?'
    ],
    status: finalScore >= 70 ? 'ready' : finalScore >= 40 ? 'needs-attention' : 'critical',
    checklist,
    riskLevel: finalScore >= 70 ? 'low' : finalScore >= 40 ? 'medium' : 'high'
  };
}

/* ------------------------------------------------------------------ */
/*  Panel class                                                       */
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
    if (this.panel) {
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.newProjectWizard',
      'New Project',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );
  }

  private render(): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = this.getHtml();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);

    if (type === 'navigateStep') {
      const step = typeof message.step === 'number' ? message.step : 0;
      this.wizardState.currentStep = step;
      return;
    }

    if (type === 'updateState') {
      /* State lives primarily in the webview JS; this is informational. */
      return;
    }

    if (type === 'aiReview') {
      const reviewType = asString(message.reviewType) ?? 'requirements';
      let state = this.wizardState;
      if (isRecord(message.state)) {
        try {
          state = message.state as unknown as WizardState;
        } catch {
          /* keep existing state */
        }
      }
      const result = generateMockAiReview(reviewType, state);

      if (reviewType === 'requirements') {
        this.wizardState.aiReviews.requirements = result;
      } else if (reviewType === 'team') {
        this.wizardState.aiReviews.team = result;
      } else {
        this.wizardState.aiReviews.final = result;
      }

      await this.panel?.webview.postMessage({
        type: 'aiReviewResult',
        reviewType,
        result
      });
      return;
    }

    if (type === 'saveDraft') {
      void vscode.window.showInformationMessage('Project draft saved successfully.');
      return;
    }

    if (type === 'createProject') {
      void vscode.window.showInformationMessage('Project created successfully! 🚀');
      return;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  HTML generation                                                 */
  /* ---------------------------------------------------------------- */

  private getHtml(): string {
    const nonce = createNonce();
    const stateJson = JSON.stringify(this.wizardState);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
<title>New Project Wizard</title>
<style>
/* ===== Reset & Base ===== */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{font-size:13px;}
body{
  font-family:var(--vscode-font-family,system-ui,sans-serif);
  color:var(--vscode-editor-foreground);
  background:var(--vscode-editor-background);
  line-height:1.5;
  padding:0;
}
a{color:var(--vscode-textLink-foreground);text-decoration:none;}
a:hover{text-decoration:underline;}

/* ===== Layout ===== */
.wizard-root{
  max-width:900px;
  margin:0 auto;
  padding:24px 20px 40px;
}

/* ===== Step Indicator ===== */
.step-indicator{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:0;
  margin-bottom:32px;
  user-select:none;
}
.step-node{
  display:flex;
  flex-direction:column;
  align-items:center;
  position:relative;
  z-index:1;
}
.step-circle{
  width:38px;height:38px;
  border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:14px;
  border:2px solid var(--vscode-panel-border);
  background:var(--vscode-editor-background);
  color:var(--vscode-descriptionForeground);
  transition:all .25s ease;
}
.step-node.active .step-circle{
  border-color:var(--vscode-focusBorder);
  background:var(--vscode-focusBorder);
  color:var(--vscode-button-foreground);
}
.step-node.completed .step-circle{
  border-color:var(--vscode-testing-iconPassed);
  background:var(--vscode-testing-iconPassed);
  color:#fff;
}
.step-label{
  margin-top:6px;
  font-size:11px;
  color:var(--vscode-descriptionForeground);
  white-space:nowrap;
}
.step-node.active .step-label{
  color:var(--vscode-editor-foreground);
  font-weight:600;
}
.step-connector{
  flex:1;
  height:2px;
  max-width:120px;
  min-width:40px;
  background:var(--vscode-panel-border);
  margin:0 4px;
  margin-bottom:22px;
  transition:background .25s ease;
}
.step-connector.done{
  background:var(--vscode-testing-iconPassed);
}

/* ===== Cards ===== */
.card{
  border:1px solid var(--vscode-panel-border);
  border-radius:8px;
  padding:20px;
  margin-bottom:16px;
  background:var(--vscode-sideBar-background);
  transition:border-color .2s;
}
.card:hover{border-color:var(--vscode-focusBorder);}
.card-title{
  font-size:15px;font-weight:600;
  margin-bottom:12px;
  display:flex;align-items:center;gap:8px;
}
.card-title .icon{font-size:18px;}

/* AI special card */
.card.ai-card{
  border-image:linear-gradient(135deg,
    var(--vscode-focusBorder),
    var(--vscode-progressBar-background),
    var(--vscode-focusBorder)) 1;
  position:relative;
  overflow:hidden;
}
.card.ai-card::before{
  content:'';
  position:absolute;
  inset:0;
  background:linear-gradient(135deg,
    color-mix(in srgb, var(--vscode-focusBorder) 6%, transparent),
    transparent 60%);
  pointer-events:none;
}

/* ===== Form Controls ===== */
label{
  display:block;
  font-size:12px;
  font-weight:600;
  margin-bottom:4px;
  color:var(--vscode-editor-foreground);
}
.field{margin-bottom:14px;}
input[type="text"],
input[type="email"],
input[type="number"],
textarea,
select{
  width:100%;
  padding:7px 10px;
  font-size:13px;
  font-family:inherit;
  color:var(--vscode-editor-foreground);
  background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:4px;
  outline:none;
  transition:border-color .15s;
}
input:focus,textarea:focus,select:focus{
  border-color:var(--vscode-focusBorder);
}
textarea{resize:vertical;min-height:60px;}
select{cursor:pointer;}

/* ===== Chips / Badges ===== */
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;}
.chip{
  display:inline-flex;align-items:center;gap:4px;
  padding:4px 12px;
  border-radius:16px;
  font-size:12px;
  border:1px solid var(--vscode-panel-border);
  background:var(--vscode-editor-background);
  cursor:pointer;
  transition:all .15s;
  user-select:none;
}
.chip:hover{border-color:var(--vscode-focusBorder);}
.chip.selected{
  background:var(--vscode-focusBorder);
  color:var(--vscode-button-foreground);
  border-color:var(--vscode-focusBorder);
}
.chip .remove{
  cursor:pointer;
  font-size:14px;
  line-height:1;
  opacity:.7;
  margin-left:2px;
}
.chip .remove:hover{opacity:1;}

/* ===== Tags input ===== */
.tags-wrap{
  display:flex;flex-wrap:wrap;gap:4px;
  padding:4px 6px;
  min-height:34px;
  background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:4px;
  cursor:text;
  transition:border-color .15s;
}
.tags-wrap:focus-within{border-color:var(--vscode-focusBorder);}
.tags-wrap .tag{
  display:inline-flex;align-items:center;gap:3px;
  padding:2px 8px;
  border-radius:12px;
  font-size:11px;
  background:var(--vscode-badge-background,var(--vscode-focusBorder));
  color:var(--vscode-badge-foreground,#fff);
}
.tags-wrap .tag .tag-remove{
  cursor:pointer;font-size:13px;line-height:1;opacity:.8;
}
.tags-wrap .tag .tag-remove:hover{opacity:1;}
.tags-wrap input{
  border:none;outline:none;
  background:transparent;
  color:var(--vscode-editor-foreground);
  font-size:12px;
  flex:1;min-width:80px;
  padding:2px 4px;
}

/* ===== Buttons ===== */
.btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:7px 16px;
  border:none;border-radius:4px;
  font-size:13px;font-family:inherit;
  cursor:pointer;
  transition:opacity .15s,filter .15s;
  font-weight:500;
}
.btn:hover{filter:brightness(1.1);}
.btn:active{filter:brightness(.95);}
.btn:disabled{opacity:.45;cursor:not-allowed;filter:none;}
.btn-primary{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
}
.btn-secondary{
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
}
.btn-ghost{
  background:transparent;
  color:var(--vscode-textLink-foreground);
  padding:4px 8px;
}
.btn-small{padding:4px 10px;font-size:12px;}
.btn-icon{
  background:transparent;
  color:var(--vscode-editor-foreground);
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;
  padding:4px 10px;
  font-size:12px;
  cursor:pointer;
  transition:border-color .15s,background .15s;
}
.btn-icon:hover{
  border-color:var(--vscode-focusBorder);
  background:color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent);
}

/* ===== Footer Nav ===== */
.wizard-footer{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding-top:20px;
  margin-top:8px;
  border-top:1px solid var(--vscode-panel-border);
}

/* ===== Progress Ring ===== */
.progress-ring-wrap{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  position:relative;
}
.progress-ring-wrap .ring-label{
  position:absolute;
  font-size:16px;
  font-weight:700;
}
.progress-ring{transform:rotate(-90deg);}
.progress-ring .track{
  fill:none;
  stroke:var(--vscode-panel-border);
  stroke-width:6;
}
.progress-ring .fill{
  fill:none;
  stroke-width:6;
  stroke-linecap:round;
  transition:stroke-dashoffset .6s ease, stroke .3s;
}

/* ===== AI Review Lists ===== */
.ai-list{list-style:none;padding:0;margin:8px 0;}
.ai-list li{
  padding:5px 0;
  display:flex;
  align-items:flex-start;
  gap:8px;
  font-size:12.5px;
}
.ai-list li .ai-icon{flex-shrink:0;font-size:14px;line-height:1.4;}

.status-badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:4px 12px;
  border-radius:12px;
  font-size:12px;
  font-weight:600;
}
.status-badge.ready{
  background:color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent);
  color:var(--vscode-testing-iconPassed);
}
.status-badge.needs-attention{
  background:color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent);
  color:var(--vscode-editorWarning-foreground);
}
.status-badge.critical{
  background:color-mix(in srgb, var(--vscode-testing-iconFailed) 15%, transparent);
  color:var(--vscode-testing-iconFailed);
}

/* ===== Checklist ===== */
.checklist{list-style:none;padding:0;margin:8px 0;}
.checklist li{
  padding:6px 0;
  display:flex;align-items:center;gap:8px;
  font-size:12.5px;
  border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent);
}
.checklist li:last-child{border-bottom:none;}

/* ===== Vacancy indicator ===== */
.vacancy{
  display:inline-flex;align-items:center;gap:4px;
  font-size:11px;
  color:var(--vscode-editorWarning-foreground);
  font-weight:500;
}

/* ===== Summary stat cards ===== */
.stat-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:12px;
  margin-bottom:16px;
}
.stat-card{
  padding:16px;
  border-radius:8px;
  border:1px solid var(--vscode-panel-border);
  background:var(--vscode-editor-background);
  text-align:center;
}
.stat-card .stat-icon{font-size:24px;margin-bottom:4px;}
.stat-card .stat-value{font-size:22px;font-weight:700;}
.stat-card .stat-label{font-size:11px;color:var(--vscode-descriptionForeground);}

/* ===== Dynamic list ===== */
.dynamic-item{
  position:relative;
  padding:12px;
  border:1px solid var(--vscode-panel-border);
  border-radius:6px;
  margin-bottom:8px;
  background:var(--vscode-editor-background);
}
.dynamic-item .remove-item{
  position:absolute;
  top:8px;right:8px;
  background:transparent;border:none;
  color:var(--vscode-descriptionForeground);
  cursor:pointer;font-size:16px;
  line-height:1;padding:2px 4px;
  border-radius:3px;
  transition:color .15s, background .15s;
}
.dynamic-item .remove-item:hover{
  color:var(--vscode-testing-iconFailed);
  background:color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, transparent);
}

/* ===== Inline row ===== */
.row{display:flex;gap:12px;flex-wrap:wrap;}
.row .field{flex:1;min-width:0;}
.row-3 .field{flex:1 1 30%;}

/* ===== Loading spinner ===== */
.spinner{
  display:inline-block;
  width:20px;height:20px;
  border:2px solid var(--vscode-panel-border);
  border-top-color:var(--vscode-focusBorder);
  border-radius:50%;
  animation:spin .7s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg);}}

.loading-overlay{
  display:flex;align-items:center;gap:10px;
  padding:16px;
  font-size:13px;
  color:var(--vscode-descriptionForeground);
}

/* ===== Collapsible sections ===== */
.section-header{
  display:flex;
  align-items:center;
  gap:8px;
  cursor:pointer;
  user-select:none;
  padding:4px 0;
  margin-bottom:8px;
}
.section-header .toggle-icon{
  transition:transform .2s;
  font-size:12px;
}
.section-header.collapsed .toggle-icon{
  transform:rotate(-90deg);
}
.section-body{
  overflow:hidden;
  transition:max-height .3s ease, opacity .25s ease;
  max-height:3000px;
  opacity:1;
}
.section-body.collapsed{
  max-height:0;
  opacity:0;
  margin:0;
  padding:0;
}

/* ===== Member chip ===== */
.member-chip{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 10px 4px 6px;
  border-radius:16px;
  background:var(--vscode-badge-background,var(--vscode-focusBorder));
  color:var(--vscode-badge-foreground,#fff);
  font-size:12px;
  margin:2px;
}
.member-chip .avatar{
  width:22px;height:22px;
  border-radius:50%;
  background:color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent);
  display:flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:700;
  color:var(--vscode-editor-foreground);
}
.member-chip .remove-member{
  cursor:pointer;font-size:14px;line-height:1;opacity:.8;margin-left:2px;
}
.member-chip .remove-member:hover{opacity:1;}

/* ===== Risk badge ===== */
.risk-badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 10px;border-radius:10px;
  font-size:11px;font-weight:600;text-transform:uppercase;
}
.risk-badge.low{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 15%,transparent);color:var(--vscode-testing-iconPassed);}
.risk-badge.medium{background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 15%,transparent);color:var(--vscode-editorWarning-foreground);}
.risk-badge.high{background:color-mix(in srgb,var(--vscode-testing-iconFailed) 15%,transparent);color:var(--vscode-testing-iconFailed);}

/* ===== Misc ===== */
.muted{color:var(--vscode-descriptionForeground);font-size:12px;}
.mt-4{margin-top:4px;}
.mt-8{margin-top:8px;}
.mt-12{margin-top:12px;}
.mt-16{margin-top:16px;}
.mb-8{margin-bottom:8px;}
.mb-12{margin-bottom:12px;}
.mb-16{margin-bottom:16px;}
.hidden{display:none!important;}
.gap-8{gap:8px;}
.flex-center{display:flex;align-items:center;}
.text-center{text-align:center;}
</style>
</head>
<body>
<div class="wizard-root" id="wizardRoot">
  <!-- Step indicator (rendered by JS) -->
  <div id="stepIndicator" class="step-indicator"></div>

  <!-- Step content (rendered by JS) -->
  <div id="stepContent"></div>

  <!-- Footer -->
  <div class="wizard-footer" id="wizardFooter"></div>
</div>
<div id="errorDisplay" style="display:none;padding:24px;color:red;font-family:monospace;white-space:pre-wrap;"></div>

<script nonce="${nonce}">
(function(){
  try {
  const vscodeApi = acquireVsCodeApi();

  /* ── State ── */
  let state = ${stateJson};

  const STEPS = [
    { label: 'Define Goal', icon: '🎯' },
    { label: 'Team & Roles', icon: '👥' },
    { label: 'Review & Launch', icon: '🚀' }
  ];

  const CATEGORIES = ['Software','Infrastructure','Research','Marketing','Operations','Other'];
  const PRIORITIES = ['High','Medium','Low'];
  const TIMELINES = ['1 week','2 weeks','1 month','2 months','3 months','6 months','Custom'];
  const SENIORITIES = ['Junior','Mid','Senior','Lead'];

  const ROLE_SUGGESTIONS = {
    'Software': [
      { title:'Developer', description:'Full-stack software developer', skills:['TypeScript','React','Node.js'], seniority:'Mid', count:2 },
      { title:'QA Engineer', description:'Quality assurance and testing', skills:['Testing','Automation','Selenium'], seniority:'Mid', count:1 },
      { title:'Designer', description:'UI/UX designer', skills:['Figma','UI Design','User Research'], seniority:'Mid', count:1 },
      { title:'Project Manager', description:'Project coordination and delivery', skills:['Agile','Scrum','Communication'], seniority:'Senior', count:1 }
    ],
    'Infrastructure': [
      { title:'DevOps Engineer', description:'CI/CD and infrastructure automation', skills:['Docker','Kubernetes','Terraform'], seniority:'Senior', count:2 },
      { title:'SRE', description:'Site reliability engineering', skills:['Monitoring','Linux','Python'], seniority:'Mid', count:1 }
    ],
    'Research': [
      { title:'Research Lead', description:'Lead research initiatives', skills:['Data Analysis','Research Methods'], seniority:'Senior', count:1 },
      { title:'Research Analyst', description:'Data collection and analysis', skills:['Statistics','Python','R'], seniority:'Mid', count:2 }
    ],
    'Marketing': [
      { title:'Marketing Manager', description:'Strategy and campaign management', skills:['Strategy','Analytics','SEO'], seniority:'Senior', count:1 },
      { title:'Content Creator', description:'Content production and copywriting', skills:['Writing','Social Media','Design'], seniority:'Mid', count:1 }
    ],
    'Operations': [
      { title:'Operations Manager', description:'Process optimization and delivery', skills:['Process Design','Analytics','Leadership'], seniority:'Senior', count:1 },
      { title:'Operations Analyst', description:'Data analysis and reporting', skills:['Excel','SQL','Reporting'], seniority:'Mid', count:1 }
    ],
    'Other': []
  };

  /* ── Helpers ── */
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function $(sel){ return document.querySelector(sel); }
  function $$(sel){ return Array.from(document.querySelectorAll(sel)); }

  function progressRingSvg(pct, size, strokeColor){
    size = size || 80;
    const r = (size - 12) / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ - (pct / 100) * circ;
    let color = strokeColor;
    if (!color) {
      if (pct >= 70) color = 'var(--vscode-testing-iconPassed)';
      else if (pct >= 40) color = 'var(--vscode-editorWarning-foreground)';
      else color = 'var(--vscode-testing-iconFailed)';
    }
    return '<div class="progress-ring-wrap" style="width:'+size+'px;height:'+size+'px;">'
      + '<svg class="progress-ring" width="'+size+'" height="'+size+'">'
      + '<circle class="track" cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'"/>'
      + '<circle class="fill" cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'"'
      + ' stroke="'+color+'"'
      + ' stroke-dasharray="'+circ+'"'
      + ' stroke-dashoffset="'+offset+'"/>'
      + '</svg>'
      + '<span class="ring-label">'+Math.round(pct)+'%</span>'
      + '</div>';
  }

  function checkIcon(status){
    if (status === 'pass') return '<span style="color:var(--vscode-testing-iconPassed)">✅</span>';
    if (status === 'warning') return '<span style="color:var(--vscode-editorWarning-foreground)">⚠️</span>';
    return '<span style="color:var(--vscode-testing-iconFailed)">❌</span>';
  }

  /* ── Render step indicator ── */
  function renderIndicator(){
    let html = '';
    STEPS.forEach(function(s, i){
      if (i > 0){
        const done = state.currentStep > i - 1;
        html += '<div class="step-connector'+(done?' done':'')+'"></div>';
      }
      let cls = 'step-node';
      if (i === state.currentStep) cls += ' active';
      else if (i < state.currentStep) cls += ' completed';
      const inner = i < state.currentStep ? '✓' : (i + 1);
      html += '<div class="'+cls+'">'
            + '<div class="step-circle">'+inner+'</div>'
            + '<div class="step-label">'+s.icon+' '+esc(s.label)+'</div>'
            + '</div>';
    });
    document.getElementById('stepIndicator').innerHTML = html;
  }

  /* ── Render footer ── */
  function renderFooter(){
    const step = state.currentStep;
    let left = '';
    let right = '';
    if (step > 0){
      left = '<button class="btn btn-secondary" id="btnBack">← Back</button>';
    } else {
      left = '<span></span>';
    }
    if (step < 2){
      right = '<button class="btn btn-primary" id="btnNext">Next →</button>';
    } else {
      right = '<div style="display:flex;gap:8px;">'
            + '<button class="btn btn-secondary" id="btnSaveDraft">Save as Draft</button>'
            + '<button class="btn btn-primary" id="btnCreate">🚀 Create Project</button>'
            + '</div>';
    }
    document.getElementById('wizardFooter').innerHTML = left + right;

    var back = document.getElementById('btnBack');
    if (back) back.addEventListener('click', function(){ state.currentStep--; renderAll(); });
    var next = document.getElementById('btnNext');
    if (next) next.addEventListener('click', function(){ state.currentStep++; renderAll(); });
    var draft = document.getElementById('btnSaveDraft');
    if (draft) draft.addEventListener('click', function(){
      vscodeApi.postMessage({ type:'saveDraft', state: state });
    });
    var create = document.getElementById('btnCreate');
    if (create) create.addEventListener('click', function(){
      vscodeApi.postMessage({ type:'createProject', state: state });
    });
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  STEP 0 – Define Goal                                            */
  /* ────────────────────────────────────────────────────────────────── */
  function renderStep0(){
    return renderSection0a()
         + renderSection0b()
         + renderSection0c()
         + renderSection0d();
  }

  /* 0a – Project Overview */
  function renderSection0a(){
    const p = state.project;
    let catOpts = '<option value="">Select category…</option>';
    CATEGORIES.forEach(function(c){ catOpts += '<option value="'+esc(c)+'"'+(p.category===c?' selected':'')+'>'+esc(c)+'</option>'; });

    let tlOpts = '<option value="">Select timeline…</option>';
    TIMELINES.forEach(function(t){ tlOpts += '<option value="'+esc(t)+'"'+(p.timeline===t?' selected':'')+'>'+esc(t)+'</option>'; });

    let priorityChips = '';
    PRIORITIES.forEach(function(pr){
      priorityChips += '<span class="chip'+(p.priority===pr?' selected':'')+'" data-priority="'+esc(pr)+'">'+esc(pr)+'</span>';
    });

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">📋</span> Project Overview</div>'
      + '<div class="field"><label>Project Name <span style="color:var(--vscode-testing-iconFailed)">*</span></label>'
      + '<input type="text" id="projName" value="'+esc(p.name)+'" placeholder="Enter project name…"/></div>'
      + '<div class="field"><label>Description</label>'
      + '<textarea id="projDesc" rows="4" placeholder="Describe the project goals, scope, and expected outcomes…">'+esc(p.description)+'</textarea></div>'
      + '<div class="row">'
      + '<div class="field"><label>Category</label><select id="projCategory">'+catOpts+'</select></div>'
      + '<div class="field"><label>Target Timeline</label><select id="projTimeline">'+tlOpts+'</select></div>'
      + '</div>'
      + '<div class="field"><label>Priority</label><div class="chips" id="priorityChips">'+priorityChips+'</div></div>'
      + '</div>';
  }

  /* 0b – Objectives & Success Criteria */
  function renderSection0b(){
    let objItems = '';
    state.objectives.forEach(function(o, i){
      objItems += '<div class="dynamic-item">'
        + '<button class="remove-item" data-action="removeObjective" data-index="'+i+'" title="Remove">✕</button>'
        + '<div class="field"><label>Title</label><input type="text" data-field="objTitle" data-index="'+i+'" value="'+esc(o.title)+'" placeholder="Objective title…"/></div>'
        + '<div class="field"><label>Description</label><textarea data-field="objDesc" data-index="'+i+'" rows="2" placeholder="Describe this objective…">'+esc(o.description)+'</textarea></div>'
        + '</div>';
    });

    let critItems = '';
    state.successCriteria.forEach(function(c, i){
      critItems += '<div class="dynamic-item">'
        + '<button class="remove-item" data-action="removeCriteria" data-index="'+i+'" title="Remove">✕</button>'
        + '<div class="row row-3">'
        + '<div class="field"><label>Metric</label><input type="text" data-field="critMetric" data-index="'+i+'" value="'+esc(c.metric)+'" placeholder="e.g. Response time"/></div>'
        + '<div class="field"><label>Target</label><input type="text" data-field="critTarget" data-index="'+i+'" value="'+esc(c.target)+'" placeholder="e.g. < 200ms"/></div>'
        + '<div class="field"><label>Measurement</label><input type="text" data-field="critMethod" data-index="'+i+'" value="'+esc(c.method)+'" placeholder="e.g. APM monitoring"/></div>'
        + '</div></div>';
    });

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">🎯</span> Objectives & Success Criteria</div>'
      + '<div class="section-header" data-toggle="objectives"><span class="toggle-icon">▼</span> <strong>Objectives</strong></div>'
      + '<div class="section-body" id="sec-objectives">'
      + objItems
      + '<button class="btn-icon" id="addObjective">➕ Add Objective</button>'
      + '</div>'
      + '<div class="section-header mt-16" data-toggle="criteria"><span class="toggle-icon">▼</span> <strong>Success Criteria</strong></div>'
      + '<div class="section-body" id="sec-criteria">'
      + critItems
      + '<button class="btn-icon" id="addCriteria">➕ Add Criteria</button>'
      + '</div>'
      + '</div>';
  }

  /* 0c – Requirements */
  function renderSection0c(){
    function listHtml(arr, fieldPrefix, label){
      let items = '';
      arr.forEach(function(val, i){
        items += '<div class="dynamic-item" style="padding:8px 12px;">'
          + '<button class="remove-item" data-action="remove'+fieldPrefix+'" data-index="'+i+'" title="Remove" style="top:5px;right:5px;">✕</button>'
          + '<input type="text" data-field="'+fieldPrefix+'" data-index="'+i+'" value="'+esc(val)+'" placeholder="Enter '+label.toLowerCase()+'…" style="padding-right:28px;"/>'
          + '</div>';
      });
      return '<div class="section-header" data-toggle="'+fieldPrefix+'"><span class="toggle-icon">▼</span> <strong>'+esc(label)+'</strong></div>'
        + '<div class="section-body" id="sec-'+fieldPrefix+'">'
        + items
        + '<button class="btn-icon" data-add="'+fieldPrefix+'">➕ Add</button>'
        + '</div>';
    }

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">📝</span> Requirements</div>'
      + listHtml(state.technicalRequirements, 'techReq', 'Technical Requirements')
      + '<div class="mt-12"></div>'
      + listHtml(state.businessRequirements, 'bizReq', 'Business Requirements')
      + '<div class="mt-12"></div>'
      + listHtml(state.constraints, 'constraint', 'Constraints / Limitations')
      + '</div>';
  }

  /* 0d – AI Review */
  function renderSection0d(){
    const rev = state.aiReviews.requirements;
    let body = '';
    if (rev === undefined) {
      body = '<p class="muted">Click the button above to analyze your requirements with AI.</p>';
    } else if (rev === '__loading__') {
      body = '<div class="loading-overlay"><span class="spinner"></span> Analyzing requirements…</div>';
    } else {
      body = renderAiResult(rev, 'requirements');
    }

    return '<div class="card ai-card">'
      + '<div class="card-title"><span class="icon">✨</span> AI Requirements Review</div>'
      + '<div style="margin-bottom:12px;">'
      + '<button class="btn btn-primary btn-small" id="btnAiReq" '+(rev === '__loading__' ? 'disabled' : '')+'>⚡ Analyze Requirements</button>'
      + '</div>'
      + '<div id="aiReqResult">'+body+'</div>'
      + '</div>';
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  STEP 1 – Team & Roles                                           */
  /* ────────────────────────────────────────────────────────────────── */
  function renderStep1(){
    return renderSection1a() + renderSection1b() + renderSection1c();
  }

  /* 1a – Role Definition */
  function renderSection1a(){
    let roleCards = '';
    state.roles.forEach(function(r, i){
      let skillTags = '';
      r.skills.forEach(function(sk, si){
        skillTags += '<span class="tag">'+esc(sk)+' <span class="tag-remove" data-action="removeSkill" data-role="'+i+'" data-skill="'+si+'">✕</span></span>';
      });

      let senOpts = '';
      SENIORITIES.forEach(function(s){ senOpts += '<option value="'+esc(s)+'"'+(r.seniority===s?' selected':'')+'>'+esc(s)+'</option>'; });

      roleCards += '<div class="dynamic-item">'
        + '<button class="remove-item" data-action="removeRole" data-index="'+i+'" title="Remove role">✕</button>'
        + '<div class="row">'
        + '<div class="field" style="flex:2;"><label>Role Title</label><input type="text" data-field="roleTitle" data-index="'+i+'" value="'+esc(r.title)+'" placeholder="e.g. Developer"/></div>'
        + '<div class="field" style="flex:1;"><label>Seniority</label><select data-field="roleSeniority" data-index="'+i+'">'+senOpts+'</select></div>'
        + '<div class="field" style="flex:0 0 80px;"><label>Count</label><input type="number" data-field="roleCount" data-index="'+i+'" value="'+r.count+'" min="1" max="50"/></div>'
        + '</div>'
        + '<div class="field"><label>Description</label><input type="text" data-field="roleDesc" data-index="'+i+'" value="'+esc(r.description)+'" placeholder="Brief role description…"/></div>'
        + '<div class="field"><label>Required Skills</label>'
        + '<div class="tags-wrap" data-tags-role="'+i+'">'
        + skillTags
        + '<input type="text" data-field="skillInput" data-index="'+i+'" placeholder="Type & press Enter…"/>'
        + '</div></div>'
        + '</div>';
    });

    const cat = state.project.category;
    const hasSuggestions = cat && ROLE_SUGGESTIONS[cat] && ROLE_SUGGESTIONS[cat].length > 0 && state.roles.length === 0;

    let suggestBtn = '';
    if (hasSuggestions) {
      suggestBtn = '<button class="btn btn-secondary btn-small mt-8" id="btnSuggestRoles">💡 Suggest roles for '+esc(cat)+' project</button>';
    }

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">🛡️</span> Role Definition</div>'
      + roleCards
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
      + '<button class="btn-icon" id="addRole">➕ Add Role</button>'
      + suggestBtn
      + '</div>'
      + '</div>';
  }

  /* 1b – Team Assembly */
  function renderSection1b(){
    let cards = '';
    if (state.roles.length === 0) {
      cards = '<p class="muted">Define roles above first, then assign team members here.</p>';
    } else {
      state.roles.forEach(function(r, ri){
        const members = state.teamMembers.filter(function(m){ return m.role === r.title; });
        let memberChips = '';
        members.forEach(function(m){
          const initials = m.name.split(' ').map(function(w){return w[0]||'';}).join('').toUpperCase().slice(0,2);
          const mi = state.teamMembers.indexOf(m);
          memberChips += '<span class="member-chip">'
            + '<span class="avatar">'+esc(initials)+'</span>'
            + esc(m.name)+' ('+m.availability+'%)'
            + ' <span class="remove-member" data-action="removeMember" data-index="'+mi+'">✕</span>'
            + '</span>';
        });
        const unfilled = r.count - members.length;
        let vacancyHtml = '';
        if (unfilled > 0) {
          vacancyHtml = '<span class="vacancy mt-4">⚠️ '+unfilled+' position'+(unfilled>1?'s':'')+' unfilled</span>';
        }

        cards += '<div class="dynamic-item">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
          + '<div><strong>'+esc(r.title)+'</strong> <span class="muted">· '+esc(r.seniority)+' · Need '+r.count+'</span></div>'
          + '</div>'
          + '<div class="muted mb-8">'+esc(r.description)+'</div>'
          + (memberChips ? '<div class="mb-8" style="display:flex;flex-wrap:wrap;gap:4px;">'+memberChips+'</div>' : '')
          + vacancyHtml
          + '<div class="assign-form hidden" id="assignForm-'+ri+'">'
          + '<div class="row mt-8">'
          + '<div class="field"><label>Name</label><input type="text" data-field="memberName" data-role-index="'+ri+'" placeholder="Full name"/></div>'
          + '<div class="field"><label>Email</label><input type="email" data-field="memberEmail" data-role-index="'+ri+'" placeholder="email@example.com"/></div>'
          + '<div class="field" style="flex:0 0 100px;"><label>Availability %</label><input type="number" data-field="memberAvail" data-role-index="'+ri+'" value="100" min="10" max="100"/></div>'
          + '</div>'
          + '<div class="mt-4" style="display:flex;gap:6px;">'
          + '<button class="btn btn-primary btn-small" data-action="confirmMember" data-role-index="'+ri+'">Add</button>'
          + '<button class="btn btn-secondary btn-small" data-action="cancelMember" data-role-index="'+ri+'">Cancel</button>'
          + '</div></div>'
          + '<button class="btn-icon btn-small mt-8" data-action="showAssign" data-role-index="'+ri+'">👤 Assign Member</button>'
          + '</div>';
      });
    }

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">👥</span> Team Assembly</div>'
      + cards
      + '</div>';
  }

  /* 1c – AI Team Analysis */
  function renderSection1c(){
    const rev = state.aiReviews.team;
    let body = '';
    if (rev === undefined) {
      body = '<p class="muted">Click the button above to analyze your team composition.</p>';
    } else if (rev === '__loading__') {
      body = '<div class="loading-overlay"><span class="spinner"></span> Analyzing team composition…</div>';
    } else {
      body = renderAiResult(rev, 'team');
    }

    return '<div class="card ai-card">'
      + '<div class="card-title"><span class="icon">✨</span> AI Team Analysis</div>'
      + '<div style="margin-bottom:12px;">'
      + '<button class="btn btn-primary btn-small" id="btnAiTeam" '+(rev === '__loading__' ? 'disabled' : '')+'>⚡ Analyze Team Composition</button>'
      + '</div>'
      + '<div id="aiTeamResult">'+body+'</div>'
      + '</div>';
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  STEP 2 – Review & Launch                                        */
  /* ────────────────────────────────────────────────────────────────── */
  function renderStep2(){
    return renderSection2a() + renderSection2b() + renderSection2c();
  }

  /* 2a – Summary */
  function renderSection2a(){
    const objCount = state.objectives.filter(function(o){return o.title.trim();}).length;
    const reqCount = state.technicalRequirements.filter(function(r){return r.trim();}).length
                   + state.businessRequirements.filter(function(r){return r.trim();}).length;
    const memberCount = state.teamMembers.length;
    const roleCount = state.roles.length;

    let rolesBreakdown = '';
    state.roles.forEach(function(r){
      const filled = state.teamMembers.filter(function(m){return m.role === r.title;}).length;
      rolesBreakdown += '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 40%,transparent);font-size:12px;">'
        + '<span>'+esc(r.title)+'</span>'
        + '<span>'+filled+' / '+r.count+'</span>'
        + '</div>';
    });

    return '<div class="card">'
      + '<div class="card-title"><span class="icon">📊</span> Project Summary</div>'
      + '<div class="stat-grid">'
      + '<div class="stat-card"><div class="stat-icon">📋</div><div class="stat-value">'+esc(state.project.name || '—')+'</div><div class="stat-label">Project Name</div></div>'
      + '<div class="stat-card"><div class="stat-icon">🎯</div><div class="stat-value">'+objCount+'</div><div class="stat-label">Objectives</div></div>'
      + '<div class="stat-card"><div class="stat-icon">📝</div><div class="stat-value">'+reqCount+'</div><div class="stat-label">Requirements</div></div>'
      + '<div class="stat-card"><div class="stat-icon">👥</div><div class="stat-value">'+memberCount+'</div><div class="stat-label">Team Members ('+roleCount+' roles)</div></div>'
      + '</div>'
      + '<div class="row">'
      + '<div class="field"><strong>Category:</strong> '+esc(state.project.category || '—')+'</div>'
      + '<div class="field"><strong>Priority:</strong> '+esc(state.project.priority || '—')+'</div>'
      + '<div class="field"><strong>Timeline:</strong> '+esc(state.project.timeline || '—')+'</div>'
      + '</div>'
      + (state.project.description ? '<div class="field mt-8"><strong>Description:</strong><div class="muted mt-4">'+esc(state.project.description)+'</div></div>' : '')
      + (rolesBreakdown ? '<div class="mt-12"><strong>Team Breakdown:</strong><div class="mt-4">'+rolesBreakdown+'</div></div>' : '')
      + '</div>';
  }

  /* 2b – AI Final Review */
  function renderSection2b(){
    const rev = state.aiReviews.final;
    let body = '';
    if (rev === undefined) {
      body = '<p class="muted">Click the button to run a comprehensive final review.</p>';
    } else if (rev === '__loading__') {
      body = '<div class="loading-overlay"><span class="spinner"></span> Running final review…</div>';
    } else {
      /* Large progress ring + checklist */
      let checklistHtml = '';
      if (rev.checklist) {
        checklistHtml = '<ul class="checklist">';
        rev.checklist.forEach(function(c){
          checklistHtml += '<li>'+checkIcon(c.status)+' '+esc(c.label)+'</li>';
        });
        checklistHtml += '</ul>';
      }
      let riskHtml = '';
      if (rev.riskLevel) {
        riskHtml = '<div class="mt-12"><strong>Risk Level:</strong> <span class="risk-badge '+rev.riskLevel+'">'+rev.riskLevel.toUpperCase()+'</span></div>';
      }
      body = '<div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">'
        + '<div class="text-center">'
        + progressRingSvg(rev.score, 100)
        + '<div class="mt-8"><span class="status-badge '+rev.status+'">'+(rev.status === 'ready' ? '✅ Ready to Launch' : rev.status === 'needs-attention' ? '⚠️ Needs Attention' : '❌ Critical Issues')+'</span></div>'
        + riskHtml
        + '</div>'
        + '<div style="flex:1;min-width:250px;">'
        + '<strong>Launch Checklist</strong>'
        + checklistHtml
        + renderAiLists(rev)
        + '</div></div>';
    }

    return '<div class="card ai-card">'
      + '<div class="card-title"><span class="icon">✨</span> AI Final Review</div>'
      + '<div style="margin-bottom:12px;">'
      + '<button class="btn btn-primary btn-small" id="btnAiFinal" '+(rev === '__loading__' ? 'disabled' : '')+'>⚡ Run Final Review</button>'
      + '</div>'
      + '<div id="aiFinalResult">'+body+'</div>'
      + '</div>';
  }

  /* 2c – Launch Controls (handled in footer) */
  function renderSection2c(){
    return '<div class="card">'
      + '<div class="card-title"><span class="icon">🚀</span> Launch Controls</div>'
      + '<p class="muted mb-12">When you\'re ready, save your project as a draft or create it immediately.</p>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
      + '<button class="btn btn-secondary" id="btnSaveDraft2">📄 Save as Draft</button>'
      + '<button class="btn btn-primary" id="btnCreate2">🚀 Create Project</button>'
      + '</div></div>';
  }

  /* ── Shared AI result renderer ── */
  function renderAiResult(rev, type){
    let html = '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">'
      + '<div class="text-center">'
      + progressRingSvg(rev.score, 80)
      + '<div class="mt-8"><span class="status-badge '+rev.status+'">'
      + (rev.status==='ready'?'✅ Ready':'⚠️ Needs Attention')
      + '</span></div></div>'
      + '<div style="flex:1;min-width:220px;">'
      + renderAiLists(rev)
      + '</div></div>';
    if (rev.riskLevel) {
      html += '<div class="mt-12"><strong>Risk Level:</strong> <span class="risk-badge '+rev.riskLevel+'">'+rev.riskLevel.toUpperCase()+'</span></div>';
    }
    return html;
  }

  function renderAiLists(rev){
    let html = '';
    if (rev.gaps && rev.gaps.length) {
      html += '<div class="mt-8"><strong>⚠️ Identified Gaps</strong><ul class="ai-list">';
      rev.gaps.forEach(function(g){ html += '<li><span class="ai-icon">⚠️</span> '+esc(g)+'</li>'; });
      html += '</ul></div>';
    }
    if (rev.suggestions && rev.suggestions.length) {
      html += '<div class="mt-8"><strong>💡 Suggestions</strong><ul class="ai-list">';
      rev.suggestions.forEach(function(s){ html += '<li><span class="ai-icon">💡</span> '+esc(s)+'</li>'; });
      html += '</ul></div>';
    }
    if (rev.questions && rev.questions.length) {
      html += '<div class="mt-8"><strong>❓ Questions to Consider</strong><ul class="ai-list">';
      rev.questions.forEach(function(q, i){ html += '<li><span class="ai-icon">❓</span> '+(i+1)+'. '+esc(q)+'</li>'; });
      html += '</ul></div>';
    }
    return html;
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  Full render                                                     */
  /* ────────────────────────────────────────────────────────────────── */
  function renderAll(){
    renderIndicator();
    const el = document.getElementById('stepContent');
    if (state.currentStep === 0) el.innerHTML = renderStep0();
    else if (state.currentStep === 1) el.innerHTML = renderStep1();
    else el.innerHTML = renderStep2();
    renderFooter();
    bindEvents();
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  Event binding                                                   */
  /* ────────────────────────────────────────────────────────────────── */
  function bindEvents(){
    /* ── Step 0 fields ── */
    bindInput('#projName', function(v){ state.project.name = v; });
    bindTextarea('#projDesc', function(v){ state.project.description = v; });
    bindSelect('#projCategory', function(v){ state.project.category = v; });
    bindSelect('#projTimeline', function(v){ state.project.timeline = v; });

    /* Priority chips */
    $$('[data-priority]').forEach(function(el){
      el.addEventListener('click', function(){
        state.project.priority = el.dataset.priority;
        $$('[data-priority]').forEach(function(c){ c.classList.toggle('selected', c.dataset.priority === state.project.priority); });
      });
    });

    /* Collapsible sections */
    $$('.section-header[data-toggle]').forEach(function(hdr){
      hdr.addEventListener('click', function(){
        const id = 'sec-' + hdr.dataset.toggle;
        const body = document.getElementById(id);
        if (body){
          const collapsed = !body.classList.contains('collapsed');
          body.classList.toggle('collapsed', collapsed);
          hdr.classList.toggle('collapsed', collapsed);
        }
      });
    });

    /* Objectives */
    bindDynamic('objTitle', function(i, v){ state.objectives[i].title = v; });
    bindDynamicTextarea('objDesc', function(i, v){ state.objectives[i].description = v; });
    bindBtn('#addObjective', function(){ state.objectives.push({title:'',description:''}); renderAll(); });

    $$('[data-action="removeObjective"]').forEach(function(b){
      b.addEventListener('click', function(){
        state.objectives.splice(Number(b.dataset.index), 1);
        if (state.objectives.length === 0) state.objectives.push({title:'',description:''});
        renderAll();
      });
    });

    /* Success criteria */
    bindDynamic('critMetric', function(i, v){ state.successCriteria[i].metric = v; });
    bindDynamic('critTarget', function(i, v){ state.successCriteria[i].target = v; });
    bindDynamic('critMethod', function(i, v){ state.successCriteria[i].method = v; });
    bindBtn('#addCriteria', function(){ state.successCriteria.push({metric:'',target:'',method:''}); renderAll(); });

    $$('[data-action="removeCriteria"]').forEach(function(b){
      b.addEventListener('click', function(){
        state.successCriteria.splice(Number(b.dataset.index), 1);
        if (state.successCriteria.length === 0) state.successCriteria.push({metric:'',target:'',method:''});
        renderAll();
      });
    });

    /* Requirements lists */
    function bindReqList(prefix, arr, setter){
      $$('[data-field="'+prefix+'"]').forEach(function(el){
        el.addEventListener('input', function(){ arr[Number(el.dataset.index)] = el.value; });
      });
      $$('[data-action="remove'+prefix+'"]').forEach(function(b){
        b.addEventListener('click', function(){
          arr.splice(Number(b.dataset.index), 1);
          if (arr.length === 0) arr.push('');
          renderAll();
        });
      });
      $$('[data-add="'+prefix+'"]').forEach(function(b){
        b.addEventListener('click', function(){ arr.push(''); renderAll(); });
      });
    }
    bindReqList('techReq', state.technicalRequirements);
    bindReqList('bizReq', state.businessRequirements);
    bindReqList('constraint', state.constraints);

    /* AI Requirements review */
    bindBtn('#btnAiReq', function(){
      state.aiReviews.requirements = '__loading__';
      renderAll();
      setTimeout(function(){
        vscodeApi.postMessage({ type:'aiReview', reviewType:'requirements', state: state });
      }, 100);
    });

    /* ── Step 1 fields ── */
    /* Roles */
    bindDynamic('roleTitle', function(i, v){ state.roles[i].title = v; });
    bindDynamic('roleDesc', function(i, v){ state.roles[i].description = v; });
    bindDynamicSelect('roleSeniority', function(i, v){ state.roles[i].seniority = v; });
    $$('[data-field="roleCount"]').forEach(function(el){
      el.addEventListener('input', function(){ state.roles[Number(el.dataset.index)].count = Math.max(1, Number(el.value) || 1); });
    });
    bindBtn('#addRole', function(){
      state.roles.push({title:'',description:'',skills:[],seniority:'Mid',count:1});
      renderAll();
    });
    $$('[data-action="removeRole"]').forEach(function(b){
      b.addEventListener('click', function(){
        const idx = Number(b.dataset.index);
        const roleTitle = state.roles[idx].title;
        state.roles.splice(idx, 1);
        state.teamMembers = state.teamMembers.filter(function(m){ return m.role !== roleTitle; });
        renderAll();
      });
    });

    /* Skill tag input */
    $$('[data-field="skillInput"]').forEach(function(inp){
      inp.addEventListener('keydown', function(e){
        if (e.key === 'Enter' && inp.value.trim()){
          e.preventDefault();
          const ri = Number(inp.dataset.index);
          state.roles[ri].skills.push(inp.value.trim());
          inp.value = '';
          renderAll();
        }
      });
    });
    $$('[data-action="removeSkill"]').forEach(function(b){
      b.addEventListener('click', function(){
        const ri = Number(b.dataset.role);
        const si = Number(b.dataset.skill);
        state.roles[ri].skills.splice(si, 1);
        renderAll();
      });
    });

    /* Suggest roles */
    bindBtn('#btnSuggestRoles', function(){
      const cat = state.project.category || 'Other';
      const suggestions = ROLE_SUGGESTIONS[cat] || [];
      suggestions.forEach(function(s){
        state.roles.push({ title:s.title, description:s.description, skills:s.skills.slice(), seniority:s.seniority, count:s.count });
      });
      renderAll();
    });

    /* Team member assignment */
    $$('[data-action="showAssign"]').forEach(function(b){
      b.addEventListener('click', function(){
        const form = document.getElementById('assignForm-'+b.dataset.roleIndex);
        if (form) form.classList.remove('hidden');
        b.classList.add('hidden');
      });
    });
    $$('[data-action="cancelMember"]').forEach(function(b){
      b.addEventListener('click', function(){
        const form = document.getElementById('assignForm-'+b.dataset.roleIndex);
        if (form) form.classList.add('hidden');
        const showBtn = document.querySelector('[data-action="showAssign"][data-role-index="'+b.dataset.roleIndex+'"]');
        if (showBtn) showBtn.classList.remove('hidden');
      });
    });
    $$('[data-action="confirmMember"]').forEach(function(b){
      b.addEventListener('click', function(){
        const ri = Number(b.dataset.roleIndex);
        const role = state.roles[ri];
        const nameEl = document.querySelector('[data-field="memberName"][data-role-index="'+ri+'"]');
        const emailEl = document.querySelector('[data-field="memberEmail"][data-role-index="'+ri+'"]');
        const availEl = document.querySelector('[data-field="memberAvail"][data-role-index="'+ri+'"]');
        const name = nameEl ? nameEl.value.trim() : '';
        const email = emailEl ? emailEl.value.trim() : '';
        const avail = availEl ? Number(availEl.value) || 100 : 100;
        if (!name) return;
        state.teamMembers.push({ name:name, email:email, role:role.title, availability:avail });
        renderAll();
      });
    });
    $$('[data-action="removeMember"]').forEach(function(b){
      b.addEventListener('click', function(){
        state.teamMembers.splice(Number(b.dataset.index), 1);
        renderAll();
      });
    });

    /* AI Team review */
    bindBtn('#btnAiTeam', function(){
      state.aiReviews.team = '__loading__';
      renderAll();
      setTimeout(function(){
        vscodeApi.postMessage({ type:'aiReview', reviewType:'team', state: state });
      }, 100);
    });

    /* ── Step 2 fields ── */
    bindBtn('#btnAiFinal', function(){
      state.aiReviews.final = '__loading__';
      renderAll();
      setTimeout(function(){
        vscodeApi.postMessage({ type:'aiReview', reviewType:'final', state: state });
      }, 100);
    });

    /* Launch controls (duplicated in step 2c) */
    bindBtn('#btnSaveDraft2', function(){
      vscodeApi.postMessage({ type:'saveDraft', state: state });
    });
    bindBtn('#btnCreate2', function(){
      vscodeApi.postMessage({ type:'createProject', state: state });
    });
  }

  /* ── Binding helpers ── */
  function bindInput(sel, fn){
    var el = $(sel);
    if (el) el.addEventListener('input', function(){ fn(el.value); });
  }
  function bindTextarea(sel, fn){
    var el = $(sel);
    if (el) el.addEventListener('input', function(){ fn(el.value); });
  }
  function bindSelect(sel, fn){
    var el = $(sel);
    if (el) el.addEventListener('change', function(){ fn(el.value); });
  }
  function bindBtn(sel, fn){
    var el = $(sel);
    if (el) el.addEventListener('click', fn);
  }
  function bindDynamic(field, fn){
    $$('[data-field="'+field+'"]').forEach(function(el){
      el.addEventListener('input', function(){ fn(Number(el.dataset.index), el.value); });
    });
  }
  function bindDynamicTextarea(field, fn){
    $$('[data-field="'+field+'"]').forEach(function(el){
      el.addEventListener('input', function(){ fn(Number(el.dataset.index), el.value); });
    });
  }
  function bindDynamicSelect(field, fn){
    $$('[data-field="'+field+'"]').forEach(function(el){
      el.addEventListener('change', function(){ fn(Number(el.dataset.index), el.value); });
    });
  }

  /* ── Messages from extension ── */
  window.addEventListener('message', function(event){
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'aiReviewResult'){
      const rt = msg.reviewType;
      if (rt === 'requirements') state.aiReviews.requirements = msg.result;
      else if (rt === 'team') state.aiReviews.team = msg.result;
      else state.aiReviews.final = msg.result;
      renderAll();
    }
    if (msg.type === 'stateUpdate' && msg.state){
      state = msg.state;
      renderAll();
    }
  });

  /* ── Initial render ── */
  renderAll();
  } catch(e) {
    var errEl = document.getElementById('errorDisplay');
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Wizard JS Error: ' + e.message + '\\n\\nStack: ' + e.stack; }
    var root = document.getElementById('wizardRoot');
    if (root) { root.style.display = 'none'; }
  }
})();
</script>
</body>
</html>`;
  }
}
