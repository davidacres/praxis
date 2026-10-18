import type { AssistantRole } from '@praxis/core';
import type { IconName } from '../ui/Icon';

/**
 * Browser-safe mirror of core's `ASSISTANT_PERSONAS` display fields. Core is
 * CommonJS and cannot be value-imported into the renderer (see AGENTS.md), so the
 * names, badges and icons are duplicated here; the prompts live only in core.
 */
export interface PersonaMeta {
  id: AssistantRole;
  name: string;
  badge: string;
  icon: IconName;
  /** One line on what this persona is for, shown wherever a roster lists them. */
  role: string;
}

export const PERSONAS: readonly PersonaMeta[] = [
  { id: 'lead', name: 'Tech Lead', badge: 'Lead', icon: 'target', role: 'Frames the approach, cuts scope' },
  { id: 'dev', name: 'Senior Dev', badge: 'Dev', icon: 'terminal', role: 'Writes and refactors the change' },
  { id: 'qa', name: 'QA Specialist', badge: 'QA', icon: 'check-square', role: 'Reviews the work so far' },
  { id: 'security', name: 'Security Engineer', badge: 'Security', icon: 'shield', role: 'Threat models the change' },
  { id: 'product', name: 'Product Researcher', badge: 'Product', icon: 'lightbulb', role: 'Checks the problem is real' }
];

export function personaMeta(id: AssistantRole): PersonaMeta {
  return PERSONAS.find(persona => persona.id === id) ?? PERSONAS[0];
}