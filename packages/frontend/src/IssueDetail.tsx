import { useEffect, useState } from 'react';
import type { IssueDetails } from '@ticket-manager/core';
import { Icon } from './Icon';

interface IssueDetailProps {
  issueKey: string;
  connectionId?: string;
  onClose: () => void;
  onChanged: () => void;
}

export function IssueDetail({ issueKey, connectionId, onClose, onChanged }: IssueDetailProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [commentBody, setCommentBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reload = () => {
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
  };

  useEffect(() => {
    setIssue(undefined);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey]);

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

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <Icon name="ticket" size={14} />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{issueKey}</h3>
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="detail-body">
      {!issue && <p className="placeholder-text">Loading…</p>}
      {issue && (
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
