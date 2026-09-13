import type { Board, BoardDetails, Connection, IssueSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  backendModeMeta,
  boardTypeIcon,
  boardTypeLabel,
  isIssueDone,
  resolveBackendMode,
  statusTone
} from './boardMeta';

interface BoardDetailsPanelProps {
  board: Board;
  details: BoardDetails;
  connection?: Connection;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function isInProgress(issue: IssueSummary): boolean {
  const value = `${normalized(issue.statusCategory)} ${normalized(issue.status)}`;
  return value.includes('progress') || value.includes('indeterminate') || value.includes('review');
}

function countBy(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.trim() || 'Other';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function formatDate(value: string | undefined): string {
  if (!value) return 'Not provided';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function BoardDetailsPanel({ board, details, connection }: BoardDetailsPanelProps) {
  const mode = resolveBackendMode(board.connectionId, connection ? [connection] : []);
  const backend = backendModeMeta(mode);
  const issues = details.issues;
  const total = issues.length;
  const done = issues.filter(isIssueDone).length;
  const inProgress = issues.filter(isInProgress).length;
  const stories = issues.filter(issue => ['story', 'user story'].includes(normalized(issue.issueType))).length;
  const completion = total === 0 ? 0 : Math.round((done / total) * 100);
  const typeCounts = countBy(issues.map(issue => issue.issueType));
  const statusCounts = details.columns.map(column => ({
    label: column.name,
    count: column.issues.length,
    tone: statusTone(column.statusCategory, column.name)
  }));
  const creator = board.createdBy?.trim() || `Not provided by ${backend.label}`;
  const connectionName = connection?.name
    ?? (mode === 'demo' ? 'Built-in demo' : mode === 'app' || mode === 'project' ? 'Praxis local connection' : `${backend.label} connection`);

  return (
    <div className="detail-panel board-details-panel" data-testid="board-details-panel">
      <header className="detail-header board-details-header">
        <Icon name={boardTypeIcon(board)} size={15} />
        <strong>Board details</strong>
      </header>

      <div className="detail-body board-details-body">
        <section className="board-details-identity">
          <Icon className="board-details-icon" name={boardTypeIcon(board)} size={22} />
          <div>
            <h2>{board.name}</h2>
            <div className="board-details-chips">
              <span>{boardTypeLabel(board)}</span>
              {board.projectKey && <span>{board.projectKey}</span>}
            </div>
          </div>
        </section>

        <section className="board-details-section" aria-labelledby="board-about-heading">
          <h3 id="board-about-heading">About</h3>
          <dl className="board-details-meta">
            <div data-testid="board-detail-connection">
              <dt>Connection</dt>
              <dd><Icon name={backend.icon} size={13} /><span><strong>{connectionName}</strong><small>{backend.label}</small></span></dd>
            </div>
            <div>
              <dt>Created by</dt>
              <dd data-testid="board-detail-creator">{creator}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(board.createdAt)}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{board.projectName ?? board.projectKey ?? 'Not assigned'}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd className="board-details-path" title={board.locationName}>{board.locationName ?? 'Not provided'}</dd>
            </div>
          </dl>
        </section>

        <section className="board-details-section" aria-labelledby="board-stats-heading">
          <h3 id="board-stats-heading">Work item stats</h3>
          <div className="board-details-stats">
            <div><strong data-testid="board-stat-total">{total}</strong><span>Total</span></div>
            <div><strong data-testid="board-stat-stories">{stories}</strong><span>Stories</span></div>
            <div><strong>{inProgress}</strong><span>In progress</span></div>
            <div><strong>{done}</strong><span>Done</span></div>
          </div>
          <div className="board-completion">
            <div><span>Completion</span><strong>{completion}%</strong></div>
            <span className="board-completion-track" aria-label={`${completion}% complete`}>
              <i style={{ width: `${completion}%` }} />
            </span>
          </div>
        </section>

        <section className="board-details-section" aria-labelledby="board-status-heading">
          <h3 id="board-status-heading">Status</h3>
          <div className="board-details-breakdown" data-testid="board-status-breakdown">
            {statusCounts.map(status => (
              <div key={status.label}>
                <span><i style={{ background: status.tone }} />{status.label}</span>
                <strong>{status.count}</strong>
                <span className="board-breakdown-track"><i style={{ width: total ? `${(status.count / total) * 100}%` : '0%', background: status.tone }} /></span>
              </div>
            ))}
          </div>
        </section>

        <section className="board-details-section" aria-labelledby="board-types-heading">
          <h3 id="board-types-heading">Item types</h3>
          {typeCounts.length ? (
            <div className="board-details-types">
              {typeCounts.map(type => <span key={type.label}>{type.label}<strong>{type.count}</strong></span>)}
            </div>
          ) : <p className="board-details-empty">No work items yet.</p>}
        </section>
      </div>
    </div>
  );
}
