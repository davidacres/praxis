import { useMemo, useState } from 'react';
import type { Board, IssueSummary } from '@ticket-manager/core';
import { Icon } from './Icon';

export interface TaskDesignerSidebarProps {
  board: Board;
  issues: IssueSummary[];
  selectedIssueKey?: string;
  onSelectIssue: (issue: IssueSummary) => void;
}

export function TaskDesignerSidebar({
  board,
  issues,
  selectedIssueKey,
  onSelectIssue
}: TaskDesignerSidebarProps) {
  const [query, setQuery] = useState('');
  const visibleIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? issues.filter(issue =>
          `${issue.key} ${issue.summary} ${issue.status} ${issue.issueType}`.toLowerCase().includes(needle)
        )
      : issues;
  }, [issues, query]);

  return (
    <nav className="designer-sidebar" aria-label="Task Designer tickets" data-testid="designer-sidebar">
      <header className="designer-sidebar-header">
        <div className="designer-sidebar-title">
          <Icon name="graph" size={14} />
          <span>Task Designer</span>
        </div>
        <div className="designer-sidebar-board" title={board.name}>{board.name}</div>
      </header>

      <div className="designer-sidebar-search">
        <Icon name="search" size={13} />
        <input
          className="input"
          type="search"
          placeholder="Search board tickets…"
          aria-label="Search designer tickets"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>

      <div className="designer-sidebar-section">
        <span>Board tickets</span>
        <span>{visibleIssues.length}</span>
      </div>

      <div className="designer-sidebar-list">
        {visibleIssues.map(issue => (
          <button
            key={issue.key}
            type="button"
            draggable
            className={`designer-ticket-row${selectedIssueKey === issue.key ? ' active' : ''}`}
            data-testid="designer-sidebar-ticket"
            title="Click for details or drag onto the canvas"
            onClick={() => onSelectIssue(issue)}
            onDragStart={event => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('application/x-ticket-manager-issue', issue.key);
              event.dataTransfer.setData('text/plain', issue.key);
              event.currentTarget.classList.add('is-dragging');
            }}
            onDragEnd={event => event.currentTarget.classList.remove('is-dragging')}
          >
            <span className="tree-icon"><Icon name="ticket" size={14} /></span>
            <span className="designer-ticket-row-body">
              <span className="designer-ticket-row-key">{issue.key}</span>
              <span className="designer-ticket-row-summary">{issue.summary}</span>
              <span className="designer-ticket-row-meta">{issue.issueType} · {issue.status}</span>
            </span>
          </button>
        ))}
        {visibleIssues.length === 0 && (
          <div className="designer-sidebar-empty">
            {issues.length === 0 ? 'This board has no tickets.' : 'No matching tickets.'}
          </div>
        )}
      </div>

      <footer className="designer-sidebar-help">
        <Icon name="info" size={13} />
        <span>Drag a ticket onto the canvas to add it.</span>
      </footer>
    </nav>
  );
}
