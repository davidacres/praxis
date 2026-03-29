import type { BoardColumnPreferences, IssueSummary } from '../types';

export function filterBoardIssues(
  issues: IssueSummary[],
  prefs: BoardColumnPreferences
): IssueSummary[] {
  let result = issues;
  const assigneeQ = prefs.issueFilterAssignee?.trim().toLowerCase();
  if (assigneeQ) {
    result = result.filter(issue => (issue.assignee ?? '').toLowerCase().includes(assigneeQ));
  }

  const epicQ = prefs.issueFilterEpicKey?.trim().toLowerCase();
  if (epicQ) {
    result = result.filter(issue => {
      const key = (issue.parentKey ?? '').toLowerCase();
      const summary = (issue.parentIssue?.summary ?? '').toLowerCase();
      return key.includes(epicQ) || summary.includes(epicQ);
    });
  }

  const statuses = prefs.issueFilterStatuses;
  if (statuses && statuses.length > 0) {
    const set = new Set(statuses);
    result = result.filter(issue => set.has(issue.status));
  }

  return result;
}
