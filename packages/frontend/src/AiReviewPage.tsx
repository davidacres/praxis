import { useEffect, useRef, useState } from 'react';
import type { IssueDetails } from '@ticket-manager/core';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

interface AiReviewPageProps {
  issueKey: string;
  connectionId?: string;
  onClose: () => void;
}

/**
 * Full-page AI ticket review — streams the gateway's review markdown as it
 * arrives (via the `ai:reviewProgress` push channel) and can post the final
 * result back to the issue as a comment, like the extension's review command.
 */
export function AiReviewPage({ issueKey, connectionId, onClose }: AiReviewPageProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [content, setContent] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [posted, setPosted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIssue(undefined);
    setContent('');
    setError(undefined);
    setPosted(false);
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
  }, [issueKey, connectionId]);

  // Live markdown stream for this issue's review.
  useEffect(() => {
    const unsubscribe = window.ticketManager.ai.onReviewProgress(progress => {
      if (progress.issueKey !== issueKey) {
        return;
      }
      if (progress.content) {
        setContent(progress.content);
      }
      if (progress.done) {
        setRunning(false);
        if (progress.error) {
          setError(progress.error);
        }
      }
    });
    return unsubscribe;
  }, [issueKey]);

  // Keep the stream pinned to the bottom while it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && running) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content, running]);

  const runReview = async () => {
    setRunning(true);
    setError(undefined);
    setPosted(false);
    setContent('');
    try {
      const markdown = await window.ticketManager.ai.reviewIssue(issueKey, connectionId);
      setContent(markdown);
    } catch (err) {
      // The progress push also carries the error; this covers pre-stream failures.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const postAsComment = async () => {
    if (!content) {
      return;
    }
    setError(undefined);
    try {
      await window.ticketManager.issue.addComment(issueKey, content, connectionId);
      setPosted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ai-tool-page" data-testid="ai-review-page">
      <div className="ai-tool-header">
        <Icon name="robot" size={14} />
        <h3>AI review — {issueKey}</h3>
        <span className="detail-meta">{issue?.summary ?? ''}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn-sm" aria-label="Close review" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ai-tool-actions">
        {!running && (
          <button className="btn" data-testid="ai-review-run" onClick={() => void runReview()}>
            <Icon name="robot" size={13} />
            {content ? 'Run review again' : 'Run review'}
          </button>
        )}
        {running && (
          <button
            className="btn"
            data-testid="ai-review-cancel"
            onClick={() => void window.ticketManager.ai.cancelReview(issueKey)}
          >
            Cancel
          </button>
        )}
        {content && !running && (
          <button
            className="btn"
            data-testid="ai-review-post-comment"
            disabled={posted}
            onClick={() => void postAsComment()}
          >
            <Icon name="check-square" size={13} />
            {posted ? 'Posted as comment' : 'Post as comment'}
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="ai-tool-content" ref={scrollRef}>
        {!content && !running && !error && (
          <p className="placeholder-text">
            Run a review to get AI feedback on this ticket's completeness and clarity.
          </p>
        )}
        {running && !content && <p className="placeholder-text">Review running…</p>}
        {content && <Markdown text={content} testId="ai-review-content" />}
      </div>
    </div>
  );
}
