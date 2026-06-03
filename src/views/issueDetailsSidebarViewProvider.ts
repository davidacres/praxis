import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AiSessionManager } from '../ai/aiSessionManager';
import { AGENT_DEFAULTS } from '../ai/agentTypes';
import type { UpdateIssueInput, AiProvider } from '../types';
import {
  formatParentReference,
  getParentRule,
  getResolvedParentLabel
} from '../issues/issueHierarchy';
import { DetailsViewProvider } from './detailsViewProvider';
import { markdownToHtmlSafe, MARKDOWN_BODY_CSS } from '../ui/markdownToHtml';

interface IssueDetailsSidebarCallbacks {
  onSaveIssueEdits: (
    issueKey: string,
    input: UpdateIssueInput,
    transitionId?: string
  ) => Promise<void>;
  onAddComment: (issueKey: string, body: string) => Promise<void>;
  onRequestAiReview: (issueKey: string) => Promise<void>;
}

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

interface SidebarAiAssignOption {
  provider: AiProvider;
  label: string;
}

export class IssueDetailsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];
  private commentPlaceholder = 'Write a comment (mention @copilot for a reply)';
  private aiAssignOptions: SidebarAiAssignOption[] = [];

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly detailsProvider: DetailsViewProvider,
    private readonly aiSessionManager: AiSessionManager,
    private readonly getAiAgentNames: () => string[],
    private readonly callbacks: IssueDetailsSidebarCallbacks
  ) {
    this.disposables.push(
      this.detailsProvider.onDidChangeTreeData(() => {
        this.render();
      }),
      this.aiSessionManager.onDidChangeSession(({ issueKey }) => {
        if (this.detailsProvider.getActiveIssue()?.key === issueKey) {
          this.render();
        }
      }),
      this.aiSessionManager.onDidChangeAgentSession(record => {
        if (this.detailsProvider.getActiveIssue()?.key === record.issueKey) {
          this.render();
        }
      }),
      this.aiSessionManager.onDidChangeWorkflowAssignment(({ issueKey }) => {
        if (this.detailsProvider.getActiveIssue()?.key === issueKey) {
          this.render();
        }
      })
    );
  }

  public setCommentPlaceholder(text: string): void {
    this.commentPlaceholder = text;
  }

  public setAiAssignOptions(options: SidebarAiAssignOption[]): void {
    this.aiAssignOptions = [...options];
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];

    webviewView.webview.options = {
      enableScripts: true
    };
    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(message => {
        void this.handleMessage(message);
      })
    );
    this.render();
  }

  public dispose(): void {
    this.view = undefined;
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.view || !isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (!type) {
      return;
    }

    if (type === 'refresh') {
      await this.detailsProvider.refresh();
      return;
    }

    if (type === 'saveIssueEdits') {
      const issueKey = asString(message.issueKey);
      const summary = asString(message.summary);
      if (!issueKey || summary === undefined) {
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

      try {
        await this.callbacks.onSaveIssueEdits(issueKey, {
          summary,
          description,
          parentKey: parentKey.trim() || null,
          assignee: assignee.trim() || null,
          priority,
          issueType,
          model,
          severity,
          reportedBy,
          ideaTranscript
        }, transitionId);
        await this.view.webview.postMessage({
          type: 'saveIssueEditsResult',
          ok: true
        });
      } catch (error) {
        await this.view.webview.postMessage({
          type: 'saveIssueEditsResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (type === 'addIssueComment') {
      const issueKey = asString(message.issueKey);
      const body = asString(message.body);
      if (!issueKey || body === undefined) {
        return;
      }

      try {
        await this.callbacks.onAddComment(issueKey, body);
        await this.view.webview.postMessage({
          type: 'addIssueCommentResult',
          ok: true
        });
      } catch (error) {
        await this.view.webview.postMessage({
          type: 'addIssueCommentResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (type === 'unassignAi') {
      const issueKey = asString(message.issueKey);
      if (!issueKey) {
        return;
      }
      await vscode.commands.executeCommand('ticketManager.unassignAi', issueKey);
    }

    if (type === 'viewAgentSession') {
      const issueKey = asString(message.issueKey);
      if (issueKey) {
        await vscode.commands.executeCommand('ticketManager.viewAgentSession', issueKey);
      }
    }

    if (type === 'abortAgentSession') {
      const issueKey = asString(message.issueKey);
      if (issueKey) {
        await vscode.commands.executeCommand('ticketManager.abortAgentSession', issueKey);
      }
    }

    if (type === 'delegateToCopilot') {
      const issueKey = asString(message.issueKey);
      if (issueKey) {
        await vscode.commands.executeCommand('ticketManager.delegateToCopilot', issueKey);
      }
    }

    if (type === 'assignToAi') {
      const issueKey = asString(message.issueKey);
      const provider = asString(message.provider);
      if (issueKey && provider) {
        await vscode.commands.executeCommand('ticketManager.assignToAi', issueKey, provider);
      }
    }

    if (type === 'assignWorkflowPack') {
      const issueKey = asString(message.issueKey);
      if (issueKey) {
        await vscode.commands.executeCommand('ticketManager.assignWorkflowPack', issueKey);
      }
    }

    if (type === 'requestAiReview') {
      const issueKey = asString(message.issueKey);
      if (!issueKey) {
        return;
      }
      try {
        await this.callbacks.onRequestAiReview(issueKey);
        await this.view?.webview.postMessage({ type: 'aiReviewResult', ok: true });
      } catch (error) {
        await this.view?.webview.postMessage({
          type: 'aiReviewResult',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    try {
      const snapshot = this.detailsProvider.getSnapshot();
      const nonce = createNonce();
      let content = '';

      if (!snapshot.selectedIssue) {
        content = '<div class="message">Select an issue to inspect its details.</div>';
      } else if (snapshot.loading && !snapshot.detailedIssue) {
        content = `<div class="message">Loading ${escapeHtml(snapshot.selectedIssue.key)}...</div>`;
      } else if (snapshot.errorMessage) {
        content = `<div class="message error">${escapeHtml(snapshot.errorMessage)}</div>`;
      } else if (!snapshot.detailedIssue) {
        content = '<div class="message">Issue details are unavailable.</div>';
      } else {
        const issue = snapshot.detailedIssue;
        const agentNames = this.getAiAgentNames();
        const parentRule = getParentRule(issue.issueType, this.backendService.mode);
        const resolvedParentLabel = getResolvedParentLabel(
          issue.issueType,
          this.backendService.mode,
          issue.parentIssue
        );
        const parentReference = formatParentReference(issue.parentIssue);
        const readonlyRows = [
          ['Project', issue.projectName ? `${issue.projectKey} • ${issue.projectName}` : issue.projectKey || '—'],
          ['Created', formatDate(issue.created)],
          ['Updated', formatDate(issue.updated)]
        ]
          .map(
            ([label, value]) => `<div class="detail-row">
              <div class="detail-label">${escapeHtml(label)}</div>
              <div class="detail-value detail-value--wrap">${escapeHtml(value)}</div>
            </div>`
          )
          .join('');

        const statusOptions = `<option value="" selected>${escapeHtml(issue.status)}</option>${snapshot.transitions
          .map(
            transition =>
              `<option value="${escapeHtml(transition.id)}">${escapeHtml(
                transition.toStatus ?? transition.name
              )}</option>`
          )
          .join('')}`;
        const issueTypeOptions = renderSelectOptions(issue.issueType, [
          'Epic',
          'Feature',
          'Idea',
          'Story',
          'Task',
          'Subtask',
          'Bug',
          'Issue'
        ]);
        const priorityOptions = renderSelectOptions(issue.priority, [
          'Critical',
          'Highest',
          'High',
          'Medium',
          'Low',
          'Lowest'
        ]);
        const metadataModelOptions = renderSelectOptions(issue.model, [
          'claude-sonnet-4-20250514',
          'claude-opus-4-20250514',
          'gpt-4.1',
          'gpt-4.1-mini',
          'o3',
          'o4-mini'
        ]);
        const severityOptions = renderSelectOptions(issue.severity, [
          'Critical',
          'High',
          'Medium',
          'Low'
        ]);

        const comments = (issue.comments ?? [])
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
        const linkedIssues = (issue.linkedIssues ?? [])
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

        content = `<div class="item-list">
        <div class="issue-header" title="${escapeHtml(`${issue.key}: ${issue.summary}`)}">
          <div class="header-main">
            <div class="item-key">${escapeHtml(issue.key)}</div>
            <button class="icon-button" id="refreshBtn" type="button" title="Refresh" aria-label="Refresh issue details">Refresh</button>
          </div>
        </div>
        <form class="card edit-form" id="issueEditForm" data-issue-key="${escapeHtml(issue.key)}">
          <div class="section-title">Details</div>
          ${readonlyRows}
          <label class="field-group" for="summaryInput">
            <span class="field-label">Summary</span>
            <input
              id="summaryInput"
              class="field-input"
              type="text"
              value="${escapeHtml(issue.summary)}"
              placeholder="Issue summary"
            />
          </label>
          <label class="field-group" for="statusSelect">
            <span class="field-label">Status</span>
            <select id="statusSelect" class="field-select" ${
              snapshot.transitions.length === 0 ? 'disabled' : ''
            }>
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
              list="aiAgentList"
              value="${escapeHtml(issue.assignee ?? '')}"
              placeholder="Enter an assignee or leave blank"
            />
            <datalist id="aiAgentList">
              ${agentNames.map(name => `<option value="${escapeHtml(name)}">`).join('')}
            </datalist>
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
              value="${escapeHtml(issue.reportedBy ?? '')}"
              placeholder="Source or reporter"
            />
          </label>
          <div class="detail-row">
            <div class="detail-label">Branch</div>
            <div class="detail-value detail-value--wrap">${escapeHtml(issue.branch || '—')}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Complexity</div>
            <div class="detail-value detail-value--wrap">${escapeHtml(issue.complexity || '—')}</div>
          </div>
          <div class="field-group">
            <span class="field-label">Description Preview</span>
            <div class="markdown-preview markdown-body${issue.description?.trim() ? '' : ' is-empty'}">${issue.description?.trim()
              ? markdownToHtmlSafe(issue.description)
              : '<p>No description provided.</p>'}</div>
          </div>
          <div
            class="field-group parent-group${parentRule.canHaveParent ? '' : ' is-hidden'}"
            id="parentFieldGroup"
            data-mode="${escapeHtml(this.backendService.mode)}"
            data-initial-parent-key="${escapeHtml(issue.parentKey ?? '')}"
            data-current-parent-type="${escapeHtml(issue.parentIssue?.issueType ?? '')}"
            data-current-parent-summary="${escapeHtml(issue.parentIssue?.summary ?? '')}"
            data-current-parent-description="${escapeHtml(issue.parentIssue?.description ?? '')}"
          >
            <span class="field-label" id="parentFieldLabel">${escapeHtml(resolvedParentLabel)}</span>
            <input
              id="parentInput"
              class="field-input"
              type="text"
              value="${escapeHtml(issue.parentKey ?? '')}"
              placeholder="${escapeHtml(parentRule.placeholder)}"
            />
            <div class="field-help" id="parentFieldHint">${escapeHtml(parentRule.helperText)}</div>
            <div class="parent-preview" id="parentPreview">
              <div class="parent-preview-summary" id="parentPreviewSummary">${escapeHtml(
                parentReference || parentRule.emptyText
              )}</div>
              <div class="parent-preview-description markdown-body${issue.parentIssue?.description ? '' : ' is-hidden'}" id="parentPreviewDescription">${markdownToHtmlSafe(
                issue.parentIssue?.description ?? ''
              )}</div>
            </div>
          </div>
          <label class="field-group" for="descriptionInput">
            <span class="field-label">Description</span>
            <textarea
              id="descriptionInput"
              class="field-textarea"
              placeholder="Add a description"
            >${escapeHtml(issue.description ?? '')}</textarea>
          </label>
          <label class="field-group${issue.issueType.trim().toLowerCase() === 'idea' ? '' : ' is-hidden'}" for="ideaTranscriptInput" id="ideaTranscriptGroup">
            <span class="field-label">AI Research Transcript</span>
            <textarea
              id="ideaTranscriptInput"
              class="field-textarea"
              placeholder="Capture research chat and notes here"
            >${escapeHtml(issue.ideaTranscript ?? '')}</textarea>
            <div class="field-help">Idea tickets keep research here instead of code delivery workflows.</div>
          </label>
          <div class="form-actions">
            <button class="primary-button" id="saveButton" type="submit">Save</button>
            <button class="secondary-button" id="resetButton" type="button">Reset</button>
            <span class="form-status" id="formStatus" aria-live="polite"></span>
          </div>
        </form>
        ${issue.issueType.trim().toLowerCase() === 'idea' ? '' : this.renderAiAssignmentSection(issue.key, agentNames)}
        ${issue.issueType.trim().toLowerCase() === 'idea' ? '' : this.renderWorkflowPackSection(issue.key)}
        ${issue.issueType.trim().toLowerCase() === 'idea' ? '' : this.renderCopilotAgentSection(issue)}
        <div class="card">
          <div class="section-title">Linked Items</div>
          <div class="linked-issue-list">
            ${
              linkedIssues.length > 0
                ? linkedIssues
                : '<div class="comment-empty">No linked Jira items.</div>'
            }
          </div>
        </div>
        <form class="card" id="commentForm" data-issue-key="${escapeHtml(issue.key)}">
          <div class="section-title">Activity</div>
          <div class="comment-list">
            ${
              comments.length > 0
                ? comments
                : '<div class="comment-empty">No activity yet.</div>'
            }
          </div>
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
      </div>`;
      }

      this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root { color-scheme: light dark; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-sideBar-background);
      }
      .page {
        box-sizing: border-box;
        min-height: 100%;
        padding: 10px;
      }
      .item-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .issue-header {
        width: 100%;
        box-sizing: border-box;
        padding: 6px;
        border-radius: 6px;
      }
      .header-main {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .icon-button {
        margin-left: auto;
        border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground));
        padding: 2px 6px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .icon-button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      }
      .item-key {
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      }
      .section-title {
        margin: 0;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--vscode-descriptionForeground);
      }
      .field-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: 11px;
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
        padding: 8px 9px;
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
      .field-textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 7px 9px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
      }
      .field-textarea {
        min-height: 92px;
        resize: vertical;
        font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
        line-height: 1.45;
      }
      .markdown-preview {
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 6px;
        padding: 10px 12px;
        background: var(--vscode-editor-background);
      }
      .markdown-preview.is-empty {
        color: var(--vscode-descriptionForeground);
      }
      .comment-textarea {
        min-height: 76px;
      }
      .field-select {
        width: 100%;
        box-sizing: border-box;
        min-height: 32px;
        padding: 7px 9px;
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
        border-radius: 6px;
        background: var(--vscode-dropdown-background, var(--vscode-input-background));
        color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      }
      .inline-action-row {
        display: flex;
        align-items: center;
        gap: 8px;
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
        padding: 7px 12px;
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
        min-height: 16px;
        font-size: 11px;
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
        grid-template-columns: 84px 1fr;
        gap: 8px;
        align-items: start;
        min-width: 0;
      }
      .detail-row--stacked {
        align-items: start;
      }
      .detail-label {
        min-width: 0;
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
        padding: 1px 6px;
        border: 1px solid transparent;
        border-radius: 999px;
        font-size: 10px;
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
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .detail-pill-list {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .comment-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .comment-item,
      .comment-empty {
        padding: 8px 10px;
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
        line-height: 1.45;
      }
      .linked-issue-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .linked-issue-item {
        padding: 8px 10px;
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
      ${MARKDOWN_BODY_CSS}
      .comment-empty {
        color: var(--vscode-descriptionForeground);
      }
      .message {
        padding: 10px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${content}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      document.getElementById('refreshBtn')?.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'refresh' });
      });

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
          return (value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        }

        function getParentUi(issueType) {
          const normalized = normalizeIssueType(issueType);
          const mode = parentFieldGroup instanceof HTMLElement ? parentFieldGroup.dataset.mode : 'jiracloud';
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
              mode === 'jiracloud'
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
          updateIdeaTranscriptField();
          refreshActions();
        }

        summaryInput?.addEventListener('input', onFormInput);
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
            parentKey: currentState.parentKey
          };
          if (currentState.model !== initialState.model) {
            payload.model = currentState.model;
          }
          if (currentState.severity !== initialState.severity) {
            payload.severity = currentState.severity;
          }
          if (currentState.reportedBy !== initialState.reportedBy) {
            payload.reportedBy = currentState.reportedBy;
          }
          vscodeApi.postMessage(payload);
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
          if (issueModelSelect instanceof HTMLSelectElement) {
            issueModelSelect.value = initialState.model;
          }
          if (severitySelect instanceof HTMLSelectElement) {
            severitySelect.value = initialState.severity;
          }
          if (reportedByInput instanceof HTMLInputElement) {
            reportedByInput.value = initialState.reportedBy;
          }
          if (descriptionInput instanceof HTMLTextAreaElement) {
            descriptionInput.value = initialState.description;
          }
          if (ideaTranscriptInput instanceof HTMLTextAreaElement) {
            ideaTranscriptInput.value = initialState.ideaTranscript || '';
          }
          if (parentInput instanceof HTMLInputElement) {
            parentInput.value = initialState.parentKey;
          }
          clearStatusOverride();
          updateParentField();
          updateIdeaTranscriptField();
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
        updateIdeaTranscriptField();
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

      const unassignAiButton = document.getElementById('unassignAiButton');
      if (unassignAiButton) {
        unassignAiButton.addEventListener('click', () => {
          const issueKey = unassignAiButton.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'unassignAi', issueKey });
          }
        });
      }

      const viewAgentBtn = document.getElementById('viewAgentSessionButton');
      if (viewAgentBtn) {
        viewAgentBtn.addEventListener('click', () => {
          const issueKey = viewAgentBtn.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'viewAgentSession', issueKey });
          }
        });
      }

      const abortAgentBtn = document.getElementById('abortAgentSessionButton');
      if (abortAgentBtn) {
        abortAgentBtn.addEventListener('click', () => {
          const issueKey = abortAgentBtn.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'abortAgentSession', issueKey });
          }
        });
      }

      const delegateBtn = document.getElementById('delegateToAiButton');
      if (delegateBtn) {
        delegateBtn.addEventListener('click', () => {
          const issueKey = delegateBtn.getAttribute('data-issue-key');
          if (issueKey) {
            const selectEl = document.getElementById('aiProviderSelect');
            const provider = (selectEl instanceof HTMLSelectElement ? selectEl.value : null)
              || delegateBtn.getAttribute('data-provider');
            if (provider) {
              vscodeApi.postMessage({ type: 'assignToAi', issueKey, provider });
            } else {
              vscodeApi.postMessage({ type: 'delegateToCopilot', issueKey });
            }
          }
        });
      }

      const assignWorkflowPackButton = document.getElementById('assignWorkflowPackButton');
      if (assignWorkflowPackButton) {
        assignWorkflowPackButton.addEventListener('click', () => {
          const issueKey = assignWorkflowPackButton.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'assignWorkflowPack', issueKey });
          }
        });
      }

      const reviewWithAiButton = document.getElementById('reviewWithAiButton');
      const aiReviewStatus = document.getElementById('aiReviewStatus');
      if (reviewWithAiButton) {
        reviewWithAiButton.addEventListener('click', () => {
          const issueKey = reviewWithAiButton.getAttribute('data-issue-key');
          if (issueKey) {
            reviewWithAiButton.disabled = true;
            if (aiReviewStatus) {
              aiReviewStatus.textContent = 'Sending to AI for review…';
              aiReviewStatus.className = 'form-status';
            }
            vscodeApi.postMessage({ type: 'requestAiReview', issueKey });
          }
        });
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
          return;
        }
        if (message.type === 'aiReviewResult') {
          if (reviewWithAiButton) { reviewWithAiButton.disabled = false; }
          if (aiReviewStatus) {
            if (message.ok) {
              aiReviewStatus.textContent = 'Review added as a comment.';
              aiReviewStatus.className = 'form-status success';
            } else {
              aiReviewStatus.textContent = typeof message.error === 'string' ? message.error : 'AI review failed.';
              aiReviewStatus.className = 'form-status error';
            }
          }
        }
      });
    </script>
  </body>
