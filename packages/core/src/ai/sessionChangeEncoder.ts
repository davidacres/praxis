import type { AgentEventSummary, AgentSessionChange, AgentSessionRecord } from './agentTypes';

/**
 * Turns session records into `ai:sessionChanged` payloads, sending a
 * session's events whole only when the receiver cannot already have the
 * earlier ones, and otherwise only the events appended since the last push.
 *
 * A record is sent whole when it is the first push for that session, when its
 * transcript is not loaded (its events are an empty placeholder), or when its
 * `events` array was replaced rather than appended to (a load or an eviction).
 * The receiver (`renderer/src/ai/sessionChangeStream.ts`) refetches the
 * session if a delta does not line up with what it holds, so a window that
 * opened or reloaded mid-stream recovers on its own.
 */
export function createSessionChangeEncoder() {
  const sent = new Map<string, { events: readonly AgentEventSummary[]; count: number }>();
  return {
    encode(record: AgentSessionRecord): AgentSessionChange {
      const { events, ...rest } = record;
      const previous = sent.get(record.issueKey);
      sent.set(record.issueKey, { events, count: events.length });
      if (record.eventsLoaded && previous && previous.events === events && events.length >= previous.count) {
        return { ...rest, eventsDelta: { base: previous.count, appended: events.slice(previous.count) } };
      }
      return { ...rest, events };
    },
    forget(issueKey: string): void {
      sent.delete(issueKey);
    }
  };
}
