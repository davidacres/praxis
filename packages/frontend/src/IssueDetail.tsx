import { useEffect, useState } from 'react';
import type {
  AgentSessionRecord,
  GitLabMergeRequest,
  IssueDetails,
  IssueWorkflowAssignment,
  UpdateIssueInput
} from '@ticket-manager/core';
import { Icon } from './Icon';
import { WorkflowPicker } from './WorkflowPicker';
import {
  agentStateBadgeClass,
  agentStateLabel,
  isTerminalAgentState
} from './aiSessionState';

/** Centre-pane AI tooling views the detail panel can hand off to. */
export type IssueAiView = 'review' | 'analysis' | 'lpr';

interface IssueDetailProps {
  issueKey: string;
  connectionId?: string;
  onClose: () => void;
  onChanged: () => void;
  /** Navigates the panel to another issue (parent chip, sub-task, linked issue). */
  onOpenIssue?: (issueKey: string) => void;
  /** Opens the Sessions view focused on this issue's agent session. */
  onOpenSession?: (issueKey: string) => void;
  /** Opens a full-page AI tool (review / analysis chat) for this issue. */
  onOpenAiView?: (issueKey: string, view: IssueAiView) => void;
}

interface EditDraft {
  summary: string;
  description: string;
  priority: string;
  severity: string;
  assignee: string;
  reportedBy: string;
  model: string;
  ideaTranscript: string;
}

function emptyDraft(): EditDraft {
  return {
    summary: '',
    description: '',
    priority: '',
    severity: '',
    assignee: '',
    reportedBy: '',
    model: '',
    ideaTranscript: ''
  };
}

