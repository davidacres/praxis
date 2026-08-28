import * as vscode from 'vscode';
import type { IssueTrackerService } from '@praxis/core';
import type { AiSessionManager } from '@praxis/core';
import { discoverWorkspaceAgentWorkflows } from '@praxis/core';
import type { AgentWorkflowReference, FeatureSubTaskRecord } from '@praxis/core';
import type {
  AiProvider,
  BackendMode,
  Board,
  CreateIssueInput,
  IssueDetails,
  IssueSummary,
  Project,
  SubTaskSummary,
  WorkflowTransition
} from '@praxis/core';
import {
  formatParentReference,
  getParentRule,
  getResolvedParentLabel,
  type ParentRule
} from '@praxis/core';
import { renderIconButton } from './webviewToolbarIcons';
import { markdownToHtmlSafe, MARKDOWN_BODY_CSS } from '@praxis/core';

/** Editor tab title used while the pane holds an unsaved new issue. */
const DRAFT_PANEL_TITLE = 'New Issue';

/**
 * Joins a parent's key and summary in its datalist suggestion text. Chromium's
 * datalist only shows an option's `value` (not its label/text), so the summary
 * is folded into the value itself and split back out client-side once picked.
 */
const PARENT_OPTION_SEPARATOR = '—';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pillToken(label: string | undefined): string {
  const normalized = label?.trim().toLowerCase();
  switch (normalized) {
    case 'epic':
      return 'epic';
    case 'feature':
      return 'feature';
    case 'idea':
      return 'idea';
    case 'story':
      return 'story';
    case 'subtask':
    case 'sub-task':
      return 'task';
    case 'task':
      return 'task';
    case 'bug':
      return 'bug';
    case 'done':
    case 'closed':
    case 'resolved':
      return 'done';
    case 'in progress':
      return 'progress';
    case 'blocked':
      return 'blocked';
    case 'backlog':
    case 'to do':
      return 'todo';
    default:
      return 'neutral';
  }
}

function renderPill(label: string | undefined): string {
  const value = label?.trim();
  if (!value) {
    return '';
  }

  return `<span class="pill pill--${pillToken(value)}">${escapeHtml(value)}</span>`;
}

function formatDate(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '—';
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed);
}

function renderSelectOptions(current: string | undefined, defaults: string[]): string {
  const values = [current?.trim(), ...defaults]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .filter((value, index, array) => array.findIndex(candidate => candidate === value) === index);

  return values
    .map(
      value =>
        `<option value="${escapeHtml(value)}" ${value === (current?.trim() || '') ? 'selected' : ''}>${escapeHtml(value)}</option>`
    )
    .join('');
}

interface DetailAiAssignOption {
  provider: AiProvider;
  label: string;
}

