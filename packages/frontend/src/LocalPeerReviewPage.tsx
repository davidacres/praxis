import { useCallback, useEffect, useState } from 'react';
import type { AiProvider, IssueDetails, LprResult } from '@ticket-manager/core';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

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

/**
 * Local Peer Review — the desktop port of the extension's
 * `localPeerReviewPanel`. Runs the three-pass review (code, security, then a
 * summarizing verdict) via `ai:localPeerReview` and renders each markdown
 * section. Auto-runs on open, mirroring the extension command.
 */
export function LocalPeerReviewPage({ issueKey, connectionId, provider, model, onClose }: LocalPeerReviewPageProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [state, setState] = useState<LprState>({ phase: 'running' });

  useEffect(() => {
    setIssue(undefined);
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
  }, [issueKey, connectionId]);

  const runReview = useCallback(async () => {
    setState({ phase: 'running' });
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
    </div>
  );
}
