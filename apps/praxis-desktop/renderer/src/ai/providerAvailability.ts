import type { AiProviderStatus } from '@praxis/core';

/**
 * A provider is offered for new sessions only when it is both set up (a key is
 * present, or its CLI resolves) and not turned off in Settings → AI Provider.
 * Sessions already running on a provider keep working either way.
 */
export function isProviderUsable(status: Pick<AiProviderStatus, 'configured' | 'enabled'>): boolean {
  return status.configured && status.enabled;
}

/**
 * Agent sessions, ticket reviews and workflow stages call tools on every turn.
 * A custom endpoint whose connection test showed no tool calling can still
 * answer one-shot prompts (recommendations), but is kept out of those pickers —
 * main refuses it too (`assertCanRunAgentSession`). Untested endpoints and
 * built-ins carry no `capabilities` and are assumed able.
 */
export function canRunAgentSessions(status: Pick<AiProviderStatus, 'capabilities'>): boolean {
  return !status.capabilities || status.capabilities.tools;
}

export function isProviderUsableForSessions(status: Pick<AiProviderStatus, 'configured' | 'enabled' | 'capabilities'>): boolean {
  return isProviderUsable(status) && canRunAgentSessions(status);
}
