import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, IssueSummary, WorkflowTransition } from '../types';
import {
  formatParentReference,
  getParentRule,
  getResolvedParentLabel
} from '../issues/issueHierarchy';
import { renderIconButton } from './webviewToolbarIcons';
import { markdownToHtmlSafe, MARKDOWN_BODY_CSS } from '../ui/markdownToHtml';

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

export class IssueDetailPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeIssueKey?: string;
  private details?: IssueDetails;
  private transitions: WorkflowTransition[] = [];
  private parentItems: IssueSummary[] = [];
  private parentItemsError?: string;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly onAfterTransition: () => Promise<void>
  ) {}

  public async open(issueKey: string): Promise<void> {
    this.activeIssueKey = issueKey;
    this.details = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.parentItemsError = undefined;
    this.loading = true;
    this.errorMessage = undefined;
    this.ensurePanel(issueKey);
    this.render();
    this.panel?.reveal(vscode.ViewColumn.Beside, false);
    await this.refresh();
  }

  public async refreshIfShowing(issueKey: string): Promise<void> {
    if (this.activeIssueKey === issueKey && this.panel) {
      await this.refresh();
    }
  }

  public clear(): void {
    this.activeIssueKey = undefined;
    this.details = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.parentItemsError = undefined;
    this.loading = false;
    this.errorMessage = undefined;
    this.requestGeneration += 1;
    this.panel?.dispose();
    this.panel = undefined;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(issueKey: string): void {
    if (this.panel) {
      this.panel.title = issueKey;
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.issueDetailPanel',
      issueKey,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      []
    );

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (type === 'refresh') {
      await this.refresh();
      return;
    }

    if (!this.activeIssueKey) {
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
        const transitionId = asString(message.transitionId) ?? undefined;
        await this.backendService.updateIssue(this.activeIssueKey, {
          summary,
          description,
          parentKey: parentKey.trim() || null,
          assignee: assignee.trim() || null,
          priority,
          issueType
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

  private async refresh(): Promise<void> {
    if (!this.activeIssueKey) {
      return;
    }

    const issueKey = this.activeIssueKey;
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;
    this.render();

    try {
      const [issue, transitions] = await Promise.all([
        this.backendService.getIssue(issueKey),
        this.backendService.getTransitions(issueKey)
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

      this.details = { ...issue, transitions };
      this.transitions = transitions;
      this.parentItems = parentItems;
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
      this.parentItemsError = undefined;
    } finally {
      if (generation === this.requestGeneration) {
        this.render();
      }
    }
  }

  private render(): void {
    if (!this.panel) {
      return;
    }

    const issueKey = this.activeIssueKey ?? 'Issue';
    this.panel.title = issueKey;
    try {
      this.panel.webview.html = this.getHtml(this.panel.webview);
    } catch (error) {
      const escapedIssueKey = escapeHtml(issueKey);
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.html = this.wrapPage(
        createNonce(),
        escapedIssueKey,
        `<section class="empty-state error"><h2>Unable to render issue</h2><p>${escapeHtml(message)}</p></section>`,
        escapedIssueKey
      );
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const issueKey = escapeHtml(this.activeIssueKey ?? '');

    if (this.loading) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state"><h2>Loading ${issueKey}…</h2></section>`,
        `Loading ${issueKey}…`
      );
    }

    if (this.errorMessage) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state error"><h2>Unable to load issue</h2><p>${escapeHtml(this.errorMessage)}</p></section>`,
        issueKey || 'Issue'
      );
    }

    if (!this.details) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state"><h2>No issue data</h2></section>`,
        issueKey || 'Issue'
      );
    }

    const d = this.details;
    const parentRule = getParentRule(d.issueType, this.backendService.mode);
    const resolvedParentLabel = getResolvedParentLabel(
      d.issueType,
      this.backendService.mode,
      d.parentIssue
    );
    const parentReference = formatParentReference(d.parentIssue);
    const readonlyRows = [
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
    const issueTypeOptions = renderSelectOptions(d.issueType, [
      'Epic',
      'Feature',
      'Story',
      'Task',
      'Subtask',
      'Bug',
      'Issue'
    ]);
    const priorityOptions = renderSelectOptions(d.priority, [
      'Critical',
      'Highest',
      'High',
      'Medium',
      'Low',
      'Lowest'
    ]);
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

    const body = `
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
          <label class="field-group" for="statusSelect">
            <span class="field-label">Status</span>
            <select id="statusSelect" class="field-select" ${this.transitions.length === 0 ? 'disabled' : ''}>
              ${statusOptions}
            </select>
          </label>
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
          </label>
          <label class="field-group" for="prioritySelect">
            <span class="field-label">Priority</span>
            <select id="prioritySelect" class="field-select">
              ${priorityOptions}
            </select>
          </label>
          <div
            class="field-group parent-group${parentRule.canHaveParent ? '' : ' is-hidden'}"
            id="parentFieldGroup"
            data-mode="${escapeHtml(this.backendService.mode)}"
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
              value="${escapeHtml(d.parentKey ?? '')}"
              placeholder="${escapeHtml(parentRule.placeholder)}"
            />
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
          <div class="form-actions">
            <button class="primary-button" id="saveButton" type="submit">Save</button>
            <button class="secondary-button" id="resetButton" type="button">Reset</button>
            <span class="form-status" id="formStatus" aria-live="polite"></span>
          </div>
        </form>
      </section>
      <section class="card">
        <h3>Comments</h3>
        <div class="comment-list">
          ${
            comments.length > 0
              ? comments
              : '<div class="comment-empty">No comments yet.</div>'
          }
        </div>
        <form id="commentForm" data-issue-key="${escapeHtml(d.key)}" class="panel-form">
          <label class="field-group" for="commentInput">
            <span class="field-label">Add Comment</span>
            <textarea
              id="commentInput"
              class="field-textarea comment-textarea"
               placeholder="Write a comment (mention @copilot for a reply)"
            ></textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" id="addCommentButton" type="submit">Add Comment</button>
            <span class="form-status" id="commentStatus" aria-live="polite"></span>
          </div>
        </form>
      </section>
    `;

    return this.wrapPage(nonce, issueKey, body, escapeHtml(d.key), escapeHtml(d.summary));
  }

  private wrapPage(
    nonce: string,
    title: string,
    body: string,
    headerTitle: string = title,
    headerSubtitle?: string
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
      display: flex;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .page {
      box-sizing: border-box;
      display: flex;
      flex: 1;
      width: 100%;
      min-height: 100vh;
      padding: 8px;
    }
    .content-shell {
      box-sizing: border-box;
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
    .inline-action-row {
      display: flex;
      gap: 8px;
      align-items: center;
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
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .meta-table th {
      text-align: left;
      width: 120px;
      padding: 6px 12px 6px 0;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      vertical-align: top;
    }
    .meta-table td { padding: 6px 0; }
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
      color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
      border-color: transparent;
    }
    .comment-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .comment-item,
    .comment-empty {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
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
  </style>
</head>
<body>
  <div class="page">
    <div class="content-shell">
      <header class="panel-header">
        <div class="panel-header-main">
          <h1>${headerTitle}</h1>
          ${headerSubtitle ? `<p class="panel-subtitle">${headerSubtitle}</p>` : ''}
        </div>
        ${renderIconButton('refreshBtn', 'Refresh', 'refresh')}
      </header>
      <main class="content">
        ${body}
      </main>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
    }

    function setStatusMessage(target, text, kind) {
      if (!(target instanceof HTMLElement)) {
        return;
      }

      target.textContent = text || '';
      target.className = kind ? 'form-status ' + kind : 'form-status';
    }

    const editForm = document.getElementById('issueEditForm');
    let handleSaveIssueEditsResult = undefined;
    if (editForm instanceof HTMLFormElement) {
      const summaryInput = document.getElementById('summaryInput');
      const statusSelect = document.getElementById('statusSelect');
      const issueTypeSelect = document.getElementById('issueTypeSelect');
      const assigneeInput = document.getElementById('assigneeInput');
      const prioritySelect = document.getElementById('prioritySelect');
      const descriptionInput = document.getElementById('descriptionInput');
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
        return (value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      }

      function getParentUi(issueType) {
        const normalized = normalizeIssueType(issueType);
        const mode = parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.mode : 'jira';
        if (normalized === 'epic' || normalized === 'feature') {
          return {
            canHaveParent: false,
            requiresParent: false,
            label: 'Parent',
            helper: (issueType || 'Issue') + ' items cannot have a parent.',
            emptyText: (issueType || 'Issue') + ' items do not use a parent.',
            placeholder: ''
          };
        }
        if (normalized === 'subtask') {
          return {
            canHaveParent: true,
            requiresParent: true,
            label: 'Story',
            helper: 'Subtasks can only belong to a story.',
            emptyText: 'No story selected.',
            placeholder: 'Enter a story key'
          };
        }
        return {
          canHaveParent: true,
          requiresParent: false,
          label: 'Epic',
          helper:
            mode === 'jira'
              ? 'This item can only belong to an Epic.'
              : 'This item can only belong to an Epic/Feature.',
          emptyText: 'No epic selected.',
          placeholder: 'Leave blank to clear the epic'
        };
      }

      function updateParentField() {
        const issueType = issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value.trim() : '';
        const parentUi = getParentUi(issueType);
        const currentParentKey = parentInput instanceof HTMLInputElement ? parentInput.value.trim() : '';
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
          description: descriptionInput instanceof HTMLTextAreaElement ? descriptionInput.value : '',
          parentKey:
            parentUi.canHaveParent && parentInput instanceof HTMLInputElement ? parentInput.value : ''
        };
      }

      function isDirty() {
        const currentState = readCurrentState();
        return (
          currentState.summary !== initialState.summary ||
          currentState.transitionId !== initialState.transitionId ||
          currentState.issueType !== initialState.issueType ||
          currentState.assignee !== initialState.assignee ||
          currentState.priority !== initialState.priority ||
          currentState.description !== initialState.description ||
          currentState.parentKey !== initialState.parentKey
        );
      }

      function getValidationError() {
        const summary = summaryInput instanceof HTMLInputElement ? summaryInput.value.trim() : '';
        if (summary.length === 0) {
          return 'Summary is required.';
        }
        const issueType = issueTypeSelect instanceof HTMLSelectElement ? issueTypeSelect.value.trim() : '';
        if (issueType.length === 0) {
          return 'Ticket type is required.';
        }
        const priority = prioritySelect instanceof HTMLSelectElement ? prioritySelect.value.trim() : '';
        if (priority.length === 0) {
          return 'Priority is required.';
        }
        const parentUi = getParentUi(issueType);
        const parentKey = parentInput instanceof HTMLInputElement ? parentInput.value.trim() : '';
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
        clearStatusOverride();
        updateParentField();
        refreshActions();
      }

      summaryInput?.addEventListener('input', onFormInput);
      statusSelect?.addEventListener('change', onFormInput);
      issueTypeSelect?.addEventListener('change', onFormInput);
      assigneeInput?.addEventListener('input', onFormInput);
      prioritySelect?.addEventListener('change', onFormInput);
      descriptionInput?.addEventListener('input', onFormInput);
      parentInput?.addEventListener('input', onFormInput);

      editForm.addEventListener('submit', event => {
        event.preventDefault();
        if (saving) {
          return;
        }

        clearStatusOverride();
        const validationError = getValidationError();
        if (validationError) {
          refreshActions();
          return;
        }

        saving = true;
        refreshActions();
        const currentState = readCurrentState();
        vscodeApi.postMessage({
          type: 'saveIssueEdits',
          issueKey: editForm.dataset.issueKey,
          summary: currentState.summary,
          transitionId: currentState.transitionId,
          issueType: currentState.issueType,
          assignee: currentState.assignee,
          priority: currentState.priority,
          description: currentState.description,
          parentKey: currentState.parentKey
        });
      });

      resetButton?.addEventListener('click', () => {
        if (summaryInput instanceof HTMLInputElement) {
          summaryInput.value = initialState.summary;
        }
        if (statusSelect instanceof HTMLSelectElement) {
          statusSelect.value = initialState.transitionId;
        }
        if (issueTypeSelect instanceof HTMLSelectElement) {
          issueTypeSelect.value = initialState.issueType;
        }
        if (assigneeInput instanceof HTMLInputElement) {
          assigneeInput.value = initialState.assignee;
        }
        if (prioritySelect instanceof HTMLSelectElement) {
          prioritySelect.value = initialState.priority;
        }
        if (descriptionInput instanceof HTMLTextAreaElement) {
          descriptionInput.value = initialState.description;
        }
        if (parentInput instanceof HTMLInputElement) {
          parentInput.value = initialState.parentKey;
        }
        clearStatusOverride();
        updateParentField();
        refreshActions();
      });

      handleSaveIssueEditsResult = message => {
        saving = false;
        if (message.ok) {
          initialState = readCurrentState();
          if (statusSelect instanceof HTMLSelectElement) {
            statusSelect.value = '';
          }
          initialState.transitionId = '';
          statusOverride = { text: 'Saved.', kind: 'success' };
        } else {
          statusOverride = {
            text: typeof message.error === 'string' ? message.error : 'Unable to save changes.',
            kind: 'error'
          };
        }
        refreshActions();
      };

      updateParentField();
      refreshActions();
    }

    const commentForm = document.getElementById('commentForm');
    let handleAddIssueCommentResult = undefined;
    if (commentForm instanceof HTMLFormElement) {
      const commentInput = document.getElementById('commentInput');
      const addCommentButton = document.getElementById('addCommentButton');
      const commentStatus = document.getElementById('commentStatus');
      let commentSaving = false;
      let commentOverride = undefined;

      function refreshCommentActions() {
        const body =
          commentInput instanceof HTMLTextAreaElement ? commentInput.value.trim() : '';
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
        const body =
          commentInput instanceof HTMLTextAreaElement ? commentInput.value.trim() : '';
        if (commentSaving || body.length === 0) {
          return;
        }

        commentSaving = true;
        commentOverride = undefined;
        refreshCommentActions();
        vscodeApi.postMessage({
          type: 'addIssueComment',
          issueKey: commentForm.dataset.issueKey,
          body
        });
      });

      handleAddIssueCommentResult = message => {
        commentSaving = false;
        if (message.ok) {
          if (commentInput instanceof HTMLTextAreaElement) {
            commentInput.value = '';
          }
          commentOverride = { text: 'Comment added.', kind: 'success' };
        } else {
          commentOverride = {
            text: typeof message.error === 'string' ? message.error : 'Unable to add comment.',
            kind: 'error'
          };
        }
        refreshCommentActions();
      };

      refreshCommentActions();
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'saveIssueEditsResult' && handleSaveIssueEditsResult) {
        handleSaveIssueEditsResult(message);
        return;
      }
      if (message.type === 'addIssueCommentResult' && handleAddIssueCommentResult) {
        handleAddIssueCommentResult(message);
      }
    });
  </script>
</body>
</html>`;
  }
}
