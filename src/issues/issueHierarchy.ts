import type { BackendMode, ParentIssueReference } from '../types';

function normalizeLoose(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function formatAllowedTypeList(values: string[]): string {
  if (values.length === 0) {
    return 'parent item';
  }
  if (values.length === 1) {
    return values[0];
  }
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

export interface ParentRule {
  canHaveParent: boolean;
  requiresParent: boolean;
  allowedParentTypes: string[];
  defaultLabel: string;
  helperText: string;
  emptyText: string;
  placeholder: string;
}

export function isParentIssueType(issueType: string | undefined): boolean {
  const normalized = normalizeLoose(issueType);
  return normalized === 'epic' || normalized === 'feature';
}

export function isIdeaIssueType(issueType: string | undefined): boolean {
  return normalizeLoose(issueType) === 'idea';
}

export function isSubtaskIssueType(issueType: string | undefined): boolean {
  return normalizeLoose(issueType) === 'subtask';
}

export function normalizeIssueTypeLabel(issueType: string | undefined): string {
  const trimmed = issueType?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Issue';
}

export function getParentRule(issueType: string | undefined, mode: BackendMode): ParentRule {
  if (isParentIssueType(issueType)) {
    return {
      canHaveParent: false,
      requiresParent: false,
      allowedParentTypes: [],
      defaultLabel: 'Parent',
      helperText: `${normalizeIssueTypeLabel(issueType)} items cannot have a parent.`,
      emptyText: `${normalizeIssueTypeLabel(issueType)} items do not use a parent.`,
      placeholder: ''
    };
  }

  if (isSubtaskIssueType(issueType)) {
    return {
      canHaveParent: true,
      requiresParent: true,
      allowedParentTypes: ['Story', 'Task', 'Bug'],
      defaultLabel: 'Parent',
      helperText: 'Subtasks must belong to a story, task, or bug.',
      emptyText: 'No parent selected.',
      placeholder: 'Enter a parent issue key'
    };
  }

  if (mode === 'livefolder' || mode === 'userworkspace') {
    return {
      canHaveParent: true,
      requiresParent: true,
      allowedParentTypes: ['Feature'],
      defaultLabel: 'Feature',
      helperText: `${normalizeIssueTypeLabel(issueType)} items in ${mode === 'userworkspace' ? 'User Workspace' : 'Live Folder'} mode must belong to a Feature.`,
      emptyText: 'No feature selected.',
      placeholder: 'Enter a feature key'
    };
  }

  const allowedParentTypes = mode === 'jira' || mode === 'jiraapi' ? ['Epic'] : ['Epic', 'Feature'];
  return {
    canHaveParent: true,
    requiresParent: false,
    allowedParentTypes,
    defaultLabel: 'Epic',
    helperText: `${normalizeIssueTypeLabel(issueType)} items can only belong to ${formatAllowedTypeList(
      allowedParentTypes
    )}.`,
    emptyText: 'No epic selected.',
    placeholder: 'Leave blank to clear the epic'
  };
}

export function isAllowedParentType(
  parentIssueType: string | undefined,
  childIssueType: string | undefined,
  mode: BackendMode
): boolean {
  const rule = getParentRule(childIssueType, mode);
  if (!rule.canHaveParent) {
    return false;
  }
  const normalizedParentType = normalizeLoose(parentIssueType);
  return rule.allowedParentTypes.some(type => normalizeLoose(type) === normalizedParentType);
}

export function getResolvedParentLabel(
  issueType: string | undefined,
  mode: BackendMode,
  parentIssue?: ParentIssueReference
): string {
  const currentParentType = parentIssue?.issueType?.trim();
  if (currentParentType) {
    return currentParentType;
  }
  return getParentRule(issueType, mode).defaultLabel;
}

export function formatParentReference(parentIssue: ParentIssueReference | undefined): string {
  if (!parentIssue) {
    return '';
  }

  return [parentIssue.key, parentIssue.summary].filter(Boolean).join(' ').trim();
}

export function buildParentValidationMessage(
  issueType: string | undefined,
  mode: BackendMode,
  parentIssueType: string | undefined
): string {
  const childLabel = normalizeIssueTypeLabel(issueType);
  const parentLabel = normalizeIssueTypeLabel(parentIssueType);
  const rule = getParentRule(issueType, mode);
  if (isParentIssueType(issueType)) {
    return `${childLabel} items cannot have a parent.`;
  }
  if (isSubtaskIssueType(issueType)) {
    return `${childLabel} items must belong to a Story. "${parentLabel}" is not allowed.`;
  }
  return `${childLabel} items can only belong to ${formatAllowedTypeList(rule.allowedParentTypes)}. "${parentLabel}" is not allowed.`;
}
