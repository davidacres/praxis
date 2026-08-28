import { useCallback, useEffect, useState } from 'react';
import type { AiProvider, IssueDetails, LprResult } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';

interface LocalPeerReviewPageProps {
  issueKey: string;
  connectionId?: string;
  provider?: AiProvider;
  model?: string;
  onClose: () => void;
}

type LprState =
  | { phase: 'running' }
  | { phase: 'done'; result: LprResult }
  | { phase: 'error'; message: string };

type LprMessage = { role: 'user' | 'assistant'; text: string };

/**
 * Local Peer Review — the desktop port of the extension's
 * `localPeerReviewPanel`. Runs the three-pass review (code, security, then a
 * summarizing verdict) via `ai:localPeerReview` and renders each markdown
 * section. Auto-runs on open, mirroring the extension command.
 */
export function LocalPeerReviewPage({ issueKey, connectionId, provider, model, onClose }: LocalPeerReviewPageProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [state, setState] = useState<LprState>({ phase: 'running' });
  const [followUp, setFollowUp] = useState('');
  const [followUps, setFollowUps] = useState<LprMessage[]>([]);
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string>();

  useEffect(() => {
    setIssue(undefined);
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
  }, [issueKey, connectionId]);

  const runReview = useCallback(async () => {
    setState({ phase: 'running' });
    setFollowUps([]);
    setFollowUp('');
    setFollowUpError(undefined);
    try {
      const result = await window.ticketManager.ai.localPeerReview(issueKey, connectionId, provider, model);
      setState({ phase: 'done', result });
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }, [issueKey, connectionId, provider, model]);

  const sendFollowUp = async () => {
    const message = followUp.trim();
    if (!message || state.phase !== 'done' || sendingFollowUp) return;
    setSendingFollowUp(true);
    setFollowUpError(undefined);
    setFollowUps(current => [...current, { role: 'user', text: message }]);
    setFollowUp('');
    try {
      const response = await window.ticketManager.ai.localPeerReviewFollowUp(issueKey, message, connectionId, provider, model);
      setFollowUps(current => [...current, { role: 'assistant', text: response }]);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingFollowUp(false);
    }
  };

  // The extension's LPR panel runs the review as soon as it opens.
  useEffect(() => {
    void runReview();
  }, [runReview]);

  return (
    <div className="ai-tool-page" data-testid="lpr-page">
      <div className="ai-tool-header">
        <Icon name="robot" size={14} />
        <h3>
          Peer review — {issueKey} <span className="lpr-badge">Local Peer Review</span>
        </h3>
        <span className="detail-meta">{issue?.summary ?? ''}</span>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Re-run review"
          title="Re-run review"
          data-testid="lpr-rerun"
          disabled={state.phase === 'running'}
          onClick={() => void runReview()}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Close peer review" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ai-tool-content">
        {issue && (
          <section className="lpr-section" data-testid="lpr-ticket">
            <h4>Ticket details</h4>
            <div className="ticket-meta">
              <span className="ticket-meta-label">Key</span>
              <span className="ticket-meta-value">{issue.key}</span>
              <span className="ticket-meta-label">Type</span>
              <span className="ticket-meta-value">
                <span className="pill pill--type">{issue.issueType}</span>
              </span>
              <span className="ticket-meta-label">Status</span>
              <span className="ticket-meta-value">
                <span className="pill pill--status">{issue.status}</span>
              </span>
              <span className="ticket-meta-label">Priority</span>
              <span className="ticket-meta-value">
                <span className="pill pill--priority">{issue.priority ?? 'Unset'}</span>
              </span>
              <span className="ticket-meta-label">Assignee</span>
              <span className="ticket-meta-value">{issue.assignee ?? 'Unassigned'}</span>
            </div>
            {issue.description?.trim() ? (
              <Markdown text={issue.description} testId="lpr-ticket-description" />
            ) : (
              <em>No description provided.</em>
            )}
          </section>
        )}

        {state.phase === 'running' && (
          <section className="lpr-section">
            <div className="lpr-loading" data-testid="lpr-running">
              <span className="spinner" />
              <span>Running review…</span>
            </div>
          </section>
        )}

        {state.phase === 'error' && (
          <div className="error-banner" data-testid="lpr-error">
            {state.message}
          </div>
        )}

        {state.phase === 'done' && (
          <>
            <section className="lpr-section" data-testid="lpr-summary">
              <h4>Summary &amp; verdict</h4>
              <Markdown text={state.result.summary} />
            </section>
            <section className="lpr-section" data-testid="lpr-code-review">
              <h4>Code review</h4>
              <Markdown text={state.result.codeReview} />
            </section>
            <section className="lpr-section" data-testid="lpr-security-review">
              <h4>Security review</h4>
              <Markdown text={state.result.securityReview} />
            </section>
          </>
        )}
      </div>
      {state.phase === 'done' && (
        <div className="lpr-follow-up" data-testid="lpr-chat-composer">
          {followUps.map((message, index) => (
            <div className={`lpr-follow-up-message ${message.role}`} key={`${message.role}-${index}`}>
              <strong>{message.role === 'user' ? 'You' : 'AI agent'}</strong>
              <Markdown text={message.text} />
            </div>
          ))}
          {followUpError && <div className="error-banner" data-testid="lpr-follow-up-error">{followUpError}</div>}
          <div className="composer lpr-follow-up-composer">
            <textarea
              className="composer-input"
              rows={2}
              data-testid="lpr-follow-up-input"
              value={followUp}
              disabled={sendingFollowUp}
              placeholder="Ask a follow-up about this review…"
              onChange={event => setFollowUp(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && followUp.trim()) {
                  event.preventDefault();
                  void sendFollowUp();
                }
              }}
            />
            <div className="composer-controls">
              <span className="spacer" />
              <button
                className="composer-send"
                type="button"
                aria-label="Send follow-up"
                title="Send follow-up"
                data-testid="lpr-follow-up-send"
                disabled={sendingFollowUp || !followUp.trim()}
                onClick={() => void sendFollowUp()}
              >
                <Icon name="arrow-up" size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
