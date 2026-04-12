import type { IssueFilters } from '../types';

export type ParentFieldMode = 'parent' | 'parentEpic';

function quoteJqlValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildInClause(field: string, values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  if (values.length === 1) {
    return `${field} = ${quoteJqlValue(values[0])}`;
  }

  return `${field} in (${values.map(quoteJqlValue).join(', ')})`;
}

export function buildIssuesJql(filters: IssueFilters, parentFieldMode: ParentFieldMode): string {
  const clauses: string[] = [];

  const projectClause = buildInClause('project', filters.projectKeys);
  if (projectClause) {
    clauses.push(projectClause);
  }

  if (filters.assigneeMode === 'me') {
    clauses.push('assignee = currentUser()');
  }

  const statusClause = buildInClause('status', filters.statuses);
  if (statusClause) {
    clauses.push(statusClause);
  }

  const issueTypeClause = buildInClause('issuetype', filters.issueTypes);
  if (issueTypeClause) {
    clauses.push(issueTypeClause);
  }

  if (filters.searchText.trim().length > 0) {
    clauses.push(`text ~ ${quoteJqlValue(filters.searchText.trim())}`);
  }

  if (filters.parentKey) {
    const parentField = parentFieldMode === 'parent' ? 'parent' : 'parentEpic';
    clauses.push(`${parentField} = ${quoteJqlValue(filters.parentKey)}`);
  }

  const where = clauses.length > 0 ? clauses.join(' AND ') : 'order by updated DESC';
  return clauses.length > 0 ? `${where} ORDER BY updated DESC` : where;
}

export function buildParentItemsJql(
  projectKeys: string[],
  statuses: string[] = [],
  searchText?: string,
  issueTypes: string[] = ['Epic']
): string {
  const clauses: string[] = [];
  const issueTypeClause = buildInClause('issuetype', issueTypes);
  if (issueTypeClause) {
    clauses.push(issueTypeClause);
  }
  const projectClause = buildInClause('project', projectKeys);

  if (projectClause) {
    clauses.push(projectClause);
  }

  const statusClause = buildInClause('status', statuses);
  if (statusClause) {
    clauses.push(statusClause);
  }

  if (searchText && searchText.trim().length > 0) {
    clauses.push(`text ~ ${quoteJqlValue(searchText.trim())}`);
  }

  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}