</html>`;
    } catch (error) {
      const snapshot = this.detailsProvider.getSnapshot();
      const nonce = createNonce();
      const issueKey = snapshot.selectedIssue?.key ?? 'Issue Details';
      const summary = snapshot.selectedIssue?.summary?.trim();
      const message = error instanceof Error ? error.message : String(error);
      this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root { color-scheme: light dark; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-sideBar-background);
      }
      .page {
        box-sizing: border-box;
        min-height: 100%;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .message {
        padding: 10px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
      .issue-key {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="message error">Unable to render issue details: ${escapeHtml(message)}</div>
      <div class="message">
        <div class="issue-key">${escapeHtml(issueKey)}</div>
        ${summary ? `<div>${escapeHtml(summary)}</div>` : ''}
      </div>
    </div>
    <script nonce="${nonce}"></script>
  </body>
</html>`;
    }
  }

  private renderAiAssignmentSection(issueKey: string, agentNames: string[]): string {
    const session = this.aiSessionManager.getSession(issueKey);
    const hasAiProviders = agentNames.length > 0;

    const providerLabels: Record<string, string> = {
      'openai': 'OpenAI',
      'claude': 'Claude',
      'cursor-cli': 'Cursor CLI',
      'copilot-cli': 'GitHub Copilot SDK',
      'claude-cli': 'Claude Code CLI'
    };

    const statusTokenMap: Record<string, string> = {
      active: 'progress',
      completed: 'done',
      failed: 'blocked'
    };

    const reviewButton = hasAiProviders
      ? `<button class="secondary-button" id="reviewWithAiButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Review with AI</button>`
      : '';

    if (!session) {
      return `<div class="card">
        <div class="section-title">AI Assignment</div>
        <div class="comment-empty">No AI agent assigned.</div>
        ${hasAiProviders ? `<div class="form-actions">${reviewButton}</div>` : ''}
        <span class="form-status" id="aiReviewStatus" aria-live="polite"></span>
      </div>`;
    }

    const providerLabel = session.label?.trim() || providerLabels[session.provider] || session.provider;
    const statusToken = statusTokenMap[session.status] ?? 'status';
    const shortSession = escapeHtml(session.sessionId.slice(0, 8));
    const assignedDate = formatDate(session.assignedAt);

    return `<div class="card">
      <div class="section-title">AI Assignment</div>
      <div class="detail-row">
        <div class="detail-label">Agent</div>
        <div class="detail-value">${escapeHtml(providerLabel)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Session</div>
        <div class="detail-value" title="${escapeHtml(session.sessionId)}">${shortSession}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Status</div>
        <div class="detail-value"><span class="pill pill--${statusToken}">${escapeHtml(session.status)}</span></div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Assigned</div>
        <div class="detail-value">${escapeHtml(assignedDate)}</div>
      </div>
      <div class="form-actions">
        <button class="secondary-button" id="unassignAiButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Abandon Session</button>
        ${reviewButton}
      </div>
      <span class="form-status" id="aiReviewStatus" aria-live="polite"></span>
    </div>`;
  }

  private renderCopilotAgentSection(issue: { key: string; assignee?: string }): string {
    const issueKey = issue.key;
    const record = this.aiSessionManager.getAgentSession(issueKey);
    const hasAssignee = Boolean(issue.assignee?.trim());

    const stateTokenMap: Record<string, { token: string; label: string }> = {
      'not_started': { token: 'status', label: 'Not Started' },
      'planning': { token: 'progress', label: 'Planning' },
      'awaiting_approval': { token: 'blocked', label: 'Awaiting Approval' },
      'executing': { token: 'progress', label: 'Executing' },
      'awaiting_input': { token: 'blocked', label: 'Awaiting Input' },
      'paused': { token: 'status', label: 'Paused' },
      'completed': { token: 'done', label: 'Completed' },
      'failed': { token: 'blocked', label: 'Failed' },
      'aborted': { token: 'status', label: 'Aborted' }
    };

    if (!record) {
      const providerSelect = this.aiAssignOptions.length > 1
        ? `<select id="aiProviderSelect" class="field-select">
            ${this.aiAssignOptions.map(opt => `<option value="${escapeHtml(opt.provider)}">${escapeHtml(opt.label)}</option>`).join('')}
          </select>`
        : '';
      const delegateLabel = this.aiAssignOptions.length === 1
        ? `Delegate to ${escapeHtml(this.aiAssignOptions[0].label)}`
        : 'Delegate to AI';
      const delegateDisabled = !hasAssignee;
      const delegateDisabledAttr = delegateDisabled ? ' disabled' : '';
      const delegateDisabledHelp = delegateDisabled
        ? '<div class="field-help">Set the assignee first, then delegate the work to AI.</div>'
        : '';
      return `<div class="card">
        <div class="section-title">AI Agent</div>
        <div class="comment-empty">No agent session.</div>
        <div class="form-actions">
          ${providerSelect}
          <button class="secondary-button" id="delegateToAiButton" type="button" data-issue-key="${escapeHtml(issueKey)}"${this.aiAssignOptions.length === 1 ? ` data-provider="${escapeHtml(this.aiAssignOptions[0].provider)}"` : ''}${delegateDisabledAttr}>${delegateLabel}</button>
        </div>
        ${delegateDisabledHelp}
      </div>`;
    }

    const info = stateTokenMap[record.state] ?? { token: 'status', label: record.state };
    const shortSession = escapeHtml(record.sessionId.slice(0, 8));
    const startDate = record.startedAt ? formatDate(record.startedAt) : '—';
    const isTerminal = record.state === 'completed' || record.state === 'failed' || record.state === 'aborted';

    return `<div class="card">
      <div class="section-title">Copilot Agent</div>
      <div class="detail-row">
        <div class="detail-label">Goal</div>
        <div class="detail-value" title="${escapeHtml(record.taskDefinition.goal)}">${escapeHtml(record.taskDefinition.goal.length > 60 ? record.taskDefinition.goal.slice(0, 60) + '…' : record.taskDefinition.goal)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Session</div>
        <div class="detail-value" title="${escapeHtml(record.sessionId)}">${shortSession}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Status</div>
        <div class="detail-value"><span class="pill pill--${info.token}">${escapeHtml(info.label)}</span></div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Steps</div>
        <div class="detail-value">${record.stepCount}/${record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Started</div>
        <div class="detail-value">${escapeHtml(startDate)}</div>
      </div>
      <div class="form-actions">
        <button class="secondary-button" id="viewAgentSessionButton" type="button" data-issue-key="${escapeHtml(issueKey)}">View Session</button>
        ${!isTerminal ? `<button class="secondary-button" id="abortAgentSessionButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Abort</button>` : ''}
      </div>
    </div>`;
  }

  private renderWorkflowPackSection(issueKey: string): string {
    const assignment = this.aiSessionManager.getIssueWorkflowAssignment(issueKey);
    if (!assignment) {
      return `<div class="card">
        <div class="section-title">Workflow Pack</div>
        <div class="comment-empty">No workflow pack assigned.</div>
        <div class="form-actions">
          <button class="secondary-button" id="assignWorkflowPackButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Assign Workflow Pack</button>
        </div>
      </div>`;
    }

    const sourceLabel = assignment.source === 'automatic'
      ? 'Automatic'
      : assignment.source === 'analysis'
        ? 'Analysis'
        : 'Manual';

    if (!assignment.workflow) {
      // Explicit "No workflow pack" choice — delivery proceeds without a directive.
      return `<div class="card">
        <div class="section-title">Workflow Pack</div>
        <div class="detail-row">
          <div class="detail-label">Name</div>
          <div class="detail-value">No workflow pack (explicitly chosen)</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Source</div>
          <div class="detail-value">${escapeHtml(sourceLabel)}</div>
        </div>
        ${assignment.reason ? `<div class="detail-row">
          <div class="detail-label">Reason</div>
          <div class="detail-value detail-value--wrap">${escapeHtml(assignment.reason)}</div>
        </div>` : ''}
        <div class="form-actions">
          <button class="secondary-button" id="assignWorkflowPackButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Change Workflow Pack</button>
        </div>
      </div>`;
    }

    return `<div class="card">
      <div class="section-title">Workflow Pack</div>
      <div class="detail-row">
        <div class="detail-label">Name</div>
        <div class="detail-value">${escapeHtml(assignment.workflow.name)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Source</div>
        <div class="detail-value">${escapeHtml(sourceLabel)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">File</div>
        <div class="detail-value detail-value--wrap">${escapeHtml(assignment.workflow.instructionsPath)}</div>
      </div>
      ${assignment.reason ? `<div class="detail-row">
        <div class="detail-label">Reason</div>
        <div class="detail-value detail-value--wrap">${escapeHtml(assignment.reason)}</div>
      </div>` : ''}
      <div class="form-actions">
        <button class="secondary-button" id="assignWorkflowPackButton" type="button" data-issue-key="${escapeHtml(issueKey)}">Change Workflow Pack</button>
      </div>
    </div>`;
  }
}

