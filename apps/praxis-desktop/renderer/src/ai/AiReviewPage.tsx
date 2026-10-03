import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, AiProvider, IssueDetails } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { isTerminalAgentState } from './aiSessionState';
import { TranscriptAttachments } from './SessionsPage';
import { SessionComposer } from './SessionComposer';
import { GadgetBlockList } from './gadgets';
import { gadgetMessageKey, visibleMessageText } from './gadgets/messageText';
import { useSessionGadgets } from './gadgets/useSessionGadgets';

const REVIEW_COMMENT_MARKER = '<!-- praxis-ai-review:v1 -->';

/** `gadgetId` of the form whose `apply` action writes the review to the ticket (mirrors core's `TICKET_REVIEW_APPLY_GADGET_ID`). */
const APPLY_GADGET_ID = 'review-apply';

function latestAttachedReview(issue: IssueDetails | undefined): string | undefined {
  const comments = issue?.comments ?? [];
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const body = comments[index]?.body ?? '';
    if (body.startsWith(REVIEW_COMMENT_MARKER)) {
      const review = body.slice(REVIEW_COMMENT_MARKER.length).trim();
      if (review) return review;
    }
  }
  return undefined;
}

interface AiReviewPageProps {
  issueKey: string;
  connectionId?: string;
  provider?: AiProvider;
  model?: string;
  sessions?: AgentSessionRecord[];
  onClose: () => void;
  /** Opens the review's session in Sessions, e.g. to answer a permission request. */
  onOpenSession?: (sessionKey: string) => void;
  /** Called after a review changes the ticket, so the boards and detail pane can refetch. */
  onTicketChanged?: () => void;
}

/**
 * Interactive AI ticket review.
 *
 * The review is a real read-only agent session, stored apart from the ticket's
 * own session. It gives a verdict in prose and then asks what to do about each
 * finding as gadgets — pick the findings to apply, answer what only you can
 * decide, review the resulting ticket text — and nothing reaches the tracker
 * until the "Apply to ticket" action on that last form is pressed. Because it
 * is a session, the same conversation is also in Sessions, and a free-text
 * follow-up here is an ordinary turn of it.
 */