function draftFromIssue(issue: IssueDetails): EditDraft {
  return {
    summary: issue.summary ?? '',
    description: issue.description ?? '',
    priority: issue.priority ?? '',
    severity: issue.severity ?? '',
    assignee: issue.assignee ?? '',
    reportedBy: issue.reportedBy ?? '',
    model: issue.model ?? '',
    ideaTranscript: issue.ideaTranscript ?? ''
  };
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IssueDetail({ issueKey, connectionId, onClose, onChanged, onOpenIssue, onOpenSession, onOpenAiView }: IssueDetailProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [commentBody, setCommentBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(emptyDraft);
  const [copied, setCopied] = useState(false);
  /** This issue's agent session, if one exists — live via the push channel. */
  const [agentSession, setAgentSession] = useState<AgentSessionRecord | undefined>();
  /** Assigned workflow pack (if any) and the picker modal's visibility. */
  const [workflowAssignment, setWorkflowAssignment] = useState<IssueWorkflowAssignment | undefined>();
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
  /** Merge requests for this issue, loaded on demand (GitLab connections only). */
  const [mergeRequests, setMergeRequests] = useState<GitLabMergeRequest[] | undefined>();
  const [mrError, setMrError] = useState<string | undefined>();

  const reload = () => {
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
  };

  useEffect(() => {
    setIssue(undefined);
    setEditing(false);
    setError(undefined);
    setDraft(emptyDraft());
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey]);

  // Track this issue's agent session: initial pull, then follow push updates
  // for this key so the state chip and abort button stay live.
  useEffect(() => {
    let cancelled = false;
    setAgentSession(undefined);
    void window.ticketManager.ai
      .listSessions()
      .then(sessions => {
        if (!cancelled) {
          setAgentSession(sessions.find(session => session.issueKey === issueKey));
        }
      })
      .catch(() => undefined);
    const unsubscribe = window.ticketManager.ai.onSessionChanged(record => {
      if (record.issueKey === issueKey) {
        setAgentSession(record);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [issueKey]);

  // Workflow-pack assignment for this issue.
  useEffect(() => {
    let cancelled = false;
    setWorkflowAssignment(undefined);
    setMergeRequests(undefined);
    setMrError(undefined);
    void window.ticketManager.ai
      .getWorkflowAssignment(issueKey)
      .then(assignment => {
        if (!cancelled) {
          setWorkflowAssignment(assignment);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [issueKey]);

  const beginEdit = () => {
    if (!issue) {
      return;
    }
    setDraft(draftFromIssue(issue));
    setError(undefined);
    setEditing(true);
  };

  const copyKey = () => {
    void navigator.clipboard
      .writeText(issueKey)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const openInBrowser = (url: string | undefined) => {
    if (url) {
      void window.ticketManager.shell.openExternal(url);
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(undefined);
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = () => {
    const trimmedSummary = draft.summary.trim();
    if (!trimmedSummary) {
      setError('Summary is required.');
      return;
    }

    // Build the update payload from only the fields we render in the form.
    // Empty inputs are omitted so the backend isn't asked to clear a line it
    // doesn't have (e.g. severity on a markdown file with no Severity row).
    const payload: UpdateIssueInput = { summary: trimmedSummary };
    const trimmedDescription = draft.description.trim();
    if (trimmedDescription) {
      payload.description = trimmedDescription;
    }
    if (draft.priority.trim()) {
      payload.priority = draft.priority.trim();
    }
    if (draft.severity.trim()) {
      payload.severity = draft.severity.trim();
    }
    if (draft.assignee.trim()) {
      payload.assignee = draft.assignee.trim();
    }
    if (draft.reportedBy.trim()) {
      payload.reportedBy = draft.reportedBy.trim();
    }
    if (draft.model.trim()) {
      payload.model = draft.model.trim();
    }
    if (issue?.issueType === 'Idea' && draft.ideaTranscript.trim()) {
      payload.ideaTranscript = draft.ideaTranscript.trim();
    }

    void runAction(async () => {
      await window.ticketManager.issue.update(issueKey, payload, connectionId);
      setEditing(false);
    });
  };

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <Icon name="ticket" size={14} />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{issueKey}</h3>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn icon-btn-sm"
          aria-label={copied ? 'Copied' : 'Copy issue key'}
          title={copied ? 'Copied!' : 'Copy issue key'}
          data-testid="issue-copy-key-btn"
          onClick={copyKey}
        >
          <Icon name={copied ? 'check-square' : 'copy'} size={13} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Open in browser"
          title={issue?.browseUrl ? 'Open in browser' : 'No browser link available'}
          data-testid="issue-open-browser-btn"
          onClick={() => openInBrowser(issue?.browseUrl)}
          disabled={!issue?.browseUrl}
        >
          <Icon name="external-link" size={13} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Edit issue"
          data-testid="issue-edit-btn"
          onClick={beginEdit}
          disabled={!issue || editing}
        >
          <Icon name="pencil" size={13} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="detail-body">
      {!issue && <p className="placeholder-text">Loading…</p>}
      {issue && editing && (
        <div data-testid="issue-edit-form">
          {error && <div className="error-banner">{error}</div>}

          <div className="detail-section">
            <div className="detail-section-label">Summary</div>
            <input
              className="input"
              data-testid="issue-edit-summary"
              value={draft.summary}
              onChange={event => setDraft(draft => ({ ...draft, summary: event.target.value }))}
              autoFocus
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Description</div>
            <textarea
              className="textarea"
              data-testid="issue-edit-description"
              value={draft.description}
              onChange={event => setDraft(draft => ({ ...draft, description: event.target.value }))}
              rows={4}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Priority</div>
            <input
              className="input"
              data-testid="issue-edit-priority"
              value={draft.priority}
              onChange={event => setDraft(draft => ({ ...draft, priority: event.target.value }))}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Severity</div>
            <input
              className="input"
              data-testid="issue-edit-severity"
              value={draft.severity}
              onChange={event => setDraft(draft => ({ ...draft, severity: event.target.value }))}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Assignee</div>
            <input
              className="input"
              data-testid="issue-edit-assignee"
              value={draft.assignee}
              onChange={event => setDraft(draft => ({ ...draft, assignee: event.target.value }))}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Reported by</div>
            <input
              className="input"
              data-testid="issue-edit-reportedBy"
              value={draft.reportedBy}
              onChange={event => setDraft(draft => ({ ...draft, reportedBy: event.target.value }))}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          <div className="detail-section">
            <div className="detail-section-label">Model</div>
            <input
              className="input"
              data-testid="issue-edit-model"
              value={draft.model}
              onChange={event => setDraft(draft => ({ ...draft, model: event.target.value }))}
              style={{ marginTop: 6, width: '100%' }}
            />
          </div>

          {issue.issueType === 'Idea' && (
            <div className="detail-section">
              <div className="detail-section-label">Idea transcript</div>
              <textarea
                className="textarea"
                data-testid="issue-edit-ideaTranscript"
                value={draft.ideaTranscript}
                onChange={event => setDraft(draft => ({ ...draft, ideaTranscript: event.target.value }))}
                rows={3}
                style={{ marginTop: 6, width: '100%' }}
              />
            </div>
          )}

          <div className="chip-row" style={{ marginTop: 12, gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn"
              data-testid="issue-edit-cancel-btn"
              disabled={busy}
              onClick={cancelEdit}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="issue-edit-save-btn"
              disabled={busy || !draft.summary.trim()}
              onClick={saveEdit}
            >
              Save
            </button>
          </div>
        </div>
      )}
      {issue && !editing && (
        <>
          {(issue.parentIssue || issue.parentKey) && (
            <div className="detail-meta" style={{ marginBottom: 6 }}>
              <span>Parent: </span>
              {onOpenIssue ? (
                <button
                  className="chip"
                  data-testid="issue-parent-link"
                  title={issue.parentIssue?.summary ?? issue.parentKey}
                  onClick={() => onOpenIssue(issue.parentIssue?.key ?? issue.parentKey ?? '')}
                >
                  {issue.parentIssue?.key ?? issue.parentKey}
                  {issue.parentIssue?.summary ? ` — ${issue.parentIssue.summary}` : ''}
                </button>
              ) : (
                <span data-testid="issue-parent-link">
                  {issue.parentIssue?.key ?? issue.parentKey}
                  {issue.parentIssue?.summary ? ` — ${issue.parentIssue.summary}` : ''}
                </span>
              )}
            </div>
          )}

          <h4 style={{ marginBottom: 4, fontSize: 14 }}>{issue.summary}</h4>
          <div className="detail-meta">
            {issue.issueType} · {issue.status} · {issue.projectKey}
          </div>

          {issue.description && (
            <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{issue.description}</p>
          )}

          {error && <div className="error-banner">{error}</div>}

          {issue.subTasks && issue.subTasks.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-label">Sub-tasks ({issue.subTasks.length})</div>
              <div style={{ marginTop: 6 }}>
                {issue.subTasks.map(subTask => (
                  <div key={subTask.key} className="detail-list-row" data-testid="issue-subtask-row">
                    {onOpenIssue ? (
                      <button
                        className="detail-list-key"
                        title={subTask.summary}
                        onClick={() => onOpenIssue(subTask.key)}
                      >
                        {subTask.key}
                      </button>
                    ) : (
                      <span className="detail-list-key">{subTask.key}</span>
                    )}
                    <span className="detail-list-summary">{subTask.summary}</span>
                    <span className="detail-meta">{subTask.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {issue.linkedIssues && issue.linkedIssues.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-label">Linked issues ({issue.linkedIssues.length})</div>
              <div style={{ marginTop: 6 }}>
                {issue.linkedIssues.map(link => (
                  <div
                    key={`${link.relationship}-${link.key}`}
                    className="detail-list-row"
                    data-testid="issue-linked-row"
                  >
                    <span className="detail-meta" style={{ minWidth: 90 }}>{link.relationship}</span>
                    {onOpenIssue ? (
                      <button
                        className="detail-list-key"
                        title={link.summary ?? link.key}
                        onClick={() => onOpenIssue(link.key)}
                      >
                        {link.key}
                      </button>
                    ) : (
                      <span className="detail-list-key">{link.key}</span>
                    )}
                    <span className="detail-list-summary">{link.summary ?? ''}</span>
                    {link.status && <span className="detail-meta">{link.status}</span>}
                    {link.browseUrl && (
                      <button
                        className="icon-btn icon-btn-sm"
                        aria-label={`Open ${link.key} in browser`}
                        title="Open in browser"
                        onClick={() => openInBrowser(link.browseUrl)}
                      >
                        <Icon name="external-link" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {issue.attachments && issue.attachments.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-label">Attachments ({issue.attachments.length})</div>
              <div style={{ marginTop: 6 }}>
                {issue.attachments.map((attachment, index) => (
                  <div
                    key={attachment.id ?? `${attachment.fileName}-${index}`}
                    className="detail-list-row"
                    data-testid="issue-attachment-row"
                  >
                    <Icon name="paperclip" size={12} />
                    {attachment.contentUrl ? (
                      <button
                        className="detail-list-key"
                        title="Open in browser"
                        onClick={() => openInBrowser(attachment.contentUrl)}
                      >
                        {attachment.fileName}
                      </button>
                    ) : (
                      <span className="detail-list-key">{attachment.fileName}</span>
                    )}
                    {attachment.sizeBytes !== undefined && (
                      <span className="detail-meta">{formatBytes(attachment.sizeBytes)}</span>
                    )}
                    {attachment.author && <span className="detail-meta">{attachment.author}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="detail-section">
            <div className="detail-section-label">Transitions</div>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {issue.transitions?.map(transition => (
                <button
                  key={transition.id}
                  className="chip"
                  disabled={busy}
                  onClick={() =>
                    void runAction(() =>
                      window.ticketManager.issue.transition(issueKey, transition.id, connectionId)
                    )
                  }
                >
                  {transition.name}
                </button>
              ))}
              {!issue.transitions?.length && <span className="placeholder-text">None available.</span>}
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-label">AI agent</div>
            <div style={{ marginTop: 6 }} data-testid="issue-ai-section">
              <div className="workflow-assignment-row" data-testid="workflow-assignment-row">
                <span className="detail-meta" style={{ flex: 1 }} data-testid="workflow-assignment-label">
                  {workflowAssignment?.workflow
                    ? `Workflow pack: ${workflowAssignment.workflow.name}`
                    : 'No workflow pack assigned'}
                </span>
                <button
                  className="chip"
                  data-testid="workflow-assignment-change"
                  onClick={() => setShowWorkflowPicker(true)}
                >
                  Change
                </button>
              </div>

              <div className="chip-row" style={{ margin: '6px 0' }}>
                {onOpenAiView && (
                  <>
                    <button
                      className="chip"
                      data-testid="issue-ai-review-btn"
                      onClick={() => onOpenAiView(issueKey, 'review')}
                    >
                      Review
                    </button>
                    <button
                      className="chip"
                      data-testid="issue-ai-analyze-btn"
                      onClick={() => onOpenAiView(issueKey, 'analysis')}
                    >
                      Analyze
                    </button>
                    <button
                      className="chip"
                      data-testid="issue-ai-lpr-btn"
                      title="Run a local peer review (code + security + verdict)"
                      onClick={() => onOpenAiView(issueKey, 'lpr')}
                    >
                      Peer review
                    </button>
                  </>
                )}
                <button
                  className="chip"
                  data-testid="issue-ai-delivery-btn"
                  disabled={busy}
                  title="Run the delivery workflow (requires delivery settings)"
                  onClick={() =>
                    void runAction(() =>
                      window.ticketManager.ai.startDelivery(issueKey, connectionId).then(() => undefined)
                    )
                  }
                >
                  Start delivery
                </button>
                <button
                  className="chip"
                  data-testid="issue-ai-decompose-btn"
                  disabled={busy}
                  title="Break a feature request into sub-tasks"
                  onClick={() =>
                    void runAction(() =>
                      window.ticketManager.ai.decomposeFeature(issueKey, connectionId).then(() => undefined)
                    )
                  }
                >
                  Decompose
                </button>
              </div>

              {!agentSession && (
                <>
                  <p className="placeholder-text" style={{ margin: '0 0 6px' }}>
                    Hand this issue to the AI agent to plan and execute it.
                  </p>
                  <button
                    className="btn"
                    data-testid="issue-ai-delegate-btn"
                    disabled={busy}
                    onClick={() =>
                      void runAction(() =>
                        window.ticketManager.ai.delegate({ issueKey, connectionId }).then(() => undefined)
                      )
                    }
                  >
                    <Icon name="robot" size={13} />
                    Delegate to AI agent
                  </button>
                </>
              )}
              {agentSession && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      className={agentStateBadgeClass(agentSession.state)}
                      data-testid="issue-ai-state"
                    >
                      {agentStateLabel(agentSession.state)}
                    </span>
                    <span className="detail-meta">
                      {agentSession.stepCount} {agentSession.stepCount === 1 ? 'step' : 'steps'}
                    </span>
                    {agentSession.delivery && (
                      <span className="chip" data-testid="issue-ai-delivery-phase">
                        {agentSession.delivery.phase}
                        {agentSession.delivery.finalizationState !== 'pending' &&
                          ` · ${agentSession.delivery.finalizationState}`}
                      </span>
                    )}
                  </div>
                  {agentSession.delivery?.finalizationMessage && (
                    <p
                      className="detail-meta"
                      data-testid="issue-ai-finalization-message"
                      style={{ margin: '4px 0 0' }}
                    >
                      {agentSession.delivery.finalizationMessage}
                    </p>
                  )}
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {onOpenSession && (
                      <button
                        className="chip"
                        data-testid="issue-ai-view-session"
                        onClick={() => onOpenSession(issueKey)}
                      >
                        View session
                      </button>
                    )}
                    {!isTerminalAgentState(agentSession.state) && (
                      <button
                        className="chip"
                        data-testid="issue-ai-abort-btn"
                        disabled={busy}
                        onClick={() => void runAction(() => window.ticketManager.ai.abort(issueKey))}
                      >
                        Abort
                      </button>
                    )}
                    {isTerminalAgentState(agentSession.state) && (
                      <button
                        className="chip"
                        data-testid="issue-ai-restart-btn"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            window.ticketManager.ai
                              .delegate({ issueKey, connectionId })
                              .then(() => undefined)
                          )
                        }
                      >
                        Run again
                      </button>
                    )}
                  </div>
                </>
              )}

              {agentSession?.delivery?.featureDecomposition && (
                <div data-testid="decomposition-subtasks" style={{ marginTop: 8 }}>
                  <div className="detail-section-label" style={{ marginBottom: 4 }}>
                    Sub-tasks — {agentSession.delivery.featureDecomposition.featureBranch}
                  </div>
                  {[...agentSession.delivery.featureDecomposition.subTasks]
                    .sort((a, b) => a.order - b.order)
                    .map(subTask => (
                      <div key={subTask.issueKey} className="subtask-row" data-testid={`subtask-${subTask.issueKey}`}>
                        <button
                          className="subtask-key"
                          onClick={() => onOpenIssue?.(subTask.issueKey)}
                        >
                          {subTask.issueKey}
                        </button>
                        <span className="subtask-summary">{subTask.summary}</span>
                        <span className="detail-meta">{subTask.deliveryState ?? 'pending'}</span>
                        {(subTask.deliveryState ?? 'pending') === 'pending' && (
                          <button
                            className="chip"
                            data-testid={`subtask-start-${subTask.issueKey}`}
                            disabled={busy}
                            onClick={() =>
                              void runAction(() =>
                                window.ticketManager.ai
                                  .startSubTaskDelivery(issueKey, subTask.issueKey, connectionId)
                                  .then(() => undefined)
                              )
                            }
                          >
                            Start
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              )}

              {connectionId && (
                <div data-testid="issue-mr-section" style={{ marginTop: 8 }}>
                  <div className="chip-row">
                    <button
                      className="chip"
                      data-testid="issue-mr-load-btn"
                      disabled={busy}
                      onClick={() => {
                        setMrError(undefined);
                        void window.ticketManager.ai
                          .listMergeRequests(issueKey, connectionId)
                          .then(setMergeRequests)
                          .catch(err =>
                            setMrError(err instanceof Error ? err.message : String(err))
                          );
                      }}
                    >
                      Merge requests
                    </button>
                    <button
                      className="chip"
                      data-testid="issue-mr-create-btn"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() =>
                          window.ticketManager.ai
                            .createMergeRequest(issueKey, connectionId)
                            .then(created => setMergeRequests(current => [...(current ?? []), created]))
                        )
                      }
                    >
                      Create MR
                    </button>
                    <button
                      className="chip"
                      data-testid="issue-mr-check-btn"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() =>
                          window.ticketManager.ai
                            .checkMergeRequestFeedback(issueKey, connectionId)
                            .then(() => undefined)
                        )
                      }
                    >
                      Check feedback
                    </button>
                  </div>
                  {mrError && <p className="error-banner" data-testid="issue-mr-error">{mrError}</p>}
                  {mergeRequests?.map(mergeRequest => (
                    <div key={mergeRequest.iid} className="subtask-row" data-testid={`mr-${mergeRequest.iid}`}>
                      <button
                        className="subtask-key"
                        onClick={() => openInBrowser(mergeRequest.webUrl)}
                      >
                        !{mergeRequest.iid}
                      </button>
                      <span className="subtask-summary">{mergeRequest.title}</span>
                      <span className="detail-meta">{mergeRequest.state}</span>
                    </div>
                  ))}
                  {mergeRequests?.length === 0 && (
                    <p className="placeholder-text">No merge requests reference {issueKey}.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {showWorkflowPicker && (
            <WorkflowPicker
              current={workflowAssignment?.workflow}
              onClose={() => setShowWorkflowPicker(false)}
              onSelect={workflow => {
                setShowWorkflowPicker(false);
                void window.ticketManager.ai
                  .setWorkflowAssignment(issueKey, workflow)
                  .then(() => window.ticketManager.ai.getWorkflowAssignment(issueKey))
                  .then(setWorkflowAssignment)
                  .catch(err => setError(err instanceof Error ? err.message : String(err)));
              }}
            />
          )}

          <div className="detail-section">
            <div className="detail-section-label">Comments</div>
            <div style={{ marginTop: 6 }}>
              {issue.comments?.map((comment, index) => (
                <div key={comment.id ?? index} className="comment-bubble">
                  <div className="comment-author">{comment.author}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</div>
                </div>
              ))}
              {!issue.comments?.length && <span className="placeholder-text">No comments yet.</span>}
            </div>
            <textarea
              className="textarea"
              value={commentBody}
              onChange={event => setCommentBody(event.target.value)}
              placeholder="Add a comment…"
              rows={3}
              style={{ marginTop: 8 }}
            />
            <button
              className="btn btn-primary"
              style={{ marginTop: 8 }}
              disabled={busy || !commentBody.trim()}
              onClick={() =>
                void runAction(async () => {
                  await window.ticketManager.issue.addComment(issueKey, commentBody, connectionId);
                  setCommentBody('');
                })
              }
            >
              Add comment
            </button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
