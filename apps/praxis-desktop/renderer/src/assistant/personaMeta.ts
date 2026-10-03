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
}

export const PERSONAS: readonly PersonaMeta[] = [
  { id: 'lead', name: 'Tech Lead', badge: 'Lead', icon: 'target' },
  { id: 'dev', name: 'Senior Dev', badge: 'Dev', icon: 'terminal' },
  { id: 'qa', name: 'QA Specialist', badge: 'QA', icon: 'check-square' },
  { id: 'security', name: 'Security Engineer', badge: 'Security', icon: 'shield' },
  { id: 'product', name: 'Product Researcher', badge: 'Product', icon: 'lightbulb' }
];

export function personaMeta(id: AssistantRole): PersonaMeta {
  return PERSONAS.find(persona => persona.id === id) ?? PERSONAS[0];
}
