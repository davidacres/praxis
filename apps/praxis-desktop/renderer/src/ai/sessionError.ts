import type { AgentSessionRecord } from '@praxis/core';

/** Retain a reported failure before the session's transcript is unloaded. */
export function recordedSessionError(session: Pick<AgentSessionRecord, 'lastError' | 'events'>): string | undefined {
  if (session.lastError?.trim()) return session.lastError;
  const event = [...session.events].reverse().find(event => event.type === 'error');
  return event?.detail?.trim() || event?.summary?.trim() || undefined;
}
