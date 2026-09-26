import type { BackendMode } from '@praxis/core';

/**
 * Field metadata for the New Issue form.
 *
 * The parent-rule logic here mirrors core's `issues/issueHierarchy.ts`
 * (`getParentRule`). The frontend deliberately imports only *types* from
 * `@praxis/core` — a runtime import would drag node-only services
 * (chokidar/fs via folderService) into the renderer bundle — so the small
 * slice of hierarchy rules the form needs is duplicated here. The backend
 * stays the enforcer; these rules only decide which fields render, whether
 * the parent is required, and the helper text shown under the picker.
 */

export const PRIORITY_OPTIONS = ['Critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest'];

export const SEVERITY_OPTIONS = ['Critical', 'High', 'Medium', 'Low'];

/**
 * Issue types the create form offers, per backend mode. Jira Cloud's
 * epic-level type is "Epic" where the folder-backed modes use "Feature", and
 * only the MCP-backed modes can file Subtasks.
 */
export function getCreatableTypes(mode: BackendMode): string[] {
  if (mode === 'jiracloud') {
    return ['Epic', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'];
  }
  if (mode === 'folder') {
    return ['Feature', 'Idea', 'Story', 'Task', 'Bug'];
  }
  // A project stores a free-form `issueType` string and has no subtask model.
  if (mode === 'app' || mode === 'project') {
    return ['Feature', 'Idea', 'Story', 'Task', 'Bug'];
  }
  return ['Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug'];
}

/** Idea tickets carry a research transcript instead of delivery workflows. */
export function isIdeaDraftType(issueType: string | undefined): boolean {
  return normalizeLoose(issueType) === 'idea';
}

export interface DraftParentRule {
  canHaveParent: boolean;
  requiresParent: boolean;
  /** Field label ("Feature" for folder children, "Epic" for Jira, …). */
  label: string;
  helperText: string;
  placeholder: string;
  /**
   * folder-backed semantics: a parent value that matches no
   * existing item means "create a new Feature with this summary"
   * (`newParentSummary`). Other backends reject unknown parents.
   */
  allowsNewParent: boolean;
}

function normalizeLoose(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function getDraftParentRule(
  issueType: string | undefined,
  mode: BackendMode
): DraftParentRule {
  const typeLabel = issueType?.trim() || 'Issue';

  if (normalizeLoose(issueType) === 'epic' || normalizeLoose(issueType) === 'feature') {
    return {
      canHaveParent: false,
      requiresParent: false,
      label: 'Parent',
      helperText: `${typeLabel} items cannot have a parent.`,
      placeholder: '',
      allowsNewParent: false
    };
  }

  if (normalizeLoose(issueType) === 'subtask') {
    return {
      canHaveParent: true,
      requiresParent: true,
      label: 'Parent',
      helperText: 'Subtasks must belong to a story, task, or bug.',
      placeholder: 'Enter a parent issue key',
      allowsNewParent: false
    };
  }

  if (mode === 'folder') {
    return {
      canHaveParent: true,
      requiresParent: true,
      label: 'Feature',
      helperText: `${typeLabel} items must belong to a Feature.`,
      placeholder: 'Select a feature or type a new name',
      allowsNewParent: true
    };
  }

  const jira = mode === 'jiracloud';
  return {
    canHaveParent: true,
    requiresParent: false,
    label: jira ? 'Epic' : 'Parent',
    helperText: `${typeLabel} items can only belong to ${jira ? 'an Epic' : 'an Epic or Feature'}.`,
    placeholder: 'Optional — pick from the list',
    allowsNewParent: false
  };
}
