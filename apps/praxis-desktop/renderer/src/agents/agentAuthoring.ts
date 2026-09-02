/**
 * Light, browser-safe validation for the create/import wizards.
 *
 * Just enough to flag bad input before it reaches the host — the main process
 * re-runs core's authoritative `planNewAgent` / `planNewSkill` and rejects with
 * detailed errors, which the dialogs also surface.
 */

import type { AgentTransport, CatalogScope } from '@praxis/core';

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export function segmentError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Required.';
  if (/[/\\]|\.\./.test(trimmed)) return 'Only lowercase letters, digits, and dashes.';
  if (!SEGMENT.test(trimmed)) return '2–64 lowercase letters, digits, or dashes; start and end alphanumeric.';
  return undefined;
}

export interface AgentTransportMeta {
  id: AgentTransport;
  label: string;
  /** Process transports need a command; network transports need a URL. */
  needs: 'command' | 'url';
}

export const AGENT_TRANSPORTS: AgentTransportMeta[] = [
  { id: 'acp', label: 'ACP (stdio process)', needs: 'command' },
  { id: 'copilot-sdk', label: 'Copilot SDK (process)', needs: 'command' },
  { id: 'custom', label: 'Custom (process)', needs: 'command' },
  { id: 'http', label: 'HTTP endpoint', needs: 'url' },
  { id: 'gateway', label: 'AI Gateway', needs: 'url' }
];

export function transportMeta(id: AgentTransport): AgentTransportMeta {
  return AGENT_TRANSPORTS.find(meta => meta.id === id) ?? AGENT_TRANSPORTS[0];
}

export interface AgentDraft {
  scope: CatalogScope;
  name: string;
  id: string;
  transport: AgentTransport;
  command: string;
  url: string;
  args: string;
  activation: 'onDemand' | 'startup';
  scaffold: boolean;
}

export function agentDraftErrors(draft: AgentDraft, existingIds: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'A display name is required.';
  const idError = segmentError(draft.id);
  if (idError) errors.id = idError;
  else if (existingIds.includes(draft.id.trim())) errors.id = 'An agent with this id already exists in this scope.';
  const meta = transportMeta(draft.transport);
  if (meta.needs === 'command' && !draft.command.trim()) errors.command = 'A command is required for this transport.';
  if (meta.needs === 'url' && !draft.url.trim()) errors.url = 'A URL is required for this transport.';
  return errors;
}

export interface SkillDraft {
  scope: CatalogScope;
  name: string;
  description: string;
  version: string;
  triggers: string;
  instructions: string;
  includeScripts: boolean;
  includeReferences: boolean;
  includeExamples: boolean;
}

export function skillDraftErrors(draft: SkillDraft, existingNames: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const nameError = segmentError(draft.name);
  if (nameError) errors.name = nameError;
  else if (existingNames.includes(draft.name.trim())) errors.name = 'A skill with this name already exists in this scope.';
  if (!draft.description.trim()) errors.description = 'A description is required.';
  return errors;
}
