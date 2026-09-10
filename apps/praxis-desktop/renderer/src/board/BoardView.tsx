import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { PriorityIndicator } from './PriorityIndicator';
import type { BoardFilterPresentation, BoardFilterValue } from './BoardFilterBar';
import { BoardSettingsMenu } from './BoardSettingsMenu';
import { useSettings } from '../settings/useSettings';
import {
  DEFAULT_BOARD_PREFS,
  applyIssueOrder,
  effectiveStatusOrder,
  filterIssuesByMaxAge,
  groupIntoSwimLanes,
  groupIssuesByParent,
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
   * False when the board's backend cannot create tickets (e.g. a folder
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
  openSettings?: boolean;
  onSettingsOpened?: () => void;
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

/** Compact card metadata, deliberately labelled as an update rather than a due date. */
function formatCardDate(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(value));
}

/** A board should give every workflow stage an equally useful first viewport. */
const COLUMN_PAGE_SIZE = 10;
const ALL_STATUSES_PAGE_KEY = '__all-statuses__';

interface BoardDropPosition {
  status: string;
  beforeKey?: string;
  afterKey?: string;
}

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

interface ColumnHierarchy {
  /** Keys of issues in this column whose parent is also in this column. */
  childKeys: Set<string>;
  /** Parent key → how many of its children are in this column. */
  childCounts: Map<string, number>;
}

/**
 * A card only reads as a child, and a card only shows a children badge, when
 * the *pair* is sharing a column — an issue whose parent sits in a different
 * status keeps its plain card (its existing context chip already names the
 * parent); nesting is a same-column, in-the-moment relationship, not a
 * standing property of the issue.
 */
function columnHierarchy(column: BoardColumn): ColumnHierarchy {
  const keysInColumn = new Set(column.issues.map(issue => issue.key));
  const childKeys = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const issue of column.issues) {
    if (issue.parentKey && issue.parentKey !== issue.key && keysInColumn.has(issue.parentKey)) {
      childKeys.add(issue.key);
      childCounts.set(issue.parentKey, (childCounts.get(issue.parentKey) ?? 0) + 1);
    }
  }
  return { childKeys, childCounts };
}

/**
 * Keeps workflow dividers in a non-scrolling layer above a board canvas. The
 * lanes themselves own the horizontal scroll position, so the overlay measures
 * their current on-screen edges whenever the canvas scrolls or resizes.
 */
