import { useEffect, useState } from 'react';
import type { IssueDetails } from '@ticket-manager/core';
import { Icon } from './Icon';

export interface IssuePeekProps {
  issueKey: string;
  connectionId?: string;
}

/** Same medium-date/short-time shape the extension's details sidebar uses. */
function formatUpdated(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date
  );
}

/**
 * Compact summary of the selected issue, pinned above the sidebar footer — the
 * desktop counterpart of the extension's issue-details sidebar view. The full
 * editor stays in the aux pane; this card is the at-a-glance peek.
 */
export function IssuePeek({ issueKey, connectionId }: IssuePeekProps) {
  const [issue, setIssue] = useState<IssueDetails | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIssue(null);
    void window.ticketManager.issue
      .get(issueKey, connectionId)
      .then(details => {
        if (!cancelled) {
          setIssue(details);
        }
      })
      .catch(() => {
        // Unresolvable selection (stub backend, stale key) — no card.
        if (!cancelled) {
          setIssue(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [issueKey, connectionId]);

  if (!issue) {
    return null;
  }

  const updated = formatUpdated(issue.updated);
  return (
    <aside className="issue-peek" data-testid="issue-peek" aria-label="Selected issue">
      <div className="issue-peek-header">
        <span className="tree-icon">
          <Icon name="ticket" size={14} />
        </span>
        <span className="issue-peek-key">{issue.key}</span>
        <span className="pill pill--type">{issue.issueType}</span>
      </div>
      <div className="issue-peek-summary">{issue.summary}</div>
      <div className="issue-peek-pills">
        <span className="pill pill--status">{issue.status}</span>
        {issue.priority && <span className="pill pill--priority">{issue.priority}</span>}
      </div>
      {(issue.assignee || updated) && (
        <div className="issue-peek-meta">
          {issue.assignee && <span>{issue.assignee}</span>}
          {issue.assignee && updated && <span aria-hidden="true">·</span>}
          {updated && <span>Updated {updated}</span>}
        </div>
      )}
    </aside>
  );
}
