import type { BoardColumn, IssueSummary } from '../types';

/**
 * Shared column-building helpers used by every backend that needs to project a
 * flat list of issues onto the columns shown by the board UI.
 *
 * Backends (demo, jira, …) historically emitted one column per status that
 * currently held at least one issue, leaving the board empty when the user
 * dragged every ticket into a single status. With {@link buildBoardColumns}
 * backends now emit one column per canonical workflow status (provided via
 * `columnStatusOrder`), plus a fall-back sorted-by-rank path for callers that
 * have not yet adopted the canonical-order field.
 */

/** Sorts issues by most recently updated first, breaking ties by key ascending. */
export function sortIssuesByUpdated(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftUpdated = left.updated ?? '';
    const rightUpdated = right.updated ?? '';
    return rightUpdated.localeCompare(leftUpdated) || left.key.localeCompare(right.key);
  });
}

/**
 * Common Jira/Demo status names and their canonical rank against a workflow.
 * Lower ranks sort to the left. Statuses not in the table fall through to
 * `Number.MAX_SAFE_INTEGER` so the lexical sort takes over.
 */
export function commonStatusRank(statusName: string): number {
  switch (statusName.toLowerCase()) {
    case 'backlog':
      return 0;
    case 'to do':
      return 1;
    case 'selected for development':
      return 2;
    case 'in progress':
      return 3;
    case 'blocked':
      return 4;
    case 'done':
      return 5;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Builds the columns shown in a board view.
 *
 * When `columnStatusOrder` is supplied and non-empty the result emits one
 * board column per entry of the canonical workflow order — the column is
 * populated with its current issues if the backend has any, or with an empty
 * `issues: []` placeholder if no issues currently sit in that status. Statuses
 * reported by the backend that are absent from the order are appended in
 * lexical order after the workflow columns so an unknown status still has a
 * place to land. This is the path drag-and-drop depends on: emptying out a
 * column must not delete it.
 *
 * When `columnStatusOrder` is missing the helper falls back to the historical
 * "only emit columns for statuses with issues" behaviour, sorted via the
 * caller-supplied `rankStatus` callback (and finally lexicographically).
 */
export function buildBoardColumns(
  issues: IssueSummary[],
  options: {
    columnStatusOrder?: readonly string[];
    rankStatus?: (statusName: string, statusCategory: string | undefined) => number;
  } = {}
): BoardColumn[] {
  const issuesByStatus = new Map<string, IssueSummary[]>();
  const statusCategories = new Map<string, string | undefined>();

  for (const issue of issues) {
    const statusName = issue.status || 'Unknown';
    const bucket = issuesByStatus.get(statusName) ?? [];
    bucket.push(issue);
    issuesByStatus.set(statusName, bucket);
    if (!statusCategories.has(statusName)) {
      statusCategories.set(statusName, issue.statusCategory);
    }
  }

  const makeColumn = (statusName: string): BoardColumn => ({
    id: `status:${statusName}`,
    name: statusName,
    statusCategory: statusCategories.get(statusName),
    issues: sortIssuesByUpdated(issuesByStatus.get(statusName) ?? [])
  });

  const order = options.columnStatusOrder;
  if (order && order.length > 0) {
    const ordered: BoardColumn[] = [];
    for (const name of order) {
      ordered.push(makeColumn(name));
    }
    for (const statusName of issuesByStatus.keys()) {
      if (!order.includes(statusName)) {
        ordered.push(makeColumn(statusName));
      }
    }
    return ordered;
  }

  const rank = options.rankStatus;
  const sortedStatuses = [...issuesByStatus.keys()].sort((left, right) => {
    if (!rank) return left.localeCompare(right);
    return (
      rank(left, statusCategories.get(left)) -
        rank(right, statusCategories.get(right)) ||
      left.localeCompare(right)
    );
  });
  return sortedStatuses.map(makeColumn);
}
