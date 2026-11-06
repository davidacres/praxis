import type { PageAssistantContext } from '@praxis/core';

/**
 * Whether a proposal the team made on one page can be applied from the page on screen now.
 *
 * An `update-ticket` proposal describes a specific ticket's new description: applying it from a
 * different ticket — or from a board that happens to be registered — would write the wrong record.
 * So a proposal is applied only where it was produced. This used to be an inline six-clause
 * comparison inside `AssistantProvider.applyAction`; it is a pure function so the rule is testable
 * and so the message it refuses with is stated once.
 */
export const INCOMPATIBLE_PAGE_CONTEXT_MESSAGE = 'Return to the originating page to apply this proposal.';

/** The identity fields a proposal is bound to. Everything else (summary text, prompts) may drift. */
const IDENTITY_FIELDS = ['pageType', 'projectId', 'issueKey', 'entityId', 'title'] as const;

function identity(context: PageAssistantContext | undefined): Record<string, string | undefined> {
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, context?.[field]]));
}

/**
 * `true` when both contexts exist and identify the same page.
 *
 * A missing origin (a message imported from a legacy transcript, or a detached window that never
 * registered) is not compatible: there is nothing to prove the apply targets the same record.
 */
export function isCompatiblePageContext(
  origin: PageAssistantContext | undefined,
  current: PageAssistantContext | undefined
): boolean {
  if (!origin || !current) return false;
  const left = identity(origin);
  const right = identity(current);
  return IDENTITY_FIELDS.every(field => left[field] === right[field]);
}

/** The refusal message for an incompatible (or absent) page context. */
export function incompatiblePageContextMessage(): string {
  return INCOMPATIBLE_PAGE_CONTEXT_MESSAGE;
}
