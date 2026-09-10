import type { BoardColumn, BoardColumnPreferences, IssueSummary } from '@praxis/core';

/**
 * Frontend-local helpers for per-board view preferences. These mirror core's
 * `boardIssueFilters`/`swimLanes`/parts of `boardColumnStore` — the frontend
 * imports only types from core, so the small amount of runtime logic those
 * features need lives here.
 */

export const DEFAULT_BOARD_PREFS: BoardColumnPreferences = {
  workflowStatuses: [],
  orderedStatuses: []
};

/** Max-age filter — hides issues not updated within `maxAgeWeeks`; 0/undefined shows all. */
export function filterIssuesByMaxAge(
  issues: IssueSummary[],
  maxAgeWeeks: number | undefined
): IssueSummary[] {
  if (!maxAgeWeeks || maxAgeWeeks <= 0) {
    return issues;
  }
  const cutoff = Date.now() - maxAgeWeeks * 7 * 24 * 60 * 60 * 1000;
  return issues.filter(issue => {
    if (!issue.updated) {
      return true;
    }
    const updatedAt = new Date(issue.updated).getTime();
    return Number.isNaN(updatedAt) || updatedAt >= cutoff;
  });
}

/**
 * The board's effective column order: the user's custom order when one is
 * saved, otherwise the backend's canonical workflow order. Any status that
 * shows up in the data but in neither list is appended by the caller's
 * grouping step, so this only needs to rank the known ones.
 */
export function effectiveStatusOrder(
  columnStatusOrder: readonly string[] | undefined,
  prefs: BoardColumnPreferences
): string[] {
  if (prefs.orderedStatuses.length > 0) {
    return prefs.orderedStatuses;
  }
  return [...(columnStatusOrder ?? [])];
}

/**
 * The set of statuses the board should show. Empty `workflowStatuses` means
 * "everything the backend sends" — the preference only kicks in once the user
 * hides at least one column.
 */
export function visibleStatusSet(prefs: BoardColumnPreferences): Set<string> | undefined {
  return prefs.workflowStatuses.length > 0 ? new Set(prefs.workflowStatuses) : undefined;
}

/** Applies the per-column manual card order; keys not in the saved list keep their fetched order at the end. */
export function applyIssueOrder(
  columns: BoardColumn[],
  issueOrder: Record<string, string[]> | undefined
): BoardColumn[] {
  if (!issueOrder || Object.keys(issueOrder).length === 0) {
    return columns;
  }
  return columns.map(column => {
    const saved = issueOrder[column.name];
    if (!saved || saved.length === 0) {
      return column;
    }
    const rank = new Map(saved.map((key, index) => [key, index]));
    const issues = [...column.issues].sort((left, right) => {
      const leftRank = rank.get(left.key);
      const rightRank = rank.get(right.key);
      if (leftRank === undefined && rightRank === undefined) {
        return 0;
      }
      if (leftRank === undefined) {
        return 1;
      }
      if (rightRank === undefined) {
        return -1;
      }
      return leftRank - rightRank;
    });
    return { ...column, issues };
  });
}

/**
 * Reorders a column's issues into family groups: each parent (any issue
 * another issue's `parentKey` points at) is immediately followed by its own
 * children, each child by its own children in turn — a stable pre-order
 * flatten of the parent/child forest already implied by `parentKey`. An issue
 * whose parent isn't present in this same list (different column, or simply
 * no parent) keeps its incoming position — grouping only ever happens when
 * the family is already sharing a column. Children are ordered by `childSeq`
 * ascending then `key`, so a feature's stories land in authored order;
 * backends with no `childSeq` concept fall back to key order.
 *
 * Applied before `applyIssueOrder` so a user's own manual drag order — which
 * only touches the columns/cards they've actually reordered — still wins;
 * this only supplies the *default* order everything else falls back to.
 */
export function groupIssuesByParent(issues: IssueSummary[]): IssueSummary[] {
  const byKey = new Map(issues.map(issue => [issue.key, issue]));
  const hasParentHere = (issue: IssueSummary): boolean =>
    Boolean(issue.parentKey && issue.parentKey !== issue.key && byKey.has(issue.parentKey));

  const childrenByParent = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    if (!hasParentHere(issue)) {
      continue;
    }
    const bucket = childrenByParent.get(issue.parentKey!) ?? [];
    bucket.push(issue);
    childrenByParent.set(issue.parentKey!, bucket);
  }
  for (const bucket of childrenByParent.values()) {
    // `childSeq` is a per-type counter (a feature's first task and first story
    // are each sequence 1), so it only orders siblings meaningfully within the
    // same issueType — mirrors the core parser's own
    // featureId → issueType → sequence precedence, or a story and a task with
    // the same raw sequence number would interleave with no real meaning.
    bucket.sort(
      (left, right) =>
        left.issueType.localeCompare(right.issueType) ||
        (left.childSeq ?? Number.MAX_SAFE_INTEGER) - (right.childSeq ?? Number.MAX_SAFE_INTEGER) ||
        left.key.localeCompare(right.key)
    );
  }

  const placed = new Set<string>();
  const result: IssueSummary[] = [];
  const place = (issue: IssueSummary): void => {
    // Guards a cyclic parentKey chain (A's parent is B, B's parent is A) —
    // shouldn't occur in real data, but a reorder must never hang or drop cards.
    if (placed.has(issue.key)) {
      return;
    }
    placed.add(issue.key);
    result.push(issue);
    for (const child of childrenByParent.get(issue.key) ?? []) {
      place(child);
    }
  };
  for (const issue of issues) {
    if (!hasParentHere(issue)) {
      place(issue);
    }
  }
  // Only reachable via the cycle case above — every card still has to appear.
  for (const issue of issues) {
    place(issue);
  }
  return result;
}

export interface SwimLane {
  title: string;
  columns: BoardColumn[];
}

function laneTitle(issue: IssueSummary, groupBy: 'assignee' | 'epic'): string {
  if (groupBy === 'assignee') {
    return issue.assignee?.trim() || 'Unassigned';
  }
  if (issue.parentIssue) {
    const summary = issue.parentIssue.summary?.trim();
    return summary ? `${issue.parentIssue.key} — ${summary}` : issue.parentIssue.key;
  }
  if (issue.parentKey?.trim()) {
    return issue.parentKey.trim();
  }
  return 'All others';
}

/**
 * Splits columns into horizontal swim lanes (mirrors core's `buildSwimLaneRows`,
 * adapted to take pre-built columns). Each lane repeats the full column set so
 * every status stays a valid drag target inside every lane.
 */
export function groupIntoSwimLanes(
  columns: BoardColumn[],
  groupBy: 'assignee' | 'epic'
): SwimLane[] {
  const laneSet = new Set<string>();
  for (const column of columns) {
    for (const issue of column.issues) {
      laneSet.add(laneTitle(issue, groupBy));
    }
  }
  if (laneSet.size === 0) {
    return [];
  }
  const last = groupBy === 'assignee' ? 'Unassigned' : 'All others';
  const titles = [...laneSet].sort((a, b) => {
    if (a === last) {
      return 1;
    }
    if (b === last) {
      return -1;
    }
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  return titles.map(title => ({
    title,
    columns: columns.map(column => ({
      ...column,
      issues: column.issues.filter(issue => laneTitle(issue, groupBy) === title)
    }))
  }));
}
