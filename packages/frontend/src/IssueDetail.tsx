import { useEffect, useState } from 'react';
import type { IssueDetails, UpdateIssueInput } from '@ticket-manager/core';
import { Icon } from './Icon';

interface IssueDetailProps {
  issueKey: string;
  connectionId?: string;
  onClose: () => void;
  onChanged: () => void;
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

export function IssueDetail({ issueKey, connectionId, onClose, onChanged }: IssueDetailProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [commentBody, setCommentBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(emptyDraft);

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

  const beginEdit = () => {
    if (!issue) {
      return;
    }
    setDraft(draftFromIssue(issue));
    setError(undefined);
    setEditing(true);
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
          <h4 style={{ marginBottom: 4, fontSize: 14 }}>{issue.summary}</h4>
          <div className="detail-meta">
            {issue.issueType} · {issue.status} · {issue.projectKey}
          </div>

          {issue.description && (
            <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{issue.description}</p>
          )}

          {error && <div className="error-banner">{error}</div>}

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