export class IssueDetailPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private panelIssueKey?: string;
  private activeIssueKey?: string;
  private details?: IssueDetails;
  private transitions: WorkflowTransition[] = [];
  private parentItems: IssueSummary[] = [];
  private availableWorkflows: AgentWorkflowReference[] = [];
  private subTasks: SubTaskSummary[] = [];
  private featureSubTaskRecords: FeatureSubTaskRecord[] = [];
  private parentItemsError?: string;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private aiAssignOptions: DetailAiAssignOption[] = [];
  private knownModels?: Array<{ id: string; label: string }>;
  /**
   * Draft mode: the panel renders the same Details form for an issue that does
   * not exist yet, and Save creates it instead of updating. Everything that
   * needs a real backend key (status transitions, comments, AI session,
   * sub-tasks, linked items) is suppressed while this is true.
   */
  private draftMode = false;
  private draftProjects: Project[] = [];
  private draftDefaults?: Partial<CreateIssueInput>;
  /**
   * Mode of the service owning the board a draft will create into. In
   * multi-connection setups that may differ from the router's active service,
   * and the parent rules rendered into the form must follow the TARGET board
   * (e.g. Feature-required live folder vs Epic-optional Jira).
   */
  private draftServiceMode?: BackendMode;

  private commentPlaceholder = 'Write a comment (mention @copilot for a reply)';

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly aiSessionManager: AiSessionManager,
    private readonly onAfterTransition: () => Promise<void>,
    /**
     * Resolves the service owning a board, for multi-connection setups where the
     * board being created into may not belong to the router's active connection.
     * Omitted (tests, single-connection callers) means "use the default service".
     */
    private readonly resolveServiceForBoardId?: (
      boardId: string
    ) => Promise<IssueTrackerService | undefined>
  ) {
    this.disposables.push(
      this.aiSessionManager.onDidChangeWorkflowAssignment(({ issueKey }) => {
        if (this.activeIssueKey === issueKey && this.panel) {
          void this.refreshIfShowing(issueKey);
        }
      })
    );
  }

  public setCommentPlaceholder(text: string): void {
    this.commentPlaceholder = text;
  }

  public setAiAssignOptions(options: DetailAiAssignOption[]): void {
    this.aiAssignOptions = [...options];
  }

  /**
   * Override the model list shown in the model picker. Used to surface the live
   * Copilot models discovered via VS Code's language model API instead of the
   * static fallback list.
   */
  public setKnownModels(models: Array<{ id: string; label: string }>): void {
    this.knownModels = models.length > 0 ? [...models] : undefined;
  }

  /**
   * Open the details pane for a new, unsaved issue. Mirrors `open()` but has no
   * key to fetch: project options are loaded first (the webview html must be set
   * synchronously after panel creation — see CLAUDE.md), then a placeholder
   * IssueDetails is synthesised so the normal form renderer can be reused.
   */
  public async openDraft(defaults?: Partial<CreateIssueInput>): Promise<void> {
    this.draftMode = true;
    this.draftDefaults = defaults;
    this.activeIssueKey = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.availableWorkflows = [];
    this.subTasks = [];
    this.featureSubTaskRecords = [];
    this.parentItemsError = undefined;
    this.loading = false;
    this.errorMessage = undefined;
    this.requestGeneration += 1;

    if (this.panel) {
      const old = this.panel;
      this.resetPanelState();
      this.draftMode = true;
      old.dispose(); // triggers onDidDispose → resetPanelState(), so restore after
      this.draftDefaults = defaults;
      this.draftMode = true;
    }

    const boards = await this.fetchDraftBoards();
    this.draftProjects = this.deriveProjectsFromBoards(boards);
    const projectKey = this.resolveDraftProjectKey(defaults, boards);
    this.draftServiceMode = (await this.resolveDraftService()).mode;
    this.details = this.buildDraftDetails(defaults, projectKey);
    await this.fetchDraftParentItems(projectKey, this.details.issueType);

    this.createPanelWithHtml(DRAFT_PANEL_TITLE);
  }

  /**
   * Candidate parents for the draft's initial issue type, so the "Feature"/
   * "Epic" field can offer a pick list instead of demanding an exact key the
   * user has no way to look up (reported as "Feature is required..." /
   * "Feature ... was not found." with no way to discover a valid one).
   */
  private async fetchDraftParentItems(projectKey: string, issueType: string): Promise<void> {
    this.parentItems = [];
    this.parentItemsError = undefined;
    if (!projectKey) {
      return;
    }
    try {
      const service = await this.resolveDraftService();
      if (!getParentRule(issueType, service.mode).canHaveParent) {
        return;
      }
      this.parentItems = await service.getParentItems(
        {
          projectKeys: [projectKey],
          statuses: [],
          issueTypes: [],
          searchText: '',
          assigneeMode: 'all',
          parentKey: undefined,
          grouping: 'none'
        },
        undefined,
        { childIssueType: issueType }
      );
    } catch (error) {
      this.parentItems = [];
      this.parentItemsError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The tracked boards a draft can create into.
   *
   * `getProjects()` can return projects with no tracked board (especially on
   * Jira), so the board list is the source for both the project dropdown and the
   * preselected project — and it carries the project name the dropdown shows.
   */
  private async fetchDraftBoards(): Promise<Board[]> {
    try {
      const service = await this.resolveDraftService();
      return await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    } catch {
      return [];
    }
  }

  /**
   * The project a new issue should start in.
   *
   * The caller's `projectKey` is preferred, but it is not required: a draft
   * started from a board carries that board's id, so the project is looked up
   * from the board itself when the key was not passed through (or the board
   * object the command layer saw had no key on it). Only a draft with no board
   * at all falls back to the first project in the list.
   */
  private resolveDraftProjectKey(
    defaults: Partial<CreateIssueInput> | undefined,
    boards: Board[]
  ): string {
    const explicit = defaults?.projectKey?.trim();
    if (explicit) {
      return explicit;
    }

    const boardId = defaults?.boardId?.trim();
    const fromBoard = boardId
      ? boards.find(board => board.id === boardId)?.projectKey?.trim()
      : undefined;

    return fromBoard || this.draftProjects[0]?.key || '';
  }

  /**
   * The service a draft should talk to: the one owning the board it was started
   * from, since in multi-connection setups that board may not belong to the
   * router's active connection. Falls back to the default service whenever the
   * board is unknown or its connection cannot be resolved.
   */
  private async resolveDraftService(): Promise<IssueTrackerService> {
    const boardId = this.draftDefaults?.boardId;
    if (!boardId || !this.resolveServiceForBoardId) {
      return this.backendService;
    }
    try {
      return (await this.resolveServiceForBoardId(boardId)) ?? this.backendService;
    } catch {
      return this.backendService;
    }
  }

  /** De-duplicates boards down to their distinct projects, keyed on projectKey. */
  private deriveProjectsFromBoards(boards: Board[]): Project[] {
    const projects = new Map<string, Project>();
    for (const board of boards) {
      const key = board.projectKey?.trim();
      if (!key || projects.has(key)) {
        continue;
      }
      projects.set(key, { key, name: board.projectName?.trim() || key });
    }
    return [...projects.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  private buildDraftDetails(
    defaults: Partial<CreateIssueInput> | undefined,
    projectKey: string
  ): IssueDetails {
    return {
      key: '',
      summary: defaults?.summary ?? '',
      status: 'Not created',
      issueType: defaults?.issueType?.trim() || 'Task',
      projectKey,
      // Naming the key is better than an empty Project row when the key resolved
      // but its board carried no display name.
      projectName:
        this.draftProjects.find(project => project.key === projectKey)?.name || projectKey,
      description: defaults?.description ?? '',
      ideaTranscript: defaults?.ideaTranscript ?? '',
      parentKey: defaults?.parentKey ?? '',
      priority: 'Medium',
      transitions: [],
      comments: [],
      linkedIssues: []
    };
  }

  /**
   * The Project control for a draft.
   *
   * With two or more projects this is a real choice, so it renders a dropdown.
   * With one — the normal case on the local backends, where each board defines
   * exactly one project — a dropdown would imply a choice that does not exist,
   * so the project is stated as a fact instead. With none, the same readonly row
   * carries the reason and the fix.
   *
   * Dropping the `<select>` needs no other change: `handleDraftCreate` already
   * falls back to the draft's own `projectKey` when the field is absent.
   */
  private buildDraftProjectField(d: IssueDetails): string {
    if (this.draftProjects.length > 1) {
      const options = this.draftProjects
        .map(
          project =>
            `<option value="${escapeHtml(project.key)}"${
              project.key === d.projectKey ? ' selected' : ''
            }>${escapeHtml(project.name || project.key)}</option>`
        )
        .join('');
      return `<label class="field-group" for="draftProjectSelect">
          <span class="field-label">Project</span>
          <select id="draftProjectSelect" class="field-select" required>${options}</select>
        </label>`;
    }

    const value = d.projectName || d.projectKey || '';
    const help =
      this.draftProjects.length === 0 && !d.projectKey?.trim()
        ? `<div class="field-help">${escapeHtml(
            'No projects yet. Create a board first — each board defines its own project.'
          )}</div>`
        : '';
    return `<div class="detail-row">
          <div class="detail-label">Project</div>
          <div class="detail-value detail-value--wrap">${escapeHtml(value || '—')}</div>
        </div>${help}`;
  }

  public async open(issueKey: string): Promise<void> {
    this.draftMode = false;
    this.draftDefaults = undefined;
    this.draftProjects = [];
    this.activeIssueKey = issueKey;
    this.details = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.parentItemsError = undefined;
    this.loading = false;
    this.errorMessage = undefined;

    // Dispose any existing panel first
    if (this.panel) {
      const old = this.panel;
      this.resetPanelState();
      old.dispose();
    }

    // Fetch data before creating panel
    await this.fetchData(issueKey);

    // Create panel and set html synchronously — VS Code Insiders requires
    // webview.html to be set immediately after panel creation.
    this.createPanelWithHtml(issueKey);
  }

  public async refreshIfShowing(issueKey: string): Promise<void> {
    if (this.activeIssueKey !== issueKey || !this.panel) {
      return;
    }

    await this.fetchData(issueKey);

    // Dispose and recreate to ensure html is set synchronously after creation
    const old = this.panel;
    this.resetPanelState();
    old.dispose();
    this.createPanelWithHtml(issueKey);
  }

  public clear(): void {
    this.activeIssueKey = undefined;
    this.details = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.availableWorkflows = [];
    this.subTasks = [];
    this.featureSubTaskRecords = [];
    this.parentItemsError = undefined;
    this.loading = false;
    this.errorMessage = undefined;
    this.requestGeneration += 1;
    const panel = this.panel;
    this.resetPanelState();
    panel?.dispose();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    const panel = this.panel;
    this.resetPanelState();
    panel?.dispose();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (type === 'refresh') {
      if (this.activeIssueKey) {
        await this.refreshIfShowing(this.activeIssueKey);
      }
      return;
    }

    // Draft submits must be handled before the activeIssueKey guard below:
    // a new issue has no key yet, so that guard would drop the message.
    if (this.draftMode && type === 'saveIssueEdits') {
      await this.handleDraftCreate(message);
      return;
    }

    if (!this.activeIssueKey) {
      return;
    }

    if (type === 'assignToMe') {
      await vscode.commands.executeCommand('praxis.assignToMe', this.activeIssueKey);
      return;
    }

    if (type === 'assignToAi') {
      const provider = asString(message.provider) as AiProvider | undefined;
      if (provider) {
        await vscode.commands.executeCommand('praxis.assignToAi', this.activeIssueKey, provider);
      } else {
        await vscode.commands.executeCommand('praxis.assignToAi', this.activeIssueKey);
      }
      return;
    }

    if (type === 'localPeerReview') {
      await vscode.commands.executeCommand('praxis.localPeerReview', this.activeIssueKey);
      return;
    }

    if (type === 'openAnalysisWindow') {
      await vscode.commands.executeCommand('praxis.openAnalysisWindow', this.activeIssueKey);
      return;
    }

    if (type === 'viewAiSession') {
      await vscode.commands.executeCommand('praxis.viewAgentSession', this.activeIssueKey);
      return;
    }

    if (type === 'saveIssueEdits') {
      try {
        const summary = asString(message.summary);
        if (summary === undefined) {
          return;
        }

        const description = asString(message.description) ?? '';
        const parentKey = asString(message.parentKey) ?? '';
        const assignee = asString(message.assignee) ?? '';
        const priority = asString(message.priority);
        const issueType = asString(message.issueType);
        const model = asString(message.model);
        const severity = asString(message.severity);
        const reportedBy = asString(message.reportedBy);
        const ideaTranscript = asString(message.ideaTranscript) ?? '';
        const transitionId = asString(message.transitionId) ?? undefined;
        await this.backendService.updateIssue(this.activeIssueKey, {
          summary,
          description,
          ideaTranscript,
          parentKey: parentKey.trim() || null,
          assignee: assignee.trim() || null,
          priority,
          issueType,
          model,
          severity,
          reportedBy
        });
        if (transitionId) {
          await this.backendService.transitionIssue(this.activeIssueKey, transitionId);
        }
        await this.onAfterTransition();
        await this.panel?.webview.postMessage({
          type: 'saveIssueEditsResult',
          ok: true
        });
      } catch (error) {
        await this.panel?.webview.postMessage({
          type: 'saveIssueEditsResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (type === 'setWorkflowPack') {
      try {
        const workflowInstructionsPath = asString(message.workflowInstructionsPath)?.trim() ?? '';
        if (!workflowInstructionsPath) {
          const assignment = this.aiSessionManager.setIssueWorkflowAssignment(this.activeIssueKey, undefined, {
            source: 'manual',
            reason: 'User explicitly selected "No workflow pack".'
          });
          await this.panel?.webview.postMessage({
            type: 'setWorkflowPackResult',
            ok: true,
            assignment: {
              name: 'No workflow pack',
              source: this.formatWorkflowAssignmentSource(assignment.source),
              reason: assignment.reason ?? ''
            }
          });
          return;
        }

        const workflow = this.findWorkflowChoice(this.activeIssueKey, workflowInstructionsPath);
        if (!workflow) {
          throw new Error('The selected workflow pack is no longer available. Refresh the issue details and try again.');
        }

        const assignment = this.aiSessionManager.setIssueWorkflowAssignment(this.activeIssueKey, workflow, {
          source: 'manual'
        });
        await this.panel?.webview.postMessage({
          type: 'setWorkflowPackResult',
          ok: true,
          assignment: {
            name: assignment.workflow?.name ?? 'No workflow pack',
            source: this.formatWorkflowAssignmentSource(assignment.source),
            reason: assignment.reason ?? ''
          }
        });
      } catch (error) {
        await this.panel?.webview.postMessage({
          type: 'setWorkflowPackResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (type === 'setModel') {
      try {
        const model = asString(message.model)?.trim() ?? '';
        if (model) {
          this.aiSessionManager.setIssueModelOverride(this.activeIssueKey, model);
        } else {
          this.aiSessionManager.removeIssueModelOverride(this.activeIssueKey);
        }
        await this.panel?.webview.postMessage({
          type: 'setModelResult',
          ok: true,
          model
        });
      } catch (error) {
        await this.panel?.webview.postMessage({
          type: 'setModelResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (type === 'assignSubTaskWorkflow') {
      const subTaskKey = asString(message.subTaskKey)?.trim();
      const workflowInstructionsPath = asString(message.workflowInstructionsPath)?.trim() ?? '';
      if (!subTaskKey) {
        return;
      }

      try {
        if (!workflowInstructionsPath) {
          this.aiSessionManager.setIssueWorkflowAssignment(subTaskKey, undefined, {
            source: 'manual',
            reason: 'User explicitly selected "No workflow pack" for sub-task.'
          });
        } else {
          const workflow = this.findWorkflowChoice(subTaskKey, workflowInstructionsPath);
          if (workflow) {
            this.aiSessionManager.setIssueWorkflowAssignment(subTaskKey, workflow, {
              source: 'manual'
            });
          }
        }
        await this.panel?.webview.postMessage({
          type: 'assignSubTaskWorkflowResult',
          ok: true,
          subTaskKey
        });
      } catch (error) {
        await this.panel?.webview.postMessage({
          type: 'assignSubTaskWorkflowResult',
          ok: false,
          subTaskKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (type === 'startSubTaskDelivery') {
      const subTaskKey = asString(message.subTaskKey)?.trim();
      if (!subTaskKey) {
        return;
      }
      await vscode.commands.executeCommand('praxis.startSubTaskDelivery', this.activeIssueKey, subTaskKey);
      return;
    }

    if (type !== 'addIssueComment') {
      return;
    }

    try {
      const body = asString(message.body);
      if (body === undefined) {
        return;
      }

      await this.backendService.addComment(this.activeIssueKey, body);
      await this.onAfterTransition();
      await this.panel?.webview.postMessage({
        type: 'addIssueCommentResult',
        ok: true
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'addIssueCommentResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Create the issue described by the draft form, then reopen the pane on the
   * real key so the user lands on the saved ticket.
   *
   * CreateIssueInput carries only projectKey/issueType/summary/description/
   * parentKey/ideaTranscript, but the Details form also edits assignee,
   * priority, severity, reportedBy and model. Those are applied as a follow-up
   * updateIssue call, and only when they actually carry a value — a failed
   * update must not lose the issue that was already created.
   */
  private async handleDraftCreate(message: Record<string, unknown>): Promise<void> {
    const summary = asString(message.summary)?.trim() ?? '';
    const projectKey = asString(message.projectKey)?.trim() || this.details?.projectKey?.trim() || '';
    const issueType = asString(message.issueType)?.trim() ?? '';

    const validationError = !summary
      ? 'Summary is required.'
      : !projectKey
        ? this.draftProjects.length === 0
          ? 'No project could be resolved. Open a board and use New Issue from its toolbar, or create a board if you have none.'
          : 'Select a project before creating the issue.'
        : !issueType
          ? 'Ticket type is required.'
          : undefined;
    if (validationError) {
      await this.panel?.webview.postMessage({
        type: 'saveIssueEditsResult',
        ok: false,
        error: validationError
      });
      return;
    }

    // Create and its follow-up update must share the board's own service, and
    // the same one the project list was read from.
    const boardId = this.draftDefaults?.boardId;
    const targetService = await this.resolveDraftService();

    let createdKey: string;
    try {
      // The webview has already decided whether the parent field names an
      // existing parent (parentKey) or a new feature to create inline
      // (newParentSummary, livefolder/userworkspace drafts only) — it owns the
      // datalist options needed to tell the two apart. Edit-mode saves never
      // send newParentSummary, so reparenting cannot create folders.
      const created = await targetService.createIssue({
        projectKey,
        issueType,
        summary,
        description: asString(message.description) ?? '',
        ideaTranscript: asString(message.ideaTranscript) ?? '',
        parentKey: asString(message.parentKey)?.trim() || undefined,
        newParentSummary: asString(message.newParentSummary)?.trim() || undefined,
        boardId
      });
      createdKey = created.key;
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'saveIssueEditsResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    // Fields the create API does not accept, applied only when set. Failures
    // here are surfaced but never discard the created issue.
    const assignee = asString(message.assignee)?.trim() ?? '';
    const priority = asString(message.priority)?.trim() ?? '';
    const severity = asString(message.severity)?.trim() ?? '';
    const reportedBy = asString(message.reportedBy)?.trim() ?? '';
    const model = asString(message.model)?.trim() ?? '';
    const followUp = {
      ...(assignee ? { assignee } : {}),
      ...(priority ? { priority } : {}),
      ...(severity ? { severity } : {}),
      ...(reportedBy ? { reportedBy } : {}),
      ...(model ? { model } : {})
    };
    if (Object.keys(followUp).length > 0) {
      try {
        await targetService.updateIssue(createdKey, followUp);
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Created ${createdKey}, but some fields could not be applied: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    await this.onAfterTransition();
    // Replaces the draft pane with the real issue (also clears draft state).
    await this.open(createdKey);
  }

  private async fetchData(issueKey: string): Promise<void> {
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;

    try {
      const [issue, transitions, availableWorkflows] = await Promise.all([
        this.backendService.getIssue(issueKey),
        this.backendService.getTransitions(issueKey),
        discoverWorkspaceAgentWorkflows(this.getWorkspaceRoot())
      ]);

      let parentItems: IssueSummary[] = [];
      let parentItemsError: string | undefined;
      if (getParentRule(issue.issueType, this.backendService.mode).canHaveParent && issue.projectKey) {
        try {
          parentItems = (await this.backendService.getParentItems(
            {
              projectKeys: [issue.projectKey],
              statuses: [],
              issueTypes: [],
              searchText: '',
              assigneeMode: 'all',
              parentKey: undefined,
              grouping: 'none'
            },
            undefined,
            { childIssueType: issue.issueType }
          )).filter(item => item.key !== issue.key);
        } catch (error) {
          parentItems = [];
          parentItemsError = error instanceof Error ? error.message : String(error);
        }
      }

      if (generation !== this.requestGeneration) {
        return;
      }

      // Fetch sub-tasks if the backend supports it
      let subTasks: SubTaskSummary[] = [];
      if (this.backendService.getSubTasks) {
        try {
          subTasks = await this.backendService.getSubTasks(issueKey);
        } catch {
          subTasks = [];
        }
      }

      // Get feature decomposition records from session manager
      const agentSession = this.aiSessionManager.getAgentSession(issueKey);
      const featureSubTaskRecords = agentSession?.delivery?.featureDecomposition?.subTasks ?? [];

      this.details = { ...issue, transitions, subTasks };
      this.transitions = transitions;
      this.parentItems = parentItems;
      this.availableWorkflows = availableWorkflows;
      this.subTasks = subTasks;
      this.featureSubTaskRecords = featureSubTaskRecords;
      this.parentItemsError = parentItemsError;
      this.loading = false;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.details = undefined;
      this.transitions = [];
      this.parentItems = [];
      this.availableWorkflows = [];
      this.subTasks = [];
      this.featureSubTaskRecords = [];
      this.parentItemsError = undefined;
    }
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getWorkflowChoices(issueKey: string): AgentWorkflowReference[] {
    const choices = [...this.availableWorkflows];
    const assignment = this.aiSessionManager.getIssueWorkflowAssignment(issueKey);
    if (
      assignment?.workflow &&
      !choices.some(
        workflow =>
          workflow.instructionsPath === assignment.workflow!.instructionsPath ||
          workflow.id === assignment.workflow!.id
      )
    ) {
      choices.unshift(assignment.workflow);
    }
    return choices;
  }

  private findWorkflowChoice(issueKey: string, workflowInstructionsPath: string): AgentWorkflowReference | undefined {
    return this.getWorkflowChoices(issueKey).find(
      workflow =>
        workflow.instructionsPath === workflowInstructionsPath || workflow.id === workflowInstructionsPath
    );
  }

  private formatWorkflowAssignmentSource(source: 'manual' | 'automatic' | 'analysis'): string {
    if (source === 'automatic') {
      return 'Automatic';
    }
    if (source === 'analysis') {
      return 'Analysis';
    }
    return 'Manual';
  }

  private renderWorkflowSelectOptions(issueKey: string): string {
    const assignment = this.aiSessionManager.getIssueWorkflowAssignment(issueKey);
    const selectedValue = assignment?.workflow?.instructionsPath ?? '';
    const workflowOptions = this.getWorkflowChoices(issueKey)
      .map(
        workflow => `<option value="${escapeHtml(workflow.instructionsPath)}" ${workflow.instructionsPath === selectedValue ? 'selected' : ''}>${escapeHtml(workflow.name)}</option>`
      )
      .join('');

    return `<option value="" ${selectedValue ? '' : 'selected'}>No workflow pack</option>${workflowOptions}`;
  }

  private renderWorkflowPackSection(issueKey: string): string {
    const assignment = this.aiSessionManager.getIssueWorkflowAssignment(issueKey);
    const hasWorkflowChoices = this.getWorkflowChoices(issueKey).length > 0 || Boolean(assignment);

    return `
      <section class="card">
        <h3>Workflow Pack</h3>
        <label class="field-group" for="workflowSelect">
          <span class="field-label">Workflow</span>
          <select
            id="workflowSelect"
            class="field-select"
            data-issue-key="${escapeHtml(issueKey)}"
            ${hasWorkflowChoices ? '' : 'disabled'}
          >
            ${this.renderWorkflowSelectOptions(issueKey)}
          </select>
          <div class="field-help">
            ${hasWorkflowChoices
              ? 'This workflow is used for AI agent delegation and Jira polling for this issue.'
              : 'No workflow packs were found in .github/skills for this workspace.'}
          </div>
        </label>
        <div class="detail-row${assignment ? '' : ' is-hidden'}" id="workflowSourceRow">
          <div class="detail-label">Source</div>
          <div class="detail-value" id="workflowSourceValue">${escapeHtml(
            assignment ? this.formatWorkflowAssignmentSource(assignment.source) : ''
          )}</div>
        </div>
        <div class="detail-row${assignment?.reason ? '' : ' is-hidden'}" id="workflowReasonRow">
          <div class="detail-label">Reason</div>
          <div class="detail-value detail-value--wrap" id="workflowReasonValue">${escapeHtml(
            assignment?.reason ?? ''
          )}</div>
        </div>
        <div class="form-status" id="workflowStatus" aria-live="polite"></div>
      </section>
    `;
  }

  private static readonly KNOWN_MODELS: Array<{ id: string; label: string }> = [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5' },
    { id: 'gpt-5.4', label: 'GPT 5.4' },
    { id: 'o3', label: 'o3' },
  ];

  private renderModelSection(issueKey: string): string {
    const currentModel = this.aiSessionManager.getIssueModelOverride(issueKey) ?? '';
    const models = this.knownModels ?? IssueDetailPanelManager.KNOWN_MODELS;
    const isKnown = !currentModel || models.some(m => m.id === currentModel);

    const modelOptions = models.map(
      m => `<option value="${escapeHtml(m.id)}" ${m.id === currentModel ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
    ).join('');

    // If the current model is a custom value not in the known list, add it as an option
    const customOption = (!isKnown && currentModel)
      ? `<option value="${escapeHtml(currentModel)}" selected>${escapeHtml(currentModel)}</option>`
      : '';

    return `
      <section class="card">
        <h3>Model</h3>
        <label class="field-group" for="modelSelect">
          <span class="field-label">AI Model</span>
          <select
            id="modelSelect"
            class="field-select"
            data-issue-key="${escapeHtml(issueKey)}"
          >
            <option value="" ${!currentModel ? 'selected' : ''}>Default</option>
            ${modelOptions}
            ${customOption}
            <option value="__custom__">Custom…</option>
          </select>
          <div class="field-help">
            Override the AI model for this issue. You can also add <code>Model: opus-4.6</code> in the Jira description.
          </div>
        </label>
        <div class="field-group${currentModel && !isKnown ? '' : ' is-hidden'}" id="customModelGroup">
          <span class="field-label">Custom Model ID</span>
          <input
            id="customModelInput"
            class="field-input"
            type="text"
            value="${escapeHtml(isKnown ? '' : currentModel)}"
            placeholder="e.g. claude-opus-4-6"
          />
        </div>
        <div class="form-status" id="modelStatus" aria-live="polite"></div>
      </section>
    `;
  }

  private createPanelWithHtml(issueKey: string): void {
    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'praxis.issueDetailPanel',
      issueKey,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = this.getHtml(nonce);

    this.panel = panel;
    this.panelIssueKey = issueKey;

    panel.onDidDispose(() => {
      this.resetPanelState();
    }, undefined, []);

    panel.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    }, undefined, []);
  }

  private resetPanelState(): void {
    this.panel = undefined;
    this.panelIssueKey = undefined;
    this.draftMode = false;
    this.draftDefaults = undefined;
    this.draftProjects = [];
    this.draftServiceMode = undefined;
  }

  private getHtml(nonce: string): string {
    const issueKey = this.activeIssueKey?.trim() || 'Issue';
    let bodyContent: string;
    let documentTitle: string;
    let headerTitle: string;
    let headerSubtitle = '';

    if (this.draftMode && this.details) {
      documentTitle = DRAFT_PANEL_TITLE;
      headerTitle = DRAFT_PANEL_TITLE;
      headerSubtitle = 'Fill in the details, then choose Create.';
      bodyContent = this.buildIssueBodyHtml(this.details);
    } else if (this.loading) {
      documentTitle = `Loading ${issueKey}`;
      headerTitle = `Loading ${issueKey}...`;
      bodyContent = `<section class="empty-state"><h2>Loading ${escapeHtml(issueKey)}...</h2></section>`;
    } else if (this.errorMessage) {
      documentTitle = `${issueKey} - Ticket Details`;
      headerTitle = issueKey;
      bodyContent = `<section class="empty-state error"><h2>Unable to load issue</h2><p>${escapeHtml(this.errorMessage)}</p></section>`;
    } else if (!this.details) {
      documentTitle = `${issueKey} - Ticket Details`;
      headerTitle = issueKey;
      bodyContent = `<section class="empty-state"><h2>No issue data</h2></section>`;
    } else {
      const d = this.details;
      documentTitle = `${d.key} - Ticket Details`;
      headerTitle = d.key;
      headerSubtitle = d.summary;
      bodyContent = this.buildIssueBodyHtml(d);
    }

    const subtitleHtml = headerSubtitle
      ? `<p class="panel-subtitle">${escapeHtml(headerSubtitle)}</p>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      padding: 0;
      display: flex;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .page {
      display: flex;
      flex: 1;
      width: 100%;
      min-height: 100vh;
      padding: 8px;
    }
    .content-shell {
      display: flex;
      flex: 1;
      flex-direction: column;
      width: 100%;
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    .content {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 16px;
      min-height: 0;
      padding: 16px;
      overflow-y: auto;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .panel-header-main {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .panel-header h1 {
      margin: 0;
      font-size: 22px;
      color: var(--vscode-textLink-foreground);
    }
    .panel-subtitle {
      margin: 0;
      font-size: 15px;
      line-height: 1.45;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .card h3 {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .panel-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-editor-foreground));
      cursor: pointer;
      flex-shrink: 0;
    }
    .icon-button:hover {
      border-color: var(--vscode-widget-border, transparent);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    .icon-button svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .field-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .field-help {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .parent-group.is-hidden,
    .is-hidden {
      display: none;
    }
    .parent-preview {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .parent-preview-summary {
      font-size: 12px;
      line-height: 1.4;
    }
    .parent-preview-description {
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground);
    }
    .field-input,
    .field-textarea,
    .field-select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    .field-textarea {
      min-height: 112px;
      resize: vertical;
      line-height: 1.5;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
    }
    .comment-textarea {
      min-height: 84px;
    }
    .field-select {
      min-height: 36px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border-color: var(--vscode-dropdown-border, var(--vscode-panel-border));
    }
    .form-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .primary-button,
    .secondary-button {
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .primary-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .primary-button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .secondary-button {
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-button-border, transparent));
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
    }
    .secondary-button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .primary-button:disabled,
    .secondary-button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .form-status {
      min-height: 18px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .form-status.error {
      color: var(--vscode-errorForeground);
    }
    .form-status.success {
      color: var(--vscode-testing-iconPassed, var(--vscode-textLink-foreground));
    }
    .detail-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px;
      align-items: start;
      min-width: 0;
    }
    .detail-label {
      color: var(--vscode-descriptionForeground);
    }
    .detail-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-value--wrap {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.4;
    }
    .pill--epic {
      color: #d8b4fe;
      background: rgba(168, 85, 247, 0.16);
      border-color: rgba(168, 85, 247, 0.28);
    }
    .pill--feature {
      color: #fdba74;
      background: rgba(249, 115, 22, 0.16);
      border-color: rgba(249, 115, 22, 0.28);
    }
    .pill--idea {
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.16);
      border-color: rgba(245, 158, 11, 0.28);
    }
    .pill--story {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.16);
      border-color: rgba(59, 130, 246, 0.28);
    }
    .pill--task {
      color: #86efac;
      background: rgba(34, 197, 94, 0.16);
      border-color: rgba(34, 197, 94, 0.28);
    }
    .pill--bug {
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.28);
    }
    .pill--todo {
      color: #c4b5fd;
      background: rgba(124, 58, 237, 0.16);
      border-color: rgba(124, 58, 237, 0.28);
    }
    .pill--progress {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.16);
      border-color: rgba(59, 130, 246, 0.28);
    }
    .pill--blocked {
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.28);
    }
    .pill--done {
      color: #86efac;
      background: rgba(34, 197, 94, 0.16);
      border-color: rgba(34, 197, 94, 0.28);
    }
    .pill--neutral {
      color: #a1a1aa;
      background: rgba(161, 161, 170, 0.1);
      border-color: rgba(161, 161, 170, 0.2);
    }
    .assign-actions {
      display: flex;
      gap: 6px;
    }
    .assign-btn {
      padding: 4px 10px;
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .assign-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .comment-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .linked-issue-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .markdown-preview {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--vscode-editor-background);
    }
    .markdown-preview.is-empty {
      color: var(--vscode-descriptionForeground);
    }
    .comment-item,
    .comment-empty {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
    }
    .linked-issue-item {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .linked-issue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .linked-issue-relationship {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    .linked-issue-key {
      color: var(--vscode-textLink-foreground);
      font-weight: 700;
      text-decoration: none;
    }
    .linked-issue-key:hover {
      text-decoration: underline;
    }
    .linked-issue-summary {
      line-height: 1.4;
      word-break: break-word;
    }
    .linked-issue-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .comment-meta {
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .comment-body {
      word-break: break-word;
      line-height: 1.5;
    }
    ${MARKDOWN_BODY_CSS}
    .comment-empty {
      color: var(--vscode-descriptionForeground);
    }
    .empty-state {
      flex: 1;
      padding: 24px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state h2 {
      margin-top: 0;
      color: var(--vscode-editor-foreground);
    }
    .empty-state.error { color: var(--vscode-errorForeground); }
    .subtask-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .subtask-row {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
    }
    .subtask-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .subtask-state-icon {
      font-size: 14px;
      flex-shrink: 0;
    }
    .subtask-key {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      font-size: 12px;
      flex-shrink: 0;
    }
    .subtask-summary {
      font-size: 13px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .subtask-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }
    .subtask-workflow-select {
      flex: 1;
      min-width: 0;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 12px;
    }
    .subtask-start-btn {
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="content-shell">
      <header class="panel-header">
        <div class="panel-header-main">
          <h1>${escapeHtml(headerTitle)}</h1>
          ${subtitleHtml}
        </div>
        ${renderIconButton('refreshBtn', 'Refresh', 'refresh')}
      </header>
      <main class="content">
        ${bodyContent}
      </main>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    function setStatusMessage(target, text, kind) {
      if (!(target instanceof HTMLElement)) return;
      target.textContent = text || '';
      target.className = kind ? 'form-status ' + kind : 'form-status';
    }

    // --- Issue edit form ---
    (function () {
      const editForm = document.getElementById('issueEditForm');
      if (!(editForm instanceof HTMLFormElement)) return;

      const summaryInput = document.getElementById('summaryInput');
      const draftProjectSelect = document.getElementById('draftProjectSelect');
      const statusSelect = document.getElementById('statusSelect');
      const issueTypeSelect = document.getElementById('issueTypeSelect');
      const assigneeInput = document.getElementById('assigneeInput');
      const prioritySelect = document.getElementById('prioritySelect');
      const issueModelSelect = document.getElementById('issueModelSelect');
      const severitySelect = document.getElementById('severitySelect');
      const reportedByInput = document.getElementById('reportedByInput');
      const descriptionInput = document.getElementById('descriptionInput');
      const ideaTranscriptInput = document.getElementById('ideaTranscriptInput');
      const ideaTranscriptGroup = document.getElementById('ideaTranscriptGroup');
      const parentFieldGroup = document.getElementById('parentFieldGroup');
      const parentFieldLabel = document.getElementById('parentFieldLabel');
      const parentInput = document.getElementById('parentInput');
      const parentFieldHint = document.getElementById('parentFieldHint');
      const parentPreviewSummary = document.getElementById('parentPreviewSummary');
      const parentPreviewDescription = document.getElementById('parentPreviewDescription');
      const saveButton = document.getElementById('saveButton');
      const resetButton = document.getElementById('resetButton');
      const formStatus = document.getElementById('formStatus');

      let saving = false;
      let statusOverride = undefined;
      let initialState = readCurrentState();

      function normalizeIssueType(value) {
        return (value || '').trim().toLowerCase().replace(/[\\s_-]+/g, '');
      }

      // Datalist suggestions are "KEY — Summary" (Chromium only shows an
      // option's value, not its label), so picking one leaves the summary in
      // the input; pull the key back out before it's read or submitted.
      function extractParentKey(raw) {
        const value = (raw || '').trim();
        const separatorIndex = value.indexOf(' ${PARENT_OPTION_SEPARATOR} ');
        return separatorIndex === -1 ? value : value.slice(0, separatorIndex).trim();
      }

      // Parent rules are serialized by the host into the #parentRules data block
      // so this script never re-implements getParentRule — the previous inline
      // copy drifted (no livefolder branch) and blocked live folder creation.
      let parentRulesCache;
      function getParentRules() {
        if (!parentRulesCache) {
          try {
            const rulesElement = document.getElementById('parentRules');
            parentRulesCache = rulesElement ? JSON.parse(rulesElement.textContent || '{}') : {};
          } catch {
            parentRulesCache = {};
          }
        }
        return parentRulesCache;
      }

      function getParentUi(issueType) {
        const rules = getParentRules();
        const normalized = normalizeIssueType(issueType);
        let rule = rules[issueType];
        if (!rule) {
          const matchKey = Object.keys(rules).find(key => normalizeIssueType(key) === normalized);
          rule = matchKey ? rules[matchKey] : undefined;
        }
        if (rule) {
          return {
            canHaveParent: Boolean(rule.canHaveParent),
            requiresParent: Boolean(rule.requiresParent),
            label: rule.defaultLabel || 'Parent',
            helper: rule.helperText || '',
            emptyText: rule.emptyText || '',
            placeholder: rule.placeholder || ''
          };
        }
        return {
          canHaveParent: true,
          requiresParent: false,
          label: 'Parent',
          helper: 'Select a parent item.',
          emptyText: 'No parent selected.',
          placeholder: ''
        };
      }

      function updateParentField() {
        const issueType = issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value.trim() : '';
        const parentUi = getParentUi(issueType);
        const currentParentKey = parentInput instanceof HTMLInputElement ? extractParentKey(parentInput.value) : '';
        const initialParentKey =
          parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.initialParentKey || '' : '';
        const currentParentType =
          parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.currentParentType || '' : '';
        const currentParentSummary =
          parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.currentParentSummary || '' : '';
        const currentParentDescription =
          parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.currentParentDescription || '' : '';

        if (parentFieldGroup instanceof HTMLElement) {
          parentFieldGroup.classList.toggle('is-hidden', !parentUi.canHaveParent);
        }
        if (parentFieldLabel instanceof HTMLElement) {
          parentFieldLabel.textContent =
            currentParentKey && currentParentKey === initialParentKey && currentParentType
              ? currentParentType
              : parentUi.label;
        }
        if (parentFieldHint instanceof HTMLElement) {
          parentFieldHint.textContent = parentUi.helper;
        }
        if (parentInput instanceof HTMLInputElement) {
          parentInput.placeholder = parentUi.placeholder;
        }
        if (parentPreviewSummary instanceof HTMLElement) {
          if (!parentUi.canHaveParent) {
            parentPreviewSummary.textContent = parentUi.emptyText;
          } else if (currentParentKey && currentParentKey === initialParentKey && currentParentSummary) {
            parentPreviewSummary.textContent = (initialParentKey + ' ' + currentParentSummary).trim();
          } else if (currentParentKey) {
            parentPreviewSummary.textContent = 'Save to load ' + parentUi.label.toLowerCase() + ' details.';
          } else {
            parentPreviewSummary.textContent = parentUi.emptyText;
          }
        }
        if (parentPreviewDescription instanceof HTMLElement) {
          const showDescription =
            Boolean(parentUi.canHaveParent) &&
            Boolean(currentParentKey) &&
            currentParentKey === initialParentKey &&
            Boolean(currentParentDescription);
          parentPreviewDescription.textContent = showDescription ? currentParentDescription : '';
          parentPreviewDescription.classList.toggle('is-hidden', !showDescription);
        }
      }

      function updateIdeaTranscriptField() {
        if (!(ideaTranscriptGroup instanceof HTMLElement)) {
          return;
        }

        const issueType = normalizeIssueType(issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value : '');
        ideaTranscriptGroup.classList.toggle('is-hidden', issueType !== 'idea');
      }

      function readCurrentState() {
        const parentUi = getParentUi(
          issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value.trim() : ''
        );
        return {
          summary: summaryInput instanceof HTMLInputElement ? summaryInput.value : '',
          transitionId: statusSelect instanceof HTMLSelectElement ? statusSelect.value : '',
          issueType: issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value : '',
          assignee: assigneeInput instanceof HTMLInputElement ? assigneeInput.value : '',
          priority: prioritySelect instanceof HTMLSelectElement ? prioritySelect.value : '',
          model: issueModelSelect instanceof HTMLSelectElement ? issueModelSelect.value : '',
          severity: severitySelect instanceof HTMLSelectElement ? severitySelect.value : '',
          reportedBy: reportedByInput instanceof HTMLInputElement ? reportedByInput.value : '',
          description: descriptionInput instanceof HTMLTextAreaElement ? descriptionInput.value : '',
          ideaTranscript:
            normalizeIssueType(issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value : '') === 'idea' &&
            ideaTranscriptInput instanceof HTMLTextAreaElement
              ? ideaTranscriptInput.value
              : '',
          parentKey:
            parentUi.canHaveParent && parentInput instanceof HTMLInputElement
              ? extractParentKey(parentInput.value)
              : ''
        };
      }

      // Draft-only, livefolder/userworkspace only: decide whether the parent
      // field names an EXISTING feature (datalist pick, exact key, or exact
      // summary) or a NEW one to create inline alongside the issue. Edit mode
      // never creates parents — it sends the key verbatim (the edit handler
      // writes parentKey || null, so rerouting free text here would clear it).
      function resolveParentSubmission(rawValue) {
        const value = (rawValue || '').trim();
        const isDraftForm = !editForm.dataset.issueKey;
        const mode = parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.mode : '';
        const canInlineCreate =
          isDraftForm && (mode === 'livefolder' || mode === 'userworkspace');
        if (!canInlineCreate || !value) {
          return { parentKey: extractParentKey(value), newParentSummary: '' };
        }
        const options = parentItemsList instanceof HTMLDataListElement
          ? Array.from(parentItemsList.options)
          : [];
        const lowered = value.toLowerCase();
        const byKey = options.find(
          option => extractParentKey(option.value).toLowerCase() === lowered
        );
        const bySummary =
          !byKey &&
          options.find(option => {
            const separator = ' ${PARENT_OPTION_SEPARATOR} ';
            const separatorIndex = option.value.indexOf(separator);
            const summary =
              separatorIndex === -1 ? '' : option.value.slice(separatorIndex + separator.length).trim();
            return summary.length > 0 && summary.toLowerCase() === lowered;
          });
        const match = byKey || bySummary;
        if (match) {
          return { parentKey: extractParentKey(match.value), newParentSummary: '' };
        }
        return { parentKey: '', newParentSummary: value };
      }

      function isDirty() {
        const currentState = readCurrentState();
        return (
          currentState.summary !== initialState.summary ||
          currentState.transitionId !== initialState.transitionId ||
          currentState.issueType !== initialState.issueType ||
          currentState.assignee !== initialState.assignee ||
          currentState.priority !== initialState.priority ||
          currentState.model !== initialState.model ||
            currentState.severity !== initialState.severity ||
            currentState.reportedBy !== initialState.reportedBy ||
            currentState.description !== initialState.description ||
            currentState.ideaTranscript !== initialState.ideaTranscript ||
            currentState.parentKey !== initialState.parentKey
          );
      }

      function getValidationError() {
        const summary = summaryInput instanceof HTMLInputElement ? summaryInput.value.trim() : '';
        if (summary.length === 0) return 'Summary is required.';
        const issueType = issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value.trim() : '';
        if (issueType.length === 0) return 'Ticket type is required.';
        const priority = prioritySelect instanceof HTMLSelectElement ? prioritySelect.value.trim() : '';
        if (priority.length === 0) return 'Priority is required.';
        const parentUi = getParentUi(issueType);
        const parentKey = parentInput instanceof HTMLInputElement ? extractParentKey(parentInput.value) : '';
        if (parentUi.canHaveParent && parentUi.requiresParent && parentKey.length === 0) {
          return parentUi.label + ' is required.';
        }
        return '';
      }

      function renderStatus() {
        if (statusOverride) {
          setStatusMessage(formStatus, statusOverride.text, statusOverride.kind);
          return;
        }
        if (saving) {
          setStatusMessage(formStatus, 'Saving...', '');
          return;
        }
        const validationError = getValidationError();
        if (validationError) {
          setStatusMessage(formStatus, validationError, 'error');
        } else if (isDirty()) {
          setStatusMessage(formStatus, 'Unsaved changes', '');
        } else {
          setStatusMessage(formStatus, '', '');
        }
      }

      function refreshActions() {
        const dirty = isDirty();
        const validationError = getValidationError();
        if (saveButton instanceof HTMLButtonElement) {
          saveButton.disabled = saving || !dirty || Boolean(validationError);
        }
        if (resetButton instanceof HTMLButtonElement) {
          resetButton.disabled = saving || !dirty;
        }
        renderStatus();
      }

      function clearStatusOverride() {
        statusOverride = undefined;
      }

      function onFormInput() {
        if (
          parentInput instanceof HTMLInputElement &&
          parentInput.value.indexOf(' ${PARENT_OPTION_SEPARATOR} ') !== -1
        ) {
          // Picking a datalist suggestion fills "KEY — Summary" into the input
          // (Chromium has no separate label); collapse it to the key once picked.
          parentInput.value = extractParentKey(parentInput.value);
        }
        clearStatusOverride();
        updateParentField();
        updateIdeaTranscriptField();
        refreshActions();
      }

      summaryInput?.addEventListener('input', onFormInput);
      draftProjectSelect?.addEventListener('change', onFormInput);
      statusSelect?.addEventListener('change', onFormInput);
      issueTypeSelect?.addEventListener('change', onFormInput);
      assigneeInput?.addEventListener('input', onFormInput);
      prioritySelect?.addEventListener('change', onFormInput);
      issueModelSelect?.addEventListener('change', onFormInput);
      severitySelect?.addEventListener('change', onFormInput);
        reportedByInput?.addEventListener('input', onFormInput);
        descriptionInput?.addEventListener('input', onFormInput);
        ideaTranscriptInput?.addEventListener('input', onFormInput);
        parentInput?.addEventListener('input', onFormInput);

      editForm.addEventListener('submit', event => {
        event.preventDefault();
        if (saving) return;
        clearStatusOverride();
        const validationError = getValidationError();
        if (validationError) {
          refreshActions();
          return;
        }
        saving = true;
        refreshActions();
        const currentState = readCurrentState();
        const parentSubmission = resolveParentSubmission(currentState.parentKey);
          const payload = {
            type: 'saveIssueEdits',
            issueKey: editForm.dataset.issueKey,
            summary: currentState.summary,
            transitionId: currentState.transitionId,
            issueType: currentState.issueType,
            assignee: currentState.assignee,
            priority: currentState.priority,
            description: currentState.description,
            ideaTranscript: currentState.ideaTranscript,
            parentKey: parentSubmission.parentKey
          };
        if (parentSubmission.newParentSummary) {
          payload.newParentSummary = parentSubmission.newParentSummary;
        }
        // Present only in draft mode; the extension falls back to the draft's
        // own project key when this field is absent.
        if (draftProjectSelect instanceof HTMLSelectElement) {
          payload.projectKey = draftProjectSelect.value;
        }
        if (currentState.model !== initialState.model) {
          payload.model = currentState.model;
        }
        if (currentState.severity !== initialState.severity) {
          payload.severity = currentState.severity;
        }
        if (currentState.reportedBy !== initialState.reportedBy) {
          payload.reportedBy = currentState.reportedBy;
        }
        vscode.postMessage(payload);
      });

      resetButton?.addEventListener('click', () => {
        if (summaryInput instanceof HTMLInputElement) summaryInput.value = initialState.summary;
        if (statusSelect instanceof HTMLSelectElement) statusSelect.value = initialState.transitionId;
        if (issueTypeSelect instanceof HTMLSelectElement) issueTypeSelect.value = initialState.issueType;
        if (assigneeInput instanceof HTMLInputElement) assigneeInput.value = initialState.assignee;
        if (prioritySelect instanceof HTMLSelectElement) prioritySelect.value = initialState.priority;
        if (issueModelSelect instanceof HTMLSelectElement) issueModelSelect.value = initialState.model;
        if (severitySelect instanceof HTMLSelectElement) severitySelect.value = initialState.severity;
        if (reportedByInput instanceof HTMLInputElement) reportedByInput.value = initialState.reportedBy;
        if (descriptionInput instanceof HTMLTextAreaElement) descriptionInput.value = initialState.description;
        if (ideaTranscriptInput instanceof HTMLTextAreaElement) ideaTranscriptInput.value = initialState.ideaTranscript || '';
        if (parentInput instanceof HTMLInputElement) parentInput.value = initialState.parentKey;
        clearStatusOverride();
        updateParentField();
        updateIdeaTranscriptField();
        refreshActions();
      });

      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'saveIssueEditsResult') {
          saving = false;
          if (msg.ok) {
            initialState = readCurrentState();
            if (statusSelect instanceof HTMLSelectElement) statusSelect.value = '';
            initialState.transitionId = '';
            statusOverride = { text: 'Saved.', kind: 'success' };
          } else {
            statusOverride = {
              text: typeof msg.error === 'string' ? msg.error : 'Unable to save changes.',
              kind: 'error'
            };
          }
          refreshActions();
        }
      });

      updateParentField();
      updateIdeaTranscriptField();
      refreshActions();
    })();

    // --- Comment form ---
    (function () {
      const commentForm = document.getElementById('commentForm');
      if (!(commentForm instanceof HTMLFormElement)) return;

      const commentInput = document.getElementById('commentInput');
      const addCommentButton = document.getElementById('addCommentButton');
      const commentStatus = document.getElementById('commentStatus');
      let commentSaving = false;
      let commentOverride = undefined;

      function refreshCommentActions() {
        const body = commentInput instanceof HTMLTextAreaElement ? commentInput.value.trim() : '';
        if (addCommentButton instanceof HTMLButtonElement) {
          addCommentButton.disabled = commentSaving || body.length === 0;
        }
        if (commentOverride) {
          setStatusMessage(commentStatus, commentOverride.text, commentOverride.kind);
        } else if (commentSaving) {
          setStatusMessage(commentStatus, 'Adding comment...', '');
        } else {
          setStatusMessage(commentStatus, '', '');
        }
      }

      commentInput?.addEventListener('input', () => {
        commentOverride = undefined;
        refreshCommentActions();
      });

      commentForm.addEventListener('submit', event => {
        event.preventDefault();
        const body = commentInput instanceof HTMLTextAreaElement ? commentInput.value.trim() : '';
        if (commentSaving || body.length === 0) return;
        commentSaving = true;
        commentOverride = undefined;
        refreshCommentActions();
        vscode.postMessage({
          type: 'addIssueComment',
          issueKey: commentForm.dataset.issueKey,
          body
        });
      });

      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'addIssueCommentResult') {
          commentSaving = false;
          if (msg.ok) {
            if (commentInput instanceof HTMLTextAreaElement) commentInput.value = '';
            commentOverride = { text: 'Comment added.', kind: 'success' };
          } else {
            commentOverride = {
              text: typeof msg.error === 'string' ? msg.error : 'Unable to add comment.',
              kind: 'error'
            };
          }
          refreshCommentActions();
        }
      });

      refreshCommentActions();
    })();

    // --- Assign buttons ---
    document.getElementById('assignToMeBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'assignToMe' });
    });
    document.getElementById('assignToAiBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'assignToAi' });
    });
    document.querySelectorAll('.assign-ai-provider-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = btn.getAttribute('data-provider');
        vscode.postMessage({ type: 'assignToAi', provider });
      });
    });
    document.getElementById('lprButton')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'localPeerReview' });
    });
    document.getElementById('openAnalysisBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAnalysisWindow' });
    });
    document.getElementById('viewAiSessionBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'viewAiSession' });
    });

    // --- Workflow selector ---
    (function () {
      const workflowSelect = document.getElementById('workflowSelect');
      const workflowStatus = document.getElementById('workflowStatus');
      const workflowSourceRow = document.getElementById('workflowSourceRow');
      const workflowSourceValue = document.getElementById('workflowSourceValue');
      const workflowReasonRow = document.getElementById('workflowReasonRow');
      const workflowReasonValue = document.getElementById('workflowReasonValue');

      if (!(workflowSelect instanceof HTMLSelectElement)) return;

      let saving = false;
      let initialValue = workflowSelect.value;
      let statusOverride = undefined;

      function updateAssignmentUi(assignment) {
        const source = typeof assignment?.source === 'string' ? assignment.source : '';
        const reason = typeof assignment?.reason === 'string' ? assignment.reason : '';

        if (workflowSourceValue instanceof HTMLElement) {
          workflowSourceValue.textContent = source;
        }
        if (workflowSourceRow instanceof HTMLElement) {
          workflowSourceRow.classList.toggle('is-hidden', !source);
        }
        if (workflowReasonValue instanceof HTMLElement) {
          workflowReasonValue.textContent = reason;
        }
        if (workflowReasonRow instanceof HTMLElement) {
          workflowReasonRow.classList.toggle('is-hidden', !reason);
        }
      }

      function renderWorkflowStatus() {
        if (statusOverride) {
          setStatusMessage(workflowStatus, statusOverride.text, statusOverride.kind);
          return;
        }
        if (saving) {
          setStatusMessage(workflowStatus, 'Updating workflow pack...', '');
          return;
        }
        setStatusMessage(workflowStatus, '', '');
      }

      function refreshWorkflowActions() {
        workflowSelect.disabled = saving || workflowSelect.options.length === 0;
        renderWorkflowStatus();
      }

      workflowSelect.addEventListener('change', () => {
        if (saving || workflowSelect.value === initialValue) {
          return;
        }

        statusOverride = undefined;
        saving = true;
        refreshWorkflowActions();
        vscode.postMessage({
          type: 'setWorkflowPack',
          issueKey: workflowSelect.dataset.issueKey,
          workflowInstructionsPath: workflowSelect.value
        });
      });

      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'setWorkflowPackResult') {
          saving = false;
          if (msg.ok) {
            initialValue = workflowSelect.value;
            updateAssignmentUi(msg.assignment);
            statusOverride = {
              text: 'Workflow pack updated.',
              kind: 'success'
            };
          } else {
            workflowSelect.value = initialValue;
            statusOverride = {
              text: typeof msg.error === 'string' ? msg.error : 'Unable to update workflow pack.',
              kind: 'error'
            };
          }
          refreshWorkflowActions();
        }
      });

      refreshWorkflowActions();

      // ── Sub-task workflow assignment and delivery start ──
      document.querySelectorAll('.subtask-workflow-select').forEach(select => {
        select.addEventListener('change', () => {
          const subTaskKey = select.getAttribute('data-subtask-key');
          const workflowInstructionsPath = select.value;
          if (subTaskKey) {
            vscode.postMessage({
              type: 'assignSubTaskWorkflow',
              subTaskKey,
              workflowInstructionsPath
            });
          }
        });
      });
      document.querySelectorAll('.subtask-start-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const subTaskKey = btn.getAttribute('data-subtask-key');
          if (subTaskKey) {
            vscode.postMessage({
              type: 'startSubTaskDelivery',
              subTaskKey
            });
          }
        });
      });
    })();

    // --- Model selector ---
    (function () {
      const modelSelect = document.getElementById('modelSelect');
      const modelStatus = document.getElementById('modelStatus');
      const customModelGroup = document.getElementById('customModelGroup');
      const customModelInput = document.getElementById('customModelInput');

      if (!(modelSelect instanceof HTMLSelectElement)) return;

      let saving = false;
      let initialValue = modelSelect.value;
      let statusOverride = undefined;

      function showCustomInput(show) {
        if (customModelGroup instanceof HTMLElement) {
          customModelGroup.classList.toggle('is-hidden', !show);
        }
      }

      function renderModelStatus() {
        if (statusOverride) {
          setStatusMessage(modelStatus, statusOverride.text, statusOverride.kind);
          return;
        }
        if (saving) {
          setStatusMessage(modelStatus, 'Updating model...', '');
          return;
        }
        setStatusMessage(modelStatus, '', '');
      }

      function refreshModelActions() {
        modelSelect.disabled = saving;
        renderModelStatus();
      }

      function sendModelUpdate(model) {
        statusOverride = undefined;
        saving = true;
        refreshModelActions();
        vscode.postMessage({
          type: 'setModel',
          issueKey: modelSelect.dataset.issueKey,
          model: model
        });
      }

      modelSelect.addEventListener('change', () => {
        if (saving) return;
        const value = modelSelect.value;
        if (value === '__custom__') {
          showCustomInput(true);
          if (customModelInput instanceof HTMLInputElement) {
            customModelInput.focus();
          }
          return;
        }
        showCustomInput(false);
        if (value === initialValue) return;
        sendModelUpdate(value);
      });

      if (customModelInput instanceof HTMLInputElement) {
        customModelInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const value = customModelInput.value.trim();
            if (value) {
              sendModelUpdate(value);
            }
          }
        });
      }

      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'setModelResult') {
          saving = false;
          if (msg.ok) {
            initialValue = typeof msg.model === 'string' ? msg.model : '';
            statusOverride = {
              text: initialValue ? 'Model updated to ' + initialValue + '.' : 'Model reset to default.',
              kind: 'success'
            };
          } else {
            modelSelect.value = initialValue;
            statusOverride = {
              text: typeof msg.error === 'string' ? msg.error : 'Unable to update model.',
              kind: 'error'
            };
          }
          refreshModelActions();
        }
      });

      refreshModelActions();
    })();
  </script>
