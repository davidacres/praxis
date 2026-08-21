import type { Board, BoardDetails, Connection, IssueSummary } from '@ticket-manager/core';
import { Icon } from './Icon';
import { backendModeMeta, boardTypeIcon, boardTypeLabel, statusTone } from './boardMeta';

export interface WorkModeViewProps {
  boards: Board[];
  connections: Connection[];
  detailsByBoardId: Record<string, BoardDetails | undefined>;
  onOpenBoard: (board: Board) => void;
  onOpenIssue: (board: Board, issueKey: string) => void;
}

function badgeClass(issue: IssueSummary): string {
  const value = (issue.statusCategory ?? issue.status).toLowerCase();
  if (value.includes('done') || value.includes('complete')) {
    return 'badge badge-done';
  }
  if (value.includes('block')) {
    return 'badge badge-blocked';
  }
  if (value.includes('progress') || value.includes('indeterminate')) {
    return 'badge badge-progress';
  }
  return 'badge';
}

/** Work in flight: anything not sitting in a backlog/done bucket. */
function activeIssues(details: BoardDetails | undefined): IssueSummary[] {
  if (!details) {
    return [];
  }
  return details.issues
    .filter(issue => {
      const value = (issue.statusCategory ?? issue.status).toLowerCase();
      return !value.includes('done') && !value.includes('complete') && !value.includes('backlog');
    })
    .slice(0, 6);
}

/**
 * Board-centric layout: every board is a card, and the work currently in flight
 * on it is nested underneath — the Work Mode idiom from the VS Code extension.
 */
export function WorkModeView({
  boards,
  connections,
  detailsByBoardId,
  onOpenBoard,
  onOpenIssue
}: WorkModeViewProps) {
  if (boards.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="columns" size={28} />
        <span>No boards yet.</span>
      </div>
    );
  }

  return (
    <div className="work-grid" data-testid="work-mode-view">
      {boards.map(board => {
        const connection = connections.find(candidate => candidate.id === board.connectionId);
        const meta = backendModeMeta(connection?.mode ?? (board.connectionId ? undefined : 'demo'));
        const details = detailsByBoardId[board.id];
        const active = activeIssues(details);

        return (
          <article className="work-card" key={board.id} data-testid="work-card">
            <header className="work-card-header">
              <span className="tree-icon" style={{ color: meta.tone }}>
                <Icon name={boardTypeIcon(board)} />
              </span>
              <button
                className="work-card-title"
                style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                onClick={() => onOpenBoard(board)}
              >
                {board.name}
              </button>
              <span className="badge">{boardTypeLabel(board)}</span>
            </header>

            <div className="work-card-body">
              <div className="work-card-meta">
                <Icon name={meta.icon} size={13} />
                <span>{connection?.name ?? meta.label}</span>
                <span>·</span>
                <span>{details ? `${details.issues.length} issues` : 'Loading…'}</span>
              </div>

              {active.length === 0 && <div className="placeholder-text">Nothing in flight.</div>}

              {active.map(issue => (
                <div
                  className="session-row"
                  key={issue.key}
                  onClick={() => onOpenIssue(board, issue.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      onOpenIssue(board, issue.key);
                    }
                  }}
                >
                  <span
                    className="status-dot"
                    style={{ background: statusTone(issue.statusCategory, issue.status) }}
                  />
                  <span className="session-name" title={issue.summary}>
                    {issue.summary}
                  </span>
                  <span className={badgeClass(issue)}>{issue.status}</span>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}
