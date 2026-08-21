import type { BoardColumn, BoardDetails, IssueSummary } from '../types';

export type SwimLaneGroupBy = 'none' | 'assignee' | 'epic';

function swimLaneTitle(issue: IssueSummary, groupBy: 'assignee' | 'epic'): string {
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

function sortLaneTitles(titles: string[], groupBy: 'assignee' | 'epic'): string[] {
  const last = groupBy === 'assignee' ? 'Unassigned' : 'All others';
  return [...titles].sort((a, b) => {
    if (a === last) {
      return 1;
    }
    if (b === last) {
      return -1;
    }
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

export interface SwimLaneRow {
  title: string;
  columns: BoardColumn[];
}

/**
 * Splits a columnized board into horizontal swim lanes. Each lane repeats the same status columns.
 */
export function buildSwimLaneRows(
  details: BoardDetails,
  groupBy: 'assignee' | 'epic'
): SwimLaneRow[] {
  const allIssues = details.columns.flatMap(column => column.issues);
  const laneSet = new Set<string>();
  for (const issue of allIssues) {
    laneSet.add(swimLaneTitle(issue, groupBy));
  }
  if (laneSet.size === 0) {
    return [];
  }

  const lanes = sortLaneTitles([...laneSet], groupBy);
  return lanes.map(title => ({
    title,
    columns: details.columns.map(column => ({
      ...column,
      issues: column.issues.filter(issue => swimLaneTitle(issue, groupBy) === title)
    }))
  }));
}
