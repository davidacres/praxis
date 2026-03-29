import type { BoardColumn, BoardColumnPreferences, BoardDetails, IssueSummary } from '../types';

const DEFAULT_BOARD_STATUS_PREFIX = ['Backlog'] as const;

function sortIssuesByUpdated(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftUpdated = left.updated ?? '';
    const rightUpdated = right.updated ?? '';
    return rightUpdated.localeCompare(leftUpdated) || left.key.localeCompare(right.key);
  });
}

function groupIssuesByStatus(issues: IssueSummary[]): Map<string, IssueSummary[]> {
  const map = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    const status = issue.status?.trim() || 'Unknown';
    const list = map.get(status) ?? [];
    list.push(issue);
    map.set(status, list);
  }
  return map;
}

function normalizeOrderedStatuses(statuses: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    const trimmed = status.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

/**
 * Returns the default column order derived from the board payload (server sort).
 */
export function getDefaultStatusColumnOrder(
  details: BoardDetails,
  workflowOverride?: string[]
): string[] {
  if (workflowOverride?.length) {
    return normalizeOrderedStatuses(workflowOverride);
  }

  if (details.columnStatusOrder?.length) {
    const ordered = normalizeOrderedStatuses([...details.columnStatusOrder]);
    for (let index = DEFAULT_BOARD_STATUS_PREFIX.length - 1; index >= 0; index -= 1) {
      const statusName = DEFAULT_BOARD_STATUS_PREFIX[index];
      if (!ordered.includes(statusName)) {
        ordered.unshift(statusName);
      }
    }
    return ordered;
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const statusName of DEFAULT_BOARD_STATUS_PREFIX) {
    seen.add(statusName);
    ordered.push(statusName);
  }
  for (const col of details.columns) {
    if (!seen.has(col.name)) {
      seen.add(col.name);
      ordered.push(col.name);
    }
  }
  for (const issue of details.issues) {
    const s = issue.status?.trim() || 'Unknown';
    if (!seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  }
  return ordered;
}

function collectStatusCategories(details: BoardDetails): Map<string, string | undefined> {
  const categoryByStatus = new Map<string, string | undefined>();
  for (const col of details.columns) {
    if (!categoryByStatus.has(col.name)) {
      categoryByStatus.set(col.name, col.statusCategory);
    }
  }
  for (const issue of details.issues) {
    const s = issue.status?.trim() || 'Unknown';
    if (!categoryByStatus.has(s)) {
      categoryByStatus.set(s, issue.statusCategory);
    }
  }
  return categoryByStatus;
}

/**
 * Builds status columns for the given order, including columns with zero issues when the status
 * is listed. Issues whose status is not in `orderedStatuses` roll into "Other statuses".
 */
export function buildColumnsForOrderedStatuses(
  details: BoardDetails,
  orderedStatuses: string[]
): BoardDetails {
  if (!orderedStatuses.length) {
    return details;
  }

  const byStatus = groupIssuesByStatus(details.issues);
  const categoryByStatus = collectStatusCategories(details);
  const columns: BoardColumn[] = [];

  for (const statusName of orderedStatuses) {
    const issues = byStatus.get(statusName);
    if (issues) {
      byStatus.delete(statusName);
    }
    columns.push({
      id: `status:${statusName}`,
      name: statusName,
      statusCategory: categoryByStatus.get(statusName),
      issues: sortIssuesByUpdated(issues ?? [])
    });
  }

  const remaining: IssueSummary[] = [];
  for (const list of byStatus.values()) {
    remaining.push(...list);
  }

  if (remaining.length > 0) {
    columns.push({
      id: 'column:other',
      name: 'Other statuses',
      statusCategory: undefined,
      issues: sortIssuesByUpdated(remaining)
    });
  }

  return {
    ...details,
    columns
  };
}

/**
 * Applies saved column visibility/order. Empty `orderedStatuses` uses the default order and still
 * emits a column for each listed status (empty when no issues match).
 */
export function applyBoardColumnPreferences(
  details: BoardDetails,
  prefs: BoardColumnPreferences
): BoardDetails {
  const workflowStatuses = prefs.workflowStatuses.length
    ? normalizeOrderedStatuses(prefs.workflowStatuses)
    : getDefaultStatusColumnOrder(details);
  const orderedStatuses = prefs.orderedStatuses.length
    ? normalizeOrderedStatuses(prefs.orderedStatuses)
    : workflowStatuses;

  return buildColumnsForOrderedStatuses(
    {
      ...details,
      columnStatusOrder: workflowStatuses
    },
    orderedStatuses
  );
}
