import type { BackendMode } from '@ticket-manager/core';

/**
 * Field metadata for the New Issue form.
 *
 * The parent-rule logic here mirrors core's `issues/issueHierarchy.ts`
 * (`getParentRule`). The frontend deliberately imports only *types* from
 * `@ticket-manager/core` — a runtime import would drag node-only services
 * (chokidar/fs via liveFolderService) into the renderer bundle — so the small
 * slice of hierarchy rules the form needs is duplicated here. The backend
 * stays the enforcer; these rules only decide which fields render, whether
 * the parent is required, and the helper text shown under the picker.
 */

export const PRIORITY_OPTIONS = ['Critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest'];

export const SEVERITY_OPTIONS = ['Critical', 'High', 'Medium', 'Low'];

/** Issue types the create form offers, per backend mode. */
export function getCreatableTypes(mode: BackendMode): string[] {
  return mode === 'livefolder' || mode === 'userworkspace'
    ? ['Feature', 'Story', 'Task', 'Bug', 'Idea']
    : ['Feature', 'Idea', 'Story', 'Task', 'Bug'];
}

export interface DraftParentRule {
  canHaveParent: boolean;
  requiresParent: boolean;
  /** Field label ("Feature" for live folder children, "Epic" for Jira, …). */
  label: string;
  helperText: string;
  placeholder: string;
  /**
   * livefolder/userworkspace semantics: a parent value that matches no
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

  if (mode === 'livefolder' || mode === 'userworkspace') {
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
