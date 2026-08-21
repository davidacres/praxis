import type { BoardDetails } from '@ticket-manager/core';
import { Icon } from './Icon';
import { statusTone } from './boardMeta';

export interface BoardViewProps {
  details: BoardDetails;
  selectedIssueKey: string | undefined;
  onOpenIssue: (issueKey: string) => void;
}

/** Two initials, so the assignee avatar reads the way a tracker's does. */
function initials(name: string | undefined): string {
  if (!name) {
    return '?';
  }
  const parts = name.trim().split(/\s+/);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Classic mode: one column per board column.
 *
 * The columns are the scroll containers, not the page — each fills the pane's
 * full height and scrolls its own cards, so the headers stay put and a long
 * column never stretches the board past the viewport.
 */
export function BoardView({ details, selectedIssueKey, onOpenIssue }: BoardViewProps) {
  if (details.columns.length === 0) {
    return (
      <div className="empty-state" data-testid="board-view">
        <Icon name="columns" size={28} />
        <span>This board has no columns.</span>
      </div>
    );
  }

  return (
    <div className="board-columns" data-testid="board-view">
      {details.columns.map(column => (
        <section key={column.id} className="board-column">
          <header className="board-column-title">
            <span className="column-name">{column.name}</span>
            <span className="column-count">{column.issues.length}</span>
          </header>

          <div className="board-column-scroll">
            {column.issues.map(issue => {
              const tone = statusTone(issue.statusCategory, issue.status);
              return (
                <article
                  key={issue.key}
                  data-testid="issue-card"
                  className={`issue-card${issue.key === selectedIssueKey ? ' active' : ''}`}
                  style={{ borderLeftColor: tone }}
                  onClick={() => onOpenIssue(issue.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      onOpenIssue(issue.key);
                    }
                  }}
                >
                  <div className="issue-card-title">{issue.summary}</div>
                  <div className="issue-card-status">{issue.status}</div>
                  <div className="issue-card-foot">
                    <Icon name="ticket" size={13} />
                    <span className="issue-card-key">{issue.key}</span>
                    <span className="spacer" />
                    {issue.assignee && (
                      <span className="avatar" title={issue.assignee}>
                        {initials(issue.assignee)}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
            {column.issues.length === 0 && <div className="column-empty">No work items</div>}
          </div>
        </section>
      ))}
    </div>
  );
}