function BoardColumnsCanvas({ children, columnCount }: { children: ReactNode; columnCount: number }) {
  const cleanupRef = useRef<(() => void) | undefined>();
  const [dividerOffsets, setDividerOffsets] = useState<number[]>([]);

  const attachFrame = useCallback((frame: HTMLDivElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = undefined;
    if (!frame) {
      return;
    }
    const canvas = frame.querySelector<HTMLDivElement>('.board-columns');
    if (!canvas) {
      return;
    }

    let frameId: number | undefined;
    const refreshDividers = () => {
      const frameLeft = frame.getBoundingClientRect().left;
      const next = [...canvas.querySelectorAll<HTMLElement>('.board-column')]
        .slice(1)
        .map(column => Math.round(column.getBoundingClientRect().left - frameLeft));
      setDividerOffsets(current =>
        current.length === next.length && current.every((value, index) => value === next[index])
          ? current
          : next
      );
    };
    const scheduleRefresh = () => {
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = undefined;
        refreshDividers();
      });
    };

    // The ref callback runs after the canvas is in the DOM. Deferred geometry
    // avoids measuring flex lanes before the browser assigns their widths.
    scheduleRefresh();
    canvas.addEventListener('scroll', scheduleRefresh, { passive: true });
    const observer = new ResizeObserver(scheduleRefresh);
    observer.observe(frame);
    observer.observe(canvas);
    const mutations = new MutationObserver(scheduleRefresh);
    mutations.observe(canvas, { childList: true, subtree: true });
    cleanupRef.current = () => {
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
      }
      canvas.removeEventListener('scroll', scheduleRefresh);
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  return (
    <div ref={attachFrame} className="board-columns-frame" data-column-count={columnCount}>
      <div className="board-columns">
        {children}
      </div>
      <div className="board-column-divider-layer" aria-hidden="true">
        {dividerOffsets.map((left, index) => (
          <span
            key={`${index}:${left}`}
            className="board-column-divider"
            style={{ left }}
            data-testid="board-column-divider"
          />
        ))}
      </div>
    </div>
  );
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
  onOpenDesigner,
  openSettings = false,
  onSettingsOpened
}: BoardViewProps) {
  const boardId = details.board.id;
  const { settings } = useSettings();
  const showNewIdea = settings?.preview.enableCreateIdea === true;
  // Single dragged key per drag — the dataTransfer is the cross-process source
  // of truth, but we mirror it in state so we can paint the column under the
  // cursor without re-reading .dataTransfer in every dragover event.
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<BoardDropPosition | null>(null);

  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [hasMoreByStatus, setHasMoreByStatus] = useState<Record<string, boolean>>({});
  const [nextStartAtByStatus, setNextStartAtByStatus] = useState<Record<string, number>>({});
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
    window.praxis.boardPrefs
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
      window.praxis.boardPrefs
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

  /**
   * Fetch each actual workflow stage independently. A global page limit used
   * to let a busy first stage starve the later stages, which made a board look
   * incomplete. The fallback keeps boards without workflow metadata usable.
   */
  const pagedStatuses = useMemo(() => {
    const available = details.columnStatusOrder?.length
      ? details.columnStatusOrder
      : details.columns.map(column => column.name);
    const requested = filters.statuses.length > 0 ? filters.statuses : available;
    return [...new Set(requested.map(status => status.trim()).filter(Boolean))];
  }, [details.columnStatusOrder, details.columns, filters.statuses]);
  const pageStatuses = useMemo<(string | undefined)[]>(
    () => (pagedStatuses.length > 0 ? pagedStatuses : [undefined]),
    [pagedStatuses]
  );

  // First-page (re)fetch. Also keyed on `details` identity: App refreshes it
  // after transitions/edits, which is exactly when the cards need re-querying.
  useEffect(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setLoadingMore(false);
    setListError(undefined);
    let cancelled = false;
    Promise.all(
      pageStatuses.map(status =>
        window.praxis.issue.list(
          { ...scopedFilters, statuses: status ? [status] : scopedFilters.statuses },
          0,
          COLUMN_PAGE_SIZE,
          connectionId
        )
      )
    )
      .then(pages => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        const nextHasMore: Record<string, boolean> = {};
        const nextStartAt: Record<string, number> = {};
        pageStatuses.forEach((status, index) => {
          const key = status ?? ALL_STATUSES_PAGE_KEY;
          nextHasMore[key] = pages[index].hasMore;
          nextStartAt[key] = pages[index].issues.length;
        });
        setIssues(pages.flatMap(page => page.issues));
        setHasMoreByStatus(nextHasMore);
        setNextStartAtByStatus(nextStartAt);
        setHasMore(pages.some(page => page.hasMore));
        // Some remote backends cannot report a total. Keep the count unknown
        // unless every per-status response can contribute to it.
        setTotal(
          pages.every(page => typeof page.total === 'number')
            ? pages.reduce((sum, page) => sum + (page.total ?? 0), 0)
            : undefined
        );
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        setListError(error instanceof Error ? error.message : String(error));
        setIssues([]);
        setHasMore(false);
        setHasMoreByStatus({});
        setNextStartAtByStatus({});
        setTotal(undefined);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopedFilters, connectionId, details, pageStatuses]);

  // Filter-bar option sources. Metadata backends ignore the active status/type
  // selection when reporting options (demo clears them internally), so the
  // dropdowns don't collapse while a filter is applied.
  useEffect(() => {
    let cancelled = false;
    window.praxis.issue
      .getFilterMetadata(scopedFilters, connectionId)
      .then(meta => {
        if (!cancelled) {
          setMetadata(meta);
        }
      })
      .catch(() => undefined);
    window.praxis.issue
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
    const statusesWithMore = pageStatuses.filter(status => hasMoreByStatus[status ?? ALL_STATUSES_PAGE_KEY]);
    if (statusesWithMore.length === 0) {
      return;
    }
    setLoadingMore(true);
    Promise.all(
      statusesWithMore.map(status => {
        const key = status ?? ALL_STATUSES_PAGE_KEY;
        return window.praxis.issue.list(
          { ...scopedFilters, statuses: status ? [status] : scopedFilters.statuses },
          nextStartAtByStatus[key] ?? 0,
          COLUMN_PAGE_SIZE,
          connectionId
        );
      })
    )
      .then(pages => {
        if (generation !== generationRef.current) {
          return; // filters changed mid-flight — the reset effect owns state now
        }
        const nextHasMore = { ...hasMoreByStatus };
        const nextStartAt = { ...nextStartAtByStatus };
        statusesWithMore.forEach((status, index) => {
          const key = status ?? ALL_STATUSES_PAGE_KEY;
          nextHasMore[key] = pages[index].hasMore;
          nextStartAt[key] = (nextStartAt[key] ?? 0) + pages[index].issues.length;
        });
        setIssues(current => [...current, ...pages.flatMap(page => page.issues)]);
        setHasMoreByStatus(nextHasMore);
        setNextStartAtByStatus(nextStartAt);
        setHasMore(Object.values(nextHasMore).some(Boolean));
        setLoadingMore(false);
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) {
          return;
        }
        setListError(error instanceof Error ? error.message : String(error));
        setLoadingMore(false);
      });
  }, [scopedFilters, connectionId, pageStatuses, hasMoreByStatus, nextStartAtByStatus]);

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
    // Cluster each parent with its own children before any manual per-column
    // order is applied, so a feature's stories default to sitting right under
    // it — a user's own drag order (below) still wins wherever they've set one.
    columns = columns.map(column => ({ ...column, issues: groupIssuesByParent(column.issues) }));
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
      // Native HTML dragging otherwise uses a tiny generic cursor badge. Take
      // a snapshot of the real card so the drag reads as an elevated work item
      // (rather than an opaque browser/OS artefact) on every platform.
      const source = event.currentTarget;
      const preview = source.cloneNode(true) as HTMLElement;
      const sourceRect = source.getBoundingClientRect();
      preview.classList.remove('dragging-from');
      preview.classList.add('issue-card-drag-preview');
      preview.removeAttribute('data-testid');
      preview.removeAttribute('data-issue-key');
      preview.removeAttribute('role');
      preview.removeAttribute('tabindex');
      preview.removeAttribute('draggable');
      preview.style.width = `${Math.round(sourceRect.width)}px`;
      document.body.append(preview);
      event.dataTransfer.setDragImage(preview, Math.min(28, sourceRect.width / 2), 28);
      requestAnimationFrame(() => preview.remove());
      setDraggedKey(issue.key);
      event.currentTarget.classList.add('dragging-from');
    },
    onDragEnd: (event: React.DragEvent<HTMLElement>) => {
      event.currentTarget.classList.remove('dragging-from');
      // Drop targets may have been left class-dirty if the dragend fires before
      // dragleave clears them.
      document
        .querySelectorAll('.board-column.drag-over, .board-list-group.drag-over')
        .forEach(node => node.classList.remove('drag-over'));
      setDraggedKey(null);
      setDropPosition(null);
    }
  });

  const setDropPositionFromPointer = useCallback((column: BoardColumn, target: HTMLElement, clientY: number) => {
    const cards = [...target.querySelectorAll<HTMLElement>('[data-testid="issue-card"]')]
      .filter(card => !card.classList.contains('dragging-from'));
    const next = cards.find(card => clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    const last = cards.at(-1);
    const position: BoardDropPosition = next
      ? { status: column.name, beforeKey: next.dataset.issueKey }
      : last
        ? { status: column.name, afterKey: last.dataset.issueKey }
        : { status: column.name };
    setDropPosition(current =>
      current?.status === position.status &&
      current.beforeKey === position.beforeKey &&
      current.afterKey === position.afterKey
        ? current
        : position
    );
  }, []);

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
        const rect = event.currentTarget.getBoundingClientRect();
        setDropPosition({
          status: column.name,
          ...(event.clientY < rect.top + rect.height / 2 ? { beforeKey: issue.key } : { afterKey: issue.key })
        });
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
        setDropPosition(null);
      }
    }
  });

  /** Drop-container handlers shared by board columns and list-view groups. */
  const columnDropProps = (column: BoardColumn) => ({
    'data-target-status': column.name,
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      if (draggedKey !== null) {
        setDropPositionFromPointer(column, event.currentTarget, event.clientY);
      }
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      // Required to mark the column as a valid drop target; without
      // preventDefault here, the browser cancels the drop immediately.
      if (draggedKey !== null) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropPositionFromPointer(column, event.currentTarget, event.clientY);
      }
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      // Firing for every child makes a naive clear cause flicker; only clear
      // when the drag has now exited the column entirely.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropPosition(current => current?.status === column.name ? null : current);
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const target = event.currentTarget as HTMLElement;
      const key = event.dataTransfer.getData('text/plain') || draggedKey;
      const targetStatus = target.dataset.targetStatus;
      if (!key || !targetStatus) {
        return;
      }
      // A drop onto the column the card already lives in is a no-op; we still
      // let the browser's `dragend` settle so the ghost returns cleanly.
      const sameColumn = effectiveColumns.find(col => col.issues.some(issue => issue.key === key));
      if (sameColumn?.name === targetStatus) {
        setDropPosition(null);
        return;
      }
      event.preventDefault();
      setDropPosition(null);
      void onIssueMove(key, targetStatus, connectionId);
    }
  });

  const renderCard = (column: BoardColumn, issue: IssueSummary, hierarchy: ColumnHierarchy) => {
    const contextAccent = prefs.issueTypeColors?.[issue.issueType] ?? 'var(--accent)';
    const updated = formatCardDate(issue.updated);
    const context = issue.parentIssue?.summary ?? issue.parentKey ?? issue.issueType;
    const isChild = hierarchy.childKeys.has(issue.key);
    const childCount = hierarchy.childCounts.get(issue.key) ?? 0;
    return (
    <article
      key={issue.key}
      data-testid="issue-card"
      data-issue-key={issue.key}
      data-child-of={isChild ? issue.parentKey : undefined}
      className={`issue-card${isChild ? ' issue-card-child' : ''}${childCount > 0 ? ' issue-card-parent' : ''}${issue.key === selectedIssueKey ? ' active' : ''}`}
      style={{ '--issue-card-accent': contextAccent } as CSSProperties}
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
      <div className="issue-card-meta">
        <span className="issue-card-context" title={context}>{context}</span>
        {issue.parentIssue && <span className="issue-card-type">{issue.issueType}</span>}
        {childCount > 0 && (
          <span
            className="issue-card-child-count"
            data-testid="issue-card-child-count"
            title={`${childCount} linked ${childCount === 1 ? 'ticket' : 'tickets'} shown below`}
          >
            <Icon name="git-branch" size={11} /> {childCount}
          </span>
        )}
      </div>
      {updated && (
        <div className="issue-card-details">
          <span title={`Updated ${updated}`}><Icon name="calendar" size={12} /> Updated {updated}</span>
        </div>
      )}
      <div className="issue-card-foot">
        <Icon className="issue-card-key-icon" name="check-square" size={13} />
        <span className="issue-card-key">{issue.key}</span>
        <span className="spacer" />
        {issue.priority && <PriorityIndicator priority={issue.priority} />}
        {issue.assignee && (
          <span className="avatar" title={issue.assignee}>
            {initials(issue.assignee)}
          </span>
        )}
      </div>
    </article>
    );
  };

  const renderColumnHeader = (column: BoardColumn) => (
    <header className="board-column-title" data-testid="board-column-header">
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

  const renderColumn = (column: BoardColumn) => {
    const hierarchy = columnHierarchy(column);
    return (
    <section
      key={column.id}
      className="board-column"
      data-testid="board-column-lane"
      {...columnDropProps(column)}
    >
      {renderColumnHeader(column)}
      <div
        className="board-column-scroll"
        data-testid="board-column"
      >
        {column.issues.map(issue => (
          <span key={issue.key} className="board-card-slot">
            {dropPosition?.status === column.name && dropPosition.beforeKey === issue.key && <span className="board-drop-indicator" data-testid="board-drop-indicator" aria-hidden="true" />}
            {renderCard(column, issue, hierarchy)}
            {dropPosition?.status === column.name && dropPosition.afterKey === issue.key && <span className="board-drop-indicator" data-testid="board-drop-indicator" aria-hidden="true" />}
          </span>
        ))}
        {column.issues.length === 0 && (
          dropPosition?.status === column.name
            ? <span className="board-drop-indicator board-drop-indicator-empty" data-testid="board-drop-indicator" aria-hidden="true" />
            : <div className="column-empty">Drop work here</div>
        )}
      </div>
    </section>
    );
  };

  const boardColumns = swimLanes ? (
    <div className="board-swimlanes" data-testid="board-swimlanes">
      {swimLanes.map(lane => (
        <div key={lane.title} className="board-swimlane" data-testid="board-swimlane">
          <div className="board-swimlane-title">{lane.title}</div>
          <BoardColumnsCanvas columnCount={lane.columns.length}>{lane.columns.map(renderColumn)}</BoardColumnsCanvas>
        </div>
      ))}
    </div>
  ) : (
    <BoardColumnsCanvas columnCount={effectiveColumns.length}>{effectiveColumns.map(renderColumn)}</BoardColumnsCanvas>
  );

  const listView = (
    <div className="board-list" data-testid="board-list-view">
      {effectiveColumns.map(column => {
        const hierarchy = columnHierarchy(column);
        return (
        <section
          key={column.id}
          className="board-list-group"
          data-testid="board-list-group"
          {...columnDropProps(column)}
        >
          {renderColumnHeader(column)}
          {column.issues.map(issue => {
            const isChild = hierarchy.childKeys.has(issue.key);
            const childCount = hierarchy.childCounts.get(issue.key) ?? 0;
            return (
            <div
              key={issue.key}
              data-testid="issue-card"
              data-child-of={isChild ? issue.parentKey : undefined}
              className={`board-list-row${isChild ? ' board-list-row-child' : ''}${childCount > 0 ? ' board-list-row-parent' : ''}${issue.key === selectedIssueKey ? ' active' : ''}`}
              style={{ borderLeftColor: childCount > 0 ? 'var(--border-strong)' : cardAccent(issue) }}
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
              {childCount > 0 && (
                <span
                  className="issue-card-child-count"
                  data-testid="issue-card-child-count"
                  title={`${childCount} linked ${childCount === 1 ? 'ticket' : 'tickets'} shown below`}
                >
                  <Icon name="git-branch" size={11} /> {childCount}
                </span>
              )}
              <span className="spacer" />
              <span className="issue-card-status">{issue.issueType}</span>
              {issue.assignee && (
                <span className="avatar" title={issue.assignee}>
                  {initials(issue.assignee)}
                </span>
              )}
            </div>
            );
          })}
          {column.issues.length === 0 && <div className="column-empty">No work items</div>}
        </section>
        );
      })}
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
          open={openSettings}
          onOpenChange={value => { if (!value) onSettingsOpened?.(); }}
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
      <div className="board-shell" data-testid="board-view" data-plain-surface={prefs.plainSurface ? '' : undefined}>
        {toolbar}
        <div className="empty-state">
          <Icon name="columns" size={28} />
          <span>This board has no columns.</span>
        </div>
      </div>
    );
  }

  return (
      <div className="board-shell" data-testid="board-view" data-plain-surface={prefs.plainSurface ? '' : undefined}>
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
