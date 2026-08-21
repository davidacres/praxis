import { useMemo, useState } from 'react';
import type { BoardColumn, BoardDetails } from '@ticket-manager/core';
import { Icon } from './Icon';
import { statusTone } from './boardMeta';

export interface BoardViewProps {
  details: BoardDetails;
  selectedIssueKey: string | undefined;
  connectionId: string | undefined;
  onOpenIssue: (issueKey: string) => void;
  /**
   * Called when an issue card is dragged from one column onto another. The drop
   * target is identified by `targetStatus` (the column's display name, e.g.
   * "In Progress"). The handler is expected to resolve the matching workflow
   * transition and persist the move; on rejection it should leave the issue in
   * place — the board view just keeps the card where it was.
   */
  onIssueMove: (issueKey: string, targetStatus: string, connectionId: string | undefined) => Promise<void> | void;
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
export function BoardView({
  details,
  selectedIssueKey,
  connectionId,
  onOpenIssue,
  onIssueMove
}: BoardViewProps) {
  // Single dragged key per drag — the dataTransfer is the cross-process source
  // of truth, but we mirror it in state so we can paint the column under the
  // cursor without re-reading .dataTransfer in every dragover event.
  const [draggedKey, setDraggedKey] = useState<string | null>(null);

  /**
   * Reconciles `details.columns` with `details.columnStatusOrder` so empty
   * workflow columns stay visible. The backend (e.g. demoService's
   * buildBoardColumns) only emits columns for statuses that currently hold
   * issues, so dragging everything into "Done" would otherwise make the rest
   * of the workflow vanish. The `columnStatusOrder` field documents the
   * contract that the renderer owns reconciliation — work items are still
   * grouped by their real status; this just fills in zero-issue placeholders
   * in the canonical order so the empty drop targets remain on screen.
   */
  const effectiveColumns = useMemo<BoardColumn[]>(() => {
    const order = details.columnStatusOrder;
    if (!order || order.length === 0) {
      return details.columns;
    }
    const byName = new Map(details.columns.map(column => [column.name, column]));
    const ordered: BoardColumn[] = [];
    for (const name of order) {
      const existing = byName.get(name);
      if (existing) {
        ordered.push(existing);
      } else {
        ordered.push({
          // Stable, synthesised id — keyed by the status name so re-renders
          // after a transition don't remount the column.
          id: `empty-status:${name}`,
          name,
          issues: []
        });
      }
    }
    // Preserve any backend-returned columns that aren't in the canonical order
    // (e.g. custom statuses added to a Jira but not yet folded into the
    // configured workflow). They go after the ordered ones.
    for (const column of details.columns) {
      if (!order.includes(column.name)) {
        ordered.push(column);
      }
    }
    return ordered;
  }, [details.columns, details.columnStatusOrder]);

  if (effectiveColumns.length === 0) {
    return (
      <div className="empty-state" data-testid="board-view">
        <Icon name="columns" size={28} />
        <span>This board has no columns.</span>
      </div>
    );
  }

  return (
    <div className="board-columns" data-testid="board-view">
      {effectiveColumns.map(column => (
        <section key={column.id} className="board-column">
          <header className="board-column-title">
            <span className="column-name">{column.name}</span>
            <span className="column-count">{column.issues.length}</span>
          </header>

          <div
            className="board-column-scroll"
            data-testid="board-column"
            data-target-status={column.name}
            onDragEnter={event => {
              // Entering the column from outside. Fires for every child too, so
              // guard against re-entering from a descendant by checking
              // relatedTarget isn't already inside us.
              if (
                draggedKey !== null &&
                !event.currentTarget.contains(event.relatedTarget as Node | null) &&
                !event.currentTarget.classList.contains('drag-over')
              ) {
                event.currentTarget.classList.add('drag-over');
              }
            }}
            onDragOver={event => {
              // Required to mark the column as a valid drop target; without
              // preventDefault here, the browser cancels the drop immediately.
              if (draggedKey !== null) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDragLeave={event => {
              // Firing for every child makes a naive clear cause flicker; only
              // clear when the drag has now exited the column entirely.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                event.currentTarget.classList.remove('drag-over');
              }
            }}
            onDrop={event => {
              const target = event.currentTarget as HTMLElement;
              target.classList.remove('drag-over');
              const key = event.dataTransfer.getData('text/plain') || draggedKey;
              const targetStatus = target.dataset.targetStatus;
              if (!key || !targetStatus) {
                return;
              }
              // A drop onto the column the card already lives in is a no-op;
              // we still let the browser's `dragend` settle so the ghost
              // returns cleanly.
              const sameColumn = details.columns.find(col => col.issues.some(issue => issue.key === key));
              if (sameColumn?.name === targetStatus) {
                return;
              }
              event.preventDefault();
              void onIssueMove(key, targetStatus, connectionId);
            }}
          >
            {column.issues.map(issue => {
              const tone = statusTone(issue.statusCategory, issue.status);
              return (
                <article
                  key={issue.key}
                  data-testid="issue-card"
                  className={`issue-card${issue.key === selectedIssueKey ? ' active' : ''}`}
                  style={{ borderLeftColor: tone }}
                  draggable={true}
                  onDragStart={event => {
                    // text/plain is what we read back on drop; effectAllowed
                    // 'move' lights up the cursor and tells the OS this is a
                    // move (not a copy). Don't use the issueKey as the id —
                    // Jira keys contain letters/digits only but be defensive.
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', issue.key);
                    setDraggedKey(issue.key);
                    // Selecting the source card makes it visible while a
                    // semi-transparent drag image is being shown.
                    event.currentTarget.classList.add('dragging-from');
                  }}
                  onDragEnd={event => {
                    event.currentTarget.classList.remove('dragging-from');
                    // Drop targets may have been left class-dirty if the
                    // dragend fires before dragleave clears them.
                    document
                      .querySelectorAll('.board-column-scroll.drag-over')
                      .forEach(node => node.classList.remove('drag-over'));
                    setDraggedKey(null);
                  }}
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