export function AiReviewPage({
  issueKey,
  connectionId,
  provider,
  model,
  sessions,
  onClose,
  onOpenSession,
  onTicketChanged
}: AiReviewPageProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [session, setSession] = useState<AgentSessionRecord | undefined>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [posted, setPosted] = useState(false);
  // The review session is stored under its own key, not the ticket's; the host
  // tells us what it is (from `startTicketReview` / `getTicketReview`).
  const sessionKey = session?.issueKey;

  useEffect(() => {
    let cancelled = false;
    setIssue(undefined);
    setSession(undefined);
    setError(undefined);
    setPosted(false);
    void window.praxis.issue.get(issueKey, connectionId).then(loaded => {
      if (!cancelled) setIssue(loaded);
    }).catch(() => undefined);
    void window.praxis.ai.getTicketReview(issueKey).then(existing => {
      if (!cancelled) setSession(existing);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [issueKey, connectionId]);

  // Live updates for this review's session.
  useEffect(() => {
    if (!sessionKey) return;
    const unsubscribe = window.praxis.ai.onSessionChanged(record => {
      if (record.issueKey === sessionKey) setSession(record);
    });
    // A record can change between the snapshot we hold and the subscription
    // above; one fresh read closes that gap.
    void window.praxis.ai.getTicketReview(issueKey).then(latest => {
      if (latest?.issueKey === sessionKey) setSession(latest);
    }).catch(() => undefined);
    return unsubscribe;
  }, [sessionKey, issueKey]);

  const conversationEvents = useMemo(
    () => session?.events.filter(
      event => (event.type === 'message' || event.type === 'user_input_completed') && Boolean(event.detail || event.summary)
    ) ?? [],
    [session?.events]
  );
  const { gadgetBlocks, gadgetResults, busyGadgetId, submitGadgetAction } = useSessionGadgets(session, conversationEvents, { retryUnrenderedGadgets: true });

  // Keep the newest message, gadget or result in view: the apply form lands
  // below the fold of a long review, and its outcome appears under it.
  const threadRef = useRef<HTMLDivElement>(null);
  const resultCount = Object.keys(gadgetResults).length;
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [conversationEvents.length, session?.responseText, resultCount]);

  const running = Boolean(
    session && !isTerminalAgentState(session.state) && session.state !== 'awaiting_approval' && session.state !== 'awaiting_input'
  ) || starting;
  const failed = session?.state === 'failed';

  const firstReviewIndex = conversationEvents.findIndex(event => event.type === 'message');
  const firstReview = firstReviewIndex >= 0
    ? visibleMessageText(conversationEvents[firstReviewIndex].detail ?? conversationEvents[firstReviewIndex].summary ?? '').trim()
    : '';
  const attachedReview = latestAttachedReview(issue);
  const attached = posted || Boolean(firstReview && attachedReview === firstReview);

  const latestMessage = [...conversationEvents].reverse().find(event => event.type === 'message')?.detail;
  const liveText = running && session?.responseText && session.responseText !== latestMessage
    ? visibleMessageText(session.responseText)
    : '';

  // Once a review's apply form has written to the ticket, the ticket on screen
  // and on the boards is stale — refetch, and tell the shell to do the same.
  const applied = gadgetResults[APPLY_GADGET_ID]?.actionId === 'apply' && gadgetResults[APPLY_GADGET_ID]?.status === 'completed'
    ? gadgetResults[APPLY_GADGET_ID].at
    : undefined;
  useEffect(() => {
    if (!applied) return;
    void window.praxis.issue.get(issueKey, connectionId).then(setIssue).catch(() => undefined);
    onTicketChanged?.();
    // `applied` is the timestamp of the completed apply; it is the trigger.
  }, [applied]);

  const runReview = async () => {
    setStarting(true);
    setError(undefined);
    setPosted(false);
    try {
      setSession(await window.praxis.ai.startTicketReview({ issueKey, connectionId, provider, model }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const postAsComment = async () => {
    if (!firstReview) return;
    setError(undefined);
    try {
      await window.praxis.issue.addComment(issueKey, `${REVIEW_COMMENT_MARKER}\n\n${firstReview}`, connectionId);
      setIssue(await window.praxis.issue.get(issueKey, connectionId));
      setPosted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const shownError = error ?? (failed ? (session?.lastError || 'The review stopped before it finished.') : undefined);

  return (
    <div className="ai-tool-page" data-testid="ai-review-page">
      <div className="ai-tool-header">
        <Icon name="robot" size={14} />
        <h3>AI review — {issueKey}</h3>
        <span className="detail-meta">{issue?.summary ?? ''}</span>
        {(session?.provider || session?.model || provider || model) && (
          <span className="detail-meta" data-testid="review-runtime">
            {[session?.provider ?? provider, session?.model ?? model].filter(Boolean).join(' · ')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn-sm" aria-label="Close review" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ai-tool-actions">
        {!running && (
          <button className="btn" data-testid="ai-review-run" onClick={() => void runReview()}>
            <Icon name="robot" size={13} />
            {session ? 'Run review again' : 'Run review'}
          </button>
        )}
        {firstReview && !running && (
          <button
            className="btn"
            data-testid="ai-review-post-comment"
            disabled={attached}
            title="Post the review text to the ticket as a comment"
            onClick={() => void postAsComment()}
          >
            <Icon name="check-square" size={13} />
            {attached ? 'Attached to ticket' : 'Post as comment'}
          </button>
        )}
        {sessionKey && onOpenSession && (
          <button className="btn" data-testid="ai-review-open-session" onClick={() => onOpenSession(sessionKey)}>
            <Icon name="terminal" size={13} />
            Open in Sessions
          </button>
        )}
      </div>

      {shownError && <div className="error-banner" data-testid="ai-review-error">{shownError}</div>}
      <div className="ai-tool-content ai-review-thread" data-testid="ai-review-thread" ref={threadRef}>
        {!session && !starting && !shownError && (
          attachedReview ? (
            <>
              <p className="placeholder-text">A review was posted to this ticket earlier. Run a new one to act on it.</p>
              <Markdown text={attachedReview} testId="ai-review-earlier" />
            </>
          ) : (
            <p className="placeholder-text">
              Run a review to check this ticket's completeness and clarity. You choose which findings go into the
              ticket, and nothing is changed until you apply it.
            </p>
          )
        )}
        {starting && !session && <p className="placeholder-text">Starting review…</p>}

        {conversationEvents.map((event, index) => {
          const text = visibleMessageText(event.detail ?? event.summary ?? '');
          if (event.type === 'user_input_completed') {
            return text || event.attachments?.length ? (
              <div className="ai-review-you" key={`${event.timestamp}-${index}`} data-testid="ai-review-you">
                <span className="ai-review-you-label">You</span>
                <span>{text}<TranscriptAttachments attachments={event.attachments} /></span>
              </div>
            ) : null;
          }
          const blocks = gadgetBlocks[gadgetMessageKey(index)] ?? [];
          if (!text && blocks.length === 0) return null;
          return (
            <div className="ai-review-message" key={`${event.timestamp}-${index}`}>
              {text && <Markdown text={text} testId={index === firstReviewIndex ? 'ai-review-content' : 'ai-review-message'} />}
              <GadgetBlockList
                blocks={blocks}
                busyGadgetId={busyGadgetId}
                results={gadgetResults}
                onSubmit={(gadgetId, actionId, value) => void submitGadgetAction(gadgetId, actionId, value)}
              />
            </div>
          );
        })}

        {liveText && (
          <div className="ai-review-message" data-testid="ai-review-live">
            <Markdown text={liveText} />
          </div>
        )}
        {running && !liveText && session && <p className="placeholder-text">Reviewing…</p>}
      </div>

      {session && (
        <SessionComposer
          key={session.sessionId}
          session={session}
          sessions={sessions}
          options={{
            testId: 'ai-review-followup',
            activityTestId: 'ai-review-activity',
            placeholder: 'Ask the reviewer to clarify, change, or continue…',
            allowModeChange: false,
            allowToolAccessChange: false,
            showWorkflowControl: false,
            allowConversation: false
          }}
        />
      )}
    </div>
  );
}
