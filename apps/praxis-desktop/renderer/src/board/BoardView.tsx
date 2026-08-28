import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardColumn,
  BoardColumnPreferences,
  BoardDetails,
  FilterMetadata,
  IssueFilters,
  IssueSummary
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { statusTone } from './boardMeta';
import type { BoardFilterPresentation, BoardFilterValue } from './BoardFilterBar';
import { BoardSettingsMenu } from './BoardSettingsMenu';
import { useSettings } from '../settings/useSettings';
import {
  DEFAULT_BOARD_PREFS,
  applyIssueOrder,
  effectiveStatusOrder,
  filterIssuesByMaxAge,
  groupIntoSwimLanes,
  visibleStatusSet
} from './boardPreferences';

export interface BoardViewProps {
  details: BoardDetails;
  selectedIssueKey: string | undefined;
  connectionId: string | undefined;
  filters: BoardFilterValue;
  onFilterPresentationChange: (boardId: string, presentation: BoardFilterPresentation) => void;
  onOpenIssue: (issueKey: string) => void;
  /** Opens the create-ticket form for this board. */
  onNewIssue: () => void;
  /**
   * Opens the create-ticket form pre-set to Idea. Rendered only when the
   * `preview.enableCreateIdea` setting is on — mirrors the extension's
   * preview-gated Create Idea command.
   */
  onNewIdea: () => void;
  /**
   * False when the board's backend cannot create tickets (e.g. a live folder
   * connection without `allowIssueCreation`) — the button stays visible but
   * disabled, with `createIssueHint` explaining why.
   */
  canCreateIssue: boolean;
  createIssueHint: string | undefined;
  /**
   * Called when an issue card is dragged from one column onto another. The drop
   * target is identified by `targetStatus` (the column's display name, e.g.
   * "In Progress"). The handler is expected to resolve the matching workflow
   * transition and persist the move; on rejection it should leave the issue in
   * place — the board view just keeps the card where it was.
   */
  onIssueMove: (issueKey: string, targetStatus: string, connectionId: string | undefined) => Promise<void> | void;
  /** Opens this board in the Task Designer canvas. */
  onOpenDesigner: () => void;
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

/** Matches the demo backend's default page size so paging lines up. */
const PAGE_SIZE = 25;

/**
 * Groups a flat, already-sorted issue list into board columns. Mirrors core's
 * `buildBoardColumns` ordered path (frontend imports are type-only, so the
 * grouping lives here): one column per entry of the given status order — empty
 * ones included, so drag targets never vanish — with any status outside the
 * order appended after, lexically.
 */
function groupIssuesIntoColumns(
  issues: IssueSummary[],
  columnStatusOrder: readonly string[] | undefined
): BoardColumn[] {
  const issuesByStatus = new Map<string, IssueSummary[]>();
  const statusCategories = new Map<string, string | undefined>();
  for (const issue of issues) {
    const name = issue.status || 'Unknown';
    const bucket = issuesByStatus.get(name) ?? [];
    bucket.push(issue);
    issuesByStatus.set(name, bucket);
    if (!statusCategories.has(name)) {
      statusCategories.set(name, issue.statusCategory);
    }
  }

  const makeColumn = (name: string): BoardColumn => ({
    // Stable id — keyed by the status name so re-renders after a transition
    // don't remount the column.
    id: `status:${name}`,
    name,
    statusCategory: statusCategories.get(name),
    issues: issuesByStatus.get(name) ?? []
  });

  const order = columnStatusOrder ?? [];
  if (order.length > 0) {
    const ordered = order.map(makeColumn);
    for (const name of issuesByStatus.keys()) {
      if (!order.includes(name)) {
        ordered.push(makeColumn(name));
      }
    }
    return ordered;
  }
  return [...issuesByStatus.keys()].sort((left, right) => left.localeCompare(right)).map(makeColumn);
}

/**
 * Classic mode: one column per board column (or the list-view / swim-lane
 * variants when the board's display preferences ask for them).
 *
 * Cards come from `issue:list` (filtered + paged), not from `board.get`'s
 * pre-built columns — that's what lets the filter bar narrow the board and the
 * load-more button page through the backend's results. `board.get` still
 * supplies the board metadata and the canonical column order.
 *
 * Per-board display preferences (`boardPrefs` IPC) layer on top of the fetched
 * issues: max-age hides stale cards, the workflow set/order picks and arranges
 * columns, `issueOrder` pins manual per-column card order, and the color maps
 * repaint column dots and card accents.
 */
export function BoardView({
  details,
  selectedIssueKey,
  connectionId,
  filters,
  onFilterPresentationChange,
  onOpenIssue,
  onNewIssue,
  onNewIdea,
  canCreateIssue,
  createIssueHint,
  onIssueMove,
  onOpenDesigner
}: BoardViewProps) {
  const boardId = details.board.id;
  const { settings } = useSettings();
  const showNewIdea = settings?.preview.enableCreateIdea === true;
  // Single dragged key per drag — the dataTransfer is the cross-process source
  // of truth, but we mirror it in state so we can paint the column under the
  // cursor without re-reading .dataTransfer in every dragover event.
  const [draggedKey, setDraggedKey] = useState<string | null>(null);

  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | undefined>();
  const [metadata, setMetadata] = useState<FilterMetadata>({ statuses: [], issueTypes: [] });
  const [parentOptions, setParentOptions] = useState<IssueSummary[]>([]);
  const [prefs, setPrefs] = useState<BoardColumnPreferences>(DEFAULT_BOARD_PREFS);
  // Generation counter discards stale responses: a filter change mid-flight
  // must not let the older query overwrite the newer one.
  const generationRef = useRef(0);

  // Display preferences load once per board (App keys this component by board
  // id, so a board switch remounts and re-reads).
  useEffect(() => {
    let cancelled = false;
    window.ticketManager.boardPrefs
      .get(boardId)
      .then(loaded => {
        if (!cancelled) {
          setPrefs(loaded);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  /** Optimistic local apply + fire-and-forget persist; the store prunes empty fields. */
  const updatePrefs = useCallback(
    (next: BoardColumnPreferences) => {
      setPrefs(next);
      window.ticketManager.boardPrefs
        .set(boardId, next)
        .catch((error: unknown) => console.error('Failed to save board preferences:', error));
    },
    [boardId]
  );

  const scopedFilters = useMemo<IssueFilters>(
    () => ({
      projectKeys: details.board.projectKey ? [details.board.projectKey] : [],
      statuses: filters.statuses,
      issueTypes: filters.issueTypes,
      searchText: filters.searchText,
      assigneeMode: filters.assigneeMode,
      parentKey: filters.parentKey,
      boardId,
      grouping: 'none'
    }),
    [details.board.projectKey, boardId, filters]
  );

  // First-page (re)fetch. Also keyed on `details` identity: App refreshes it
  // after transitions/edits, which is exactly when the cards need re-querying.
  useEffect(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setLoadingMore(false);
    setListError(undefined);
    let cancelled = false;
    window.ticketManager.issue
      .list(scopedFilters, 0, PAGE_SIZE, connectionId)
      .then(page => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        setIssues(page.issues);
        setHasMore(page.hasMore);
        setTotal(page.total);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        setListError(error instanceof Error ? error.message : String(error));
        setIssues([]);
        setHasMore(false);
        setTotal(undefined);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopedFilters, connectionId, details]);

  // Filter-bar option sources. Metadata backends ignore the active status/type
  // selection when reporting options (demo clears them internally), so the
  // dropdowns don't collapse while a filter is applied.
  useEffect(() => {
    let cancelled = false;
    window.ticketManager.issue
      .getFilterMetadata(scopedFilters, connectionId)
      .then(meta => {
        if (!cancelled) {
          setMetadata(meta);
        }
      })
      .catch(() => undefined);
    window.ticketManager.issue
      .getParentItems(scopedFilters, undefined, undefined, connectionId)
      .then(items => {
        if (!cancelled) {
          setParentOptions(items);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scopedFilters, connectionId]);

  useEffect(() => {
    onFilterPresentationChange(boardId, {
      statusOptions: metadata.statuses,
      issueTypeOptions: metadata.issueTypes,
      parentOptions,
      shown: issues.length,
      total
    });
  }, [boardId, metadata, parentOptions, issues.length, total, onFilterPresentationChange]);

  const loadMore = useCallback(() => {
    const generation = generationRef.current;
    setLoadingMore(true);
    window.ticketManager.issue
      .list(scopedFilters, issues.length, PAGE_SIZE, connectionId)
      .then(page => {
        if (generation !== generationRef.current) {
          return; // filters changed mid-flight — the reset effect owns state now
        }
        setIssues(current => [...current, ...page.issues]);
        setHasMore(page.hasMore);
        setTotal(page.total);
        setLoadingMore(false);
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) {
          return;
        }
        setListError(error instanceof Error ? error.message : String(error));
        setLoadingMore(false);
      });
  }, [scopedFilters, connectionId, issues.length]);

  // Preference pipeline: fetched issues → max-age → columns in the user's
  // order → hidden columns dropped → manual card order applied.
  const visibleIssues = useMemo(
    () => filterIssuesByMaxAge(issues, prefs.maxAgeWeeks),
    [issues, prefs.maxAgeWeeks]
  );
  const statusOrder = useMemo(
    () => effectiveStatusOrder(details.columnStatusOrder, prefs),
    [details.columnStatusOrder, prefs]
  );
  const effectiveColumns = useMemo<BoardColumn[]>(() => {
    let columns = groupIssuesIntoColumns(visibleIssues, statusOrder);
    const visible = visibleStatusSet(prefs);
    if (visible) {
      columns = columns.filter(column => visible.has(column.name));
    }
    return applyIssueOrder(columns, prefs.issueOrder);
  }, [visibleIssues, statusOrder, prefs]);

  const swimLanes = useMemo(
    () =>
      prefs.viewMode !== 'list' && prefs.swimLaneGroupBy && prefs.swimLaneGroupBy !== 'none'
        ? groupIntoSwimLanes(effectiveColumns, prefs.swimLaneGroupBy)
        : undefined,
    [effectiveColumns, prefs.viewMode, prefs.swimLaneGroupBy]
  );

  /** Persists a manual card order for one column after an in-column drag. */
  const reorderWithinColumn = useCallback(
    (column: BoardColumn, dragged: string, target: string, insertBefore: boolean) => {
      const keys = column.issues.map(issue => issue.key).filter(key => key !== dragged);
      const at = keys.indexOf(target);
      keys.splice(insertBefore || at < 0 ? Math.max(at, 0) : at + 1, 0, dragged);
      updatePrefs({
        ...prefs,
        issueOrder: { ...(prefs.issueOrder ?? {}), [column.name]: keys }
      });
    },
    [prefs, updatePrefs]
  );

  /** Card accent: a custom issue-type color wins over the default status tone. */
  const cardAccent = useCallback(
    (issue: IssueSummary): string =>
      prefs.issueTypeColors?.[issue.issueType] ?? statusTone(issue.statusCategory, issue.status),
    [prefs.issueTypeColors]
  );

  /** Shared drag start/end so board cards and list rows behave identically. */
  const cardDragProps = (issue: IssueSummary) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      // text/plain is what we read back on drop; effectAllowed 'move' lights
      // up the cursor and tells the OS this is a move (not a copy).
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', issue.key);
      setDraggedKey(issue.key);
      event.currentTarget.classList.add('dragging-from');
    },
    onDragEnd: (event: React.DragEvent<HTMLElement>) => {
      event.currentTarget.classList.remove('dragging-from');
      // Drop targets may have been left class-dirty if the dragend fires before
      // dragleave clears them.
      document
        .querySelectorAll('.board-column-scroll.drag-over, .board-list-group.drag-over')
        .forEach(node => node.classList.remove('drag-over'));
      setDraggedKey(null);
    }
  });

  /**
   * Card-level drop: same column → manual reorder (persisted via prefs), and
   * the event stops here; different column → let it bubble to the column
   * container's drop, which runs the workflow transition.
   */
  const cardDropProps = (column: BoardColumn, issue: IssueSummary) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (draggedKey !== null && column.issues.some(candidate => candidate.key === draggedKey)) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const key = event.dataTransfer.getData('text/plain') || draggedKey;
      if (!key || key === issue.key) {
        return;
      }
      if (column.issues.some(candidate => candidate.key === key)) {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        reorderWithinColumn(column, key, issue.key, event.clientY < rect.top + rect.height / 2);
      }
    }
  });

  /** Drop-container handlers shared by board columns and list-view groups. */
  const columnDropProps = (columnName: string) => ({
    'data-target-status': columnName,
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      // Entering the column from outside. Fires for every child too, so guard
      // against re-entering from a descendant by checking relatedTarget isn't
      // already inside us.
      if (
        draggedKey !== null &&
        !event.currentTarget.contains(event.relatedTarget as Node | null) &&
        !event.currentTarget.classList.contains('drag-over')
      ) {
        event.currentTarget.classList.add('drag-over');
      }
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      // Required to mark the column as a valid drop target; without
      // preventDefault here, the browser cancels the drop immediately.
      if (draggedKey !== null) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      // Firing for every child makes a naive clear cause flicker; only clear
      // when the drag has now exited the column entirely.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        event.currentTarget.classList.remove('drag-over');
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const target = event.currentTarget as HTMLElement;
      target.classList.remove('drag-over');
      const key = event.dataTransfer.getData('text/plain') || draggedKey;
      const targetStatus = target.dataset.targetStatus;
      if (!key || !targetStatus) {
        return;
      }
      // A drop onto the column the card already lives in is a no-op; we still
      // let the browser's `dragend` settle so the ghost returns cleanly.
      const sameColumn = effectiveColumns.find(col => col.issues.some(issue => issue.key === key));
      if (sameColumn?.name === targetStatus) {
        return;
      }
      event.preventDefault();
      void onIssueMove(key, targetStatus, connectionId);
    }
  });

  const renderCard = (column: BoardColumn, issue: IssueSummary) => (
    <article
      key={issue.key}
      data-testid="issue-card"
      className={`issue-card${issue.key === selectedIssueKey ? ' active' : ''}`}
      style={{ borderLeftColor: cardAccent(issue) }}
      {...cardDragProps(issue)}
      {...cardDropProps(column, issue)}
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

  const renderColumnHeader = (column: BoardColumn) => (
    <header className="board-column-title">
      <span
        className="board-column-dot"
        data-testid="board-column-dot"
        style={{
          background:
            prefs.statusColors?.[column.name] ?? statusTone(column.statusCategory, column.name)
        }}
      />
      <span className="column-name">{column.name}</span>
      <span className="column-count">{column.issues.length}</span>
    </header>
  );

  const renderColumn = (column: BoardColumn) => (
    <section key={column.id} className="board-column">
      {renderColumnHeader(column)}
      <div
        className="board-column-scroll"
        data-testid="board-column"
        {...columnDropProps(column.name)}
      >
        {column.issues.map(issue => renderCard(column, issue))}
        {column.issues.length === 0 && <div className="column-empty">No work items</div>}
      </div>
    </section>
  );

  const boardColumns = swimLanes ? (
    <div className="board-swimlanes" data-testid="board-swimlanes">
      {swimLanes.map(lane => (
        <div key={lane.title} className="board-swimlane" data-testid="board-swimlane">
          <div className="board-swimlane-title">{lane.title}</div>
          <div className="board-columns">{lane.columns.map(renderColumn)}</div>
        </div>
      ))}
    </div>
  ) : (
    <div className="board-columns">{effectiveColumns.map(renderColumn)}</div>
  );

  const listView = (
    <div className="board-list" data-testid="board-list-view">
      {effectiveColumns.map(column => (
        <section
          key={column.id}
          className="board-list-group"
          data-testid="board-list-group"
          {...columnDropProps(column.name)}
        >
          {renderColumnHeader(column)}
          {column.issues.map(issue => (
            <div
              key={issue.key}
              data-testid="issue-card"
              className={`board-list-row${issue.key === selectedIssueKey ? ' active' : ''}`}
              style={{ borderLeftColor: cardAccent(issue) }}
              {...cardDragProps(issue)}
              {...cardDropProps(column, issue)}
              onClick={() => onOpenIssue(issue.key)}
              role="button"
              tabIndex={0}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  onOpenIssue(issue.key);
                }
              }}
            >
              <span className="issue-card-key">{issue.key}</span>
              <span className="board-list-row-title">{issue.summary}</span>
              <span className="spacer" />
              <span className="issue-card-status">{issue.issueType}</span>
              {issue.assignee && (
                <span className="avatar" title={issue.assignee}>
                  {initials(issue.assignee)}
                </span>
              )}
            </div>
          ))}
          {column.issues.length === 0 && <div className="column-empty">No work items</div>}
        </section>
      ))}
    </div>
  );

  const toolbar = (
    <header className="view-header board-toolbar">
      <div className="board-toolbar-group board-toolbar-left">
        {showNewIdea && (
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            data-testid="board-new-idea-btn"
            aria-label="New idea"
            disabled={!canCreateIssue}
            title={canCreateIssue ? 'Create a new idea ticket on this board' : createIssueHint}
            onClick={onNewIdea}
          >
            <Icon name="lightbulb" size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          data-testid="board-new-issue-btn"
          aria-label="New issue"
          disabled={!canCreateIssue}
          title={canCreateIssue ? 'Create a new ticket on this board' : createIssueHint}
          onClick={onNewIssue}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="board-toolbar-group board-toolbar-right">
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          data-testid="board-designer-btn"
          aria-label="Designer"
          title="Open this board in the Task Designer"
          onClick={onOpenDesigner}
        >
          <Icon name="graph" size={14} />
        </button>
        <BoardSettingsMenu
          prefs={prefs}
          onChange={updatePrefs}
          statusOrder={statusOrder}
          baseStatusOrder={details.columnStatusOrder ?? []}
          issueTypeOptions={metadata.issueTypes}
        />
      </div>
    </header>
  );

  if (effectiveColumns.length === 0 && !loading && !listError) {
    return (
      <div className="board-shell" data-testid="board-view">
        {toolbar}
        <div className="empty-state">
          <Icon name="columns" size={28} />
          <span>This board has no columns.</span>
        </div>
      </div>
    );
  }

  return (
      <div className="board-shell" data-testid="board-view">
        {toolbar}
        {listError && <div className="board-list-error">{listError}</div>}
      {loading && issues.length === 0 && !listError && (
        <div className="empty-state">
          <span>Loading issues…</span>
        </div>
      )}
      {!loading && !listError && issues.length === 0 && total === 0 && (
        <div className="board-filter-empty" data-testid="board-filter-empty">
          No issues match the current filters.
        </div>
      )}
      {!loading && !listError && issues.length > 0 && visibleIssues.length === 0 && (
        <div className="board-filter-empty" data-testid="board-prefs-empty">
          All issues are hidden by this board's max-age preference.
        </div>
      )}
      {prefs.viewMode === 'list' ? listView : boardColumns}
      {hasMore && (
        <div className="board-load-more">
          <button
            type="button"
            className="btn"
            data-testid="board-load-more"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