</body>
</html>`;
  }

  private renderSubTasksSection(issueKey: string): string {
    if (this.subTasks.length === 0 && this.featureSubTaskRecords.length === 0) {
      return '';
    }

    const workflowOptions = this.getWorkflowChoices(issueKey);
    const subTaskRows = this.subTasks.map(subTask => {
      const featureRecord = this.featureSubTaskRecords.find(r => r.issueKey === subTask.key);
      const assignment = this.aiSessionManager.getIssueWorkflowAssignment(subTask.key);
      const selectedWorkflowPath = assignment?.workflow?.instructionsPath ?? '';
      const deliveryState = featureRecord?.deliveryState ?? 'pending';

      const workflowSelectHtml = workflowOptions.length > 0
        ? `<select class="subtask-workflow-select" data-subtask-key="${escapeHtml(subTask.key)}">
            <option value="" ${selectedWorkflowPath ? '' : 'selected'}>No workflow</option>
            ${workflowOptions.map(w =>
              `<option value="${escapeHtml(w.instructionsPath)}" ${w.instructionsPath === selectedWorkflowPath ? 'selected' : ''}>${escapeHtml(w.name)}</option>`
            ).join('')}
          </select>`
        : '<span class="field-help">No workflows available</span>';

      const stateIcon = deliveryState === 'completed' ? '✅'
        : deliveryState === 'in-progress' ? '🔄'
        : deliveryState === 'failed' ? '❌'
        : '⏳';

      const startBtnHtml = deliveryState === 'pending' || deliveryState === 'failed'
        ? `<button type="button" class="subtask-start-btn assign-btn" data-subtask-key="${escapeHtml(subTask.key)}">Start</button>`
        : '';

      return `<div class="subtask-row">
        <div class="subtask-header">
          <span class="subtask-state-icon">${stateIcon}</span>
          <span class="subtask-key">${escapeHtml(subTask.key)}</span>
          <span class="subtask-summary">${escapeHtml(subTask.summary)}</span>
          ${renderPill(subTask.status)}
        </div>
        <div class="subtask-actions">
          ${workflowSelectHtml}
          ${startBtnHtml}
        </div>
      </div>`;
    }).join('');

    return `
      <section class="card">
        <h3>Sub-Tasks</h3>
        <div class="subtask-list">
          ${subTaskRows || '<div class="comment-empty">No sub-tasks.</div>'}
        </div>
      </section>
    `;
  }

  private buildIssueBodyHtml(d: IssueDetails): string {
    const isDraft = this.draftMode;
    // Parent rules must follow the service that will actually persist the
    // issue: for a draft that is the board's own connection, which may differ
    // from the router's active service in multi-connection setups.
    const renderMode =
      isDraft && this.draftServiceMode ? this.draftServiceMode : this.backendService.mode;
    // Serialize the host-side parent rule for every selectable issue type so the
    // webview script looks rules up instead of re-implementing them — the inline
    // copy drifted once already (it never learned the livefolder Feature rule,
    // which blocked issue creation with "Feature is required ...").
    const inlineParentHint =
      isDraft && (renderMode === 'livefolder' || renderMode === 'userworkspace')
        ? ' Select an existing feature or type a new name to create one.'
        : '';
    const parentRuleFor = (issueType: string): ParentRule => {
      const rule = getParentRule(issueType, renderMode);
      return inlineParentHint ? { ...rule, helperText: rule.helperText + inlineParentHint } : rule;
    };
    const issueTypeNames = ['Epic', 'Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug', 'Issue'];
    const parentRule = parentRuleFor(d.issueType);
    const resolvedParentLabel = getResolvedParentLabel(
      d.issueType,
      renderMode,
      d.parentIssue
    );
    const parentReference = formatParentReference(d.parentIssue);
    // A draft picks its project; a saved issue cannot move, so it stays readonly.
    const readonlyRows = isDraft
      ? this.buildDraftProjectField(d)
      : [
          ['Project', d.projectName ? `${d.projectKey} • ${d.projectName}` : d.projectKey ?? '—'],
          ['Created', formatDate(d.created)],
          ['Updated', formatDate(d.updated)]
        ]
          .map(
            ([label, value]) => `<div class="detail-row">
          <div class="detail-label">${escapeHtml(label)}</div>
          <div class="detail-value detail-value--wrap">${escapeHtml(value)}</div>
        </div>`
          )
          .join('');
    const statusOptions = `<option value="" selected>${escapeHtml(d.status)}</option>${this.transitions
      .map(
        transition =>
          `<option value="${escapeHtml(transition.id)}">${escapeHtml(
            transition.toStatus ?? transition.name
          )}</option>`
      )
      .join('')}`;
        const issueTypeOptions = renderSelectOptions(d.issueType, issueTypeNames);
    const priorityOptions = renderSelectOptions(d.priority, [
      'Critical',
      'Highest',
      'High',
      'Medium',
      'Low',
      'Lowest'
    ]);
    const metadataModelOptions = renderSelectOptions(d.model, [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'gpt-4.1',
      'gpt-4.1-mini',
      'o3',
      'o4-mini'
    ]);
    const severityOptions = renderSelectOptions(d.severity, [
      'Critical',
      'High',
      'Medium',
      'Low'
    ]);
    const isIdea = d.issueType.trim().toLowerCase() === 'idea';
    const currentAssignment = this.aiSessionManager.getSession(d.key);
    const hasPreviousAgentSession = Boolean(this.aiSessionManager.getAgentSession(d.key));
    const sessionBtnDisabled = isIdea || currentAssignment || hasPreviousAgentSession ? '' : ' disabled';
    const sessionBtnTitle = isIdea
      ? 'Idea tickets do not use AI session workflows.'
      : currentAssignment
        ? 'View active AI session'
        : hasPreviousAgentSession
          ? 'View previous AI session'
          : 'Assign to AI first';
    const hasDelegationAssignee = Boolean(d.assignee?.trim());
    const delegateDisabledAttr = hasDelegationAssignee ? '' : ' disabled';
    const delegateDisabledHelp = hasDelegationAssignee
      ? ''
      : '<div class="field-help">Set the assignee first, then delegate the work to AI.</div>';
    const comments = (d.comments ?? [])
      .map(comment => {
        const formattedDate = formatDate(comment.created ?? comment.updated);
        const metaParts = [comment.author, formattedDate !== '—' ? formattedDate : undefined].filter(
          (value): value is string => Boolean(value)
        );
        return `<div class="comment-item">
          <div class="comment-meta">${escapeHtml(metaParts.join(' • ') || 'Comment')}</div>
          <div class="comment-body markdown-body">${markdownToHtmlSafe(comment.body)}</div>
        </div>`;
      })
      .join('');
    const linkedIssues = (d.linkedIssues ?? [])
      .map(linkedIssue => {
        const relationship = escapeHtml(linkedIssue.relationship || 'Linked issue');
        const keyMarkup = linkedIssue.browseUrl?.trim()
          ? `<a class="linked-issue-key" href="${escapeHtml(linkedIssue.browseUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(linkedIssue.key)}</a>`
          : `<span class="linked-issue-key">${escapeHtml(linkedIssue.key)}</span>`;
        const summaryMarkup = linkedIssue.summary?.trim()
          ? `<div class="linked-issue-summary">${escapeHtml(linkedIssue.summary)}</div>`
          : '';
        const metaMarkup = [linkedIssue.issueType, linkedIssue.status]
          .filter((value): value is string => Boolean(value?.trim()))
          .map(value => renderPill(value))
          .join(' ');
        return `<div class="linked-issue-item">
          <div class="linked-issue-head">
            <span class="linked-issue-relationship">${relationship}</span>
            ${keyMarkup}
          </div>
          ${summaryMarkup}
          ${metaMarkup ? `<div class="linked-issue-meta">${metaMarkup}</div>` : ''}
        </div>`;
      })
      .join('');

    return `
      <section class="card">
        <h3>Details</h3>
        <form id="issueEditForm" data-issue-key="${escapeHtml(d.key)}" class="panel-form">
          ${readonlyRows}
          <label class="field-group" for="summaryInput">
            <span class="field-label">Summary</span>
            <input
              id="summaryInput"
              class="field-input"
              type="text"
              value="${escapeHtml(d.summary)}"
              placeholder="Issue summary"
            />
          </label>
          ${isDraft ? '' : `<label class="field-group" for="statusSelect">
            <span class="field-label">Status</span>
            <select id="statusSelect" class="field-select" ${this.transitions.length === 0 ? 'disabled' : ''}>
              ${statusOptions}
            </select>
          </label>`}
          <label class="field-group" for="issueTypeSelect">
            <span class="field-label">Ticket Type</span>
            <select id="issueTypeSelect" class="field-select">
              ${issueTypeOptions}
            </select>
          </label>
          <label class="field-group" for="assigneeInput">
            <span class="field-label">Assignee</span>
            <input
              id="assigneeInput"
              class="field-input"
              type="text"
              value="${escapeHtml(d.assignee ?? '')}"
              placeholder="Enter an assignee or leave blank"
            />
            ${isDraft ? '' : `<div class="assign-actions">
              <button type="button" class="assign-btn" id="assignToMeBtn">Assign to Me</button>
              ${this.aiAssignOptions.length > 0
                ? this.aiAssignOptions.map(
                    option => `<button type="button" class="assign-btn assign-ai-provider-btn" data-provider="${escapeHtml(option.provider)}"${delegateDisabledAttr}>Delegate to ${escapeHtml(option.label)}</button>`
                  ).join('')
                : `<button type="button" class="assign-btn" id="assignToAiBtn"${delegateDisabledAttr}>Delegate to AI</button>`
              }
              <button type="button" class="assign-btn" id="openAnalysisBtn">Open Analysis</button>
            </div>
            ${delegateDisabledHelp}`}
          </label>
          <label class="field-group" for="prioritySelect">
            <span class="field-label">Priority</span>
            <select id="prioritySelect" class="field-select">
              ${priorityOptions}
            </select>
          </label>
          <label class="field-group" for="issueModelSelect">
            <span class="field-label">Requested Model</span>
            <select id="issueModelSelect" class="field-select">
              <option value="">— Use default —</option>
              ${metadataModelOptions}
            </select>
          </label>
          <label class="field-group" for="severitySelect">
            <span class="field-label">Severity</span>
            <select id="severitySelect" class="field-select">
              <option value="">— None —</option>
              ${severityOptions}
            </select>
          </label>
          <label class="field-group" for="reportedByInput">
            <span class="field-label">Reported By</span>
            <input
              id="reportedByInput"
              class="field-input"
              type="text"
              value="${escapeHtml(d.reportedBy ?? '')}"
              placeholder="Source or reporter"
            />
          </label>
          ${isDraft ? '' : `<div class="detail-row">
            <div class="detail-label">Branch</div>
            <div class="detail-value detail-value--wrap">${escapeHtml(d.branch || '—')}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Complexity</div>
            <div class="detail-value detail-value--wrap">${escapeHtml(d.complexity || '—')}</div>
          </div>`}
          <div
            class="field-group parent-group${parentRule.canHaveParent ? '' : ' is-hidden'}"
            id="parentFieldGroup"
            data-mode="${escapeHtml(renderMode)}"
            data-initial-parent-key="${escapeHtml(d.parentKey ?? '')}"
            data-current-parent-type="${escapeHtml(d.parentIssue?.issueType ?? '')}"
            data-current-parent-summary="${escapeHtml(d.parentIssue?.summary ?? '')}"
            data-current-parent-description="${escapeHtml(d.parentIssue?.description ?? '')}"
          >
            <span class="field-label" id="parentFieldLabel">${escapeHtml(resolvedParentLabel)}</span>
            <input
              id="parentInput"
              class="field-input"
              type="text"
              list="parentItemsList"
              value="${escapeHtml(d.parentKey ?? '')}"
              placeholder="${escapeHtml(parentRule.placeholder)}"
            />
            <datalist id="parentItemsList">${this.parentItems
              .map(
                item =>
                  `<option value="${escapeHtml(`${item.key} ${PARENT_OPTION_SEPARATOR} ${item.summary}`)}"></option>`
              )
              .join('')}</datalist>
            <div class="field-help" id="parentFieldHint">${escapeHtml(parentRule.helperText)}</div>
            <div class="parent-preview" id="parentPreview">
              <div class="parent-preview-summary" id="parentPreviewSummary">${escapeHtml(
                parentReference || parentRule.emptyText
              )}</div>
              <div class="parent-preview-description markdown-body${d.parentIssue?.description ? '' : ' is-hidden'}" id="parentPreviewDescription">${markdownToHtmlSafe(
                d.parentIssue?.description ?? ''
              )}</div>
            </div>
            ${
              this.parentItemsError
                ? `<div class="form-status error">${escapeHtml(this.parentItemsError)}</div>`
                : ''
            }
          </div>
          <label class="field-group" for="descriptionInput">
            <span class="field-label">Description</span>
            <textarea
              id="descriptionInput"
              class="field-textarea"
              placeholder="Add a description"
            >${escapeHtml(d.description ?? '')}</textarea>
          </label>
          <div class="field-group">
            <span class="field-label">Description Preview</span>
            <div class="markdown-preview markdown-body${d.description?.trim() ? '' : ' is-empty'}">${d.description?.trim()
              ? markdownToHtmlSafe(d.description)
              : '<p>No description provided.</p>'}</div>
          </div>
          <label class="field-group idea-group${isIdea ? '' : ' is-hidden'}" for="ideaTranscriptInput" id="ideaTranscriptGroup">
            <span class="field-label">AI Research Transcript</span>
            <textarea
              id="ideaTranscriptInput"
              class="field-textarea idea-transcript-textarea"
              placeholder="Capture research chat and notes here"
            >${escapeHtml(d.ideaTranscript ?? '')}</textarea>
            <div class="field-help">Idea tickets keep research here instead of code delivery workflows.</div>
          </label>
          <div class="form-actions">
            <button class="primary-button" id="saveButton" type="submit">${isDraft ? 'Create' : 'Save'}</button>
            <button class="secondary-button" id="resetButton" type="button">Reset</button>
            ${isIdea || isDraft ? '' : '<button class="secondary-button" id="lprButton" type="button">Local Peer Review</button>'}
            ${isIdea || isDraft ? '' : `<button class="secondary-button" id="viewAiSessionBtn" type="button"${sessionBtnDisabled} title="${escapeHtml(sessionBtnTitle)}">AI Session</button>`}
            <span class="form-status" id="formStatus" aria-live="polite"></span>
          </div>
          <script type="application/json" id="parentRules">${JSON.stringify(
            Object.fromEntries(
              issueTypeNames.map(type => [type, parentRuleFor(type)] as [string, ParentRule])
            )
          // script blocks are raw text: no HTML-escaping (it would corrupt the
          // JSON), but neutralize "<" so a "</script>" can never break out.
          ).replace(/</g, '\\u003c')}</script>
        </form>
      </section>
      ${isDraft ? '' : `
      ${isIdea ? '' : this.renderWorkflowPackSection(d.key)}
      ${this.renderModelSection(d.key)}
      ${this.renderSubTasksSection(d.key)}
      <section class="card">
        <h3>Linked Items</h3>
        <div class="linked-issue-list">
          ${
            linkedIssues.length > 0
              ? linkedIssues
              : '<div class="comment-empty">No linked Jira items.</div>'
          }
        </div>
      </section>
      <section class="card">
        <h3>Activity</h3>
        <div class="comment-list">
          ${
            comments.length > 0
              ? comments
              : '<div class="comment-empty">No activity yet.</div>'
          }
        </div>
        <form id="commentForm" data-issue-key="${escapeHtml(d.key)}" class="panel-form">
          <label class="field-group" for="commentInput">
            <span class="field-label">Add Comment</span>
            <textarea
              id="commentInput"
              class="field-textarea comment-textarea"
               placeholder="${escapeHtml(this.commentPlaceholder)}"
            ></textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" id="addCommentButton" type="submit">Add Comment</button>
            <span class="form-status" id="commentStatus" aria-live="polite"></span>
          </div>
        </form>
      </section>
      `}
    `;
  }
}

