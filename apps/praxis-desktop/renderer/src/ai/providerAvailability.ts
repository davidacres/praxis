import type { AiProviderStatus } from '@praxis/core';

/**
 * A provider is offered for new sessions only when it is both set up (a key is
 * present, or its CLI resolves) and not turned off in Settings → AI Provider.
 * Sessions already running on a provider keep working either way.
 */
export function isProviderUsable(status: Pick<AiProviderStatus, 'configured' | 'enabled'>): boolean {
  return status.configured && status.enabled;
}
