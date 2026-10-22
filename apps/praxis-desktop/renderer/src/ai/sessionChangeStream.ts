import type { AgentEventSummary, AgentSessionChange, AgentSessionRecord } from '@praxis/core';

/**
 * Whole session records from `ai:sessionChanged`, which may carry only the
 * events appended since the previous push (see core's `sessionChangeEncoder`).
 *
 * Subscribe with `onSessionChanged` here, never `window.praxis.ai` directly:
 * this is the one place a delta is joined onto the events already held, and
 * the one bridge crossing per push. Each listener used to receive its own copy
 * of the whole record across the context bridge on every streamed token,
 * which for a long session was megabytes per listener, many times a second.
 */

/** Sessions whose events are kept to join deltas onto; others refetch once. */
const MAX_CACHED_SESSIONS = 8;

export interface SessionChangeAssemblerOptions {
  /** Reads a whole record when a delta does not line up with what is held. */
  fetchSession: (issueKey: string) => Promise<AgentSessionRecord | undefined>;
  deliver: (record: AgentSessionRecord) => void;
  maxCachedSessions?: number;
}

export function createSessionChangeAssembler({
  fetchSession,
  deliver,
  maxCachedSessions = MAX_CACHED_SESSIONS
}: SessionChangeAssemblerOptions) {
  // Map insertion order doubles as recency: re-inserting moves a key to the end.
  const cache = new Map<string, AgentEventSummary[]>();
  // The newest change for a session whose whole record is being fetched.
  const pending = new Map<string, AgentSessionChange>();

  const remember = (issueKey: string, events: AgentEventSummary[]) => {
    cache.delete(issueKey);
    cache.set(issueKey, events);
    while (cache.size > maxCachedSessions) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** The whole record, or `undefined` when the events it extends aren't held. */
  const assemble = (change: AgentSessionChange): AgentSessionRecord | undefined => {
    if (!('eventsDelta' in change) || !change.eventsDelta) {
      const record = change as AgentSessionRecord;
      remember(record.issueKey, record.events ?? []);
      return record;
    }
    const { eventsDelta, events: _none, ...rest } = change;
    const known = cache.get(change.issueKey);
    if (!known || known.length < eventsDelta.base) return undefined;
    let events = known;
    if (known.length === eventsDelta.base) {
      if (eventsDelta.appended.length > 0) events = known.concat(eventsDelta.appended);
    } else if (known.length < eventsDelta.base + eventsDelta.appended.length) {
      // Holds some of the appended events but not all: join from where it stops.
      events = known.concat(eventsDelta.appended.slice(known.length - eventsDelta.base));
    }
    remember(change.issueKey, events);
    return { ...rest, events } as AgentSessionRecord;
  };

  const refetch = (issueKey: string) => {
    void fetchSession(issueKey)
      .catch(() => undefined)
      .then(whole => {
        const latest = pending.get(issueKey);
        if (!latest) return; // a whole record arrived meanwhile and was delivered
        pending.delete(issueKey);
        if (whole) remember(issueKey, whole.events ?? []);
        const record = assemble(latest);
        if (record) {
          deliver(record);
          return;
        }
        // Still nothing to join onto: deliver without events and let the page
        // load them, as it would for any session it hasn't opened yet.
        const { eventsDelta: _delta, ...rest } = latest as Extract<AgentSessionChange, { eventsDelta: unknown }>;
        deliver({ ...rest, events: [], eventsLoaded: false } as AgentSessionRecord);
      });
  };

  return {
    receive(change: AgentSessionChange): void {
      const isWhole = !('eventsDelta' in change) || !change.eventsDelta;
      if (pending.has(change.issueKey) && !isWhole) {
        pending.set(change.issueKey, change);
        return;
      }
      pending.delete(change.issueKey);
      const record = assemble(change);
      if (record) {
        deliver(record);
        return;
      }
      pending.set(change.issueKey, change);
      refetch(change.issueKey);
    },
    forget(issueKey: string): void {
      cache.delete(issueKey);
      pending.delete(issueKey);
    }
  };
}

type Listener = (record: AgentSessionRecord) => void;
const listeners = new Set<Listener>();
let connected = false;

function connect() {
  if (connected) return;
  connected = true;
  const assembler = createSessionChangeAssembler({
    fetchSession: issueKey => window.praxis.ai.getSession(issueKey),
    deliver: record => {
      for (const listener of [...listeners]) {
        // Each listener used to have its own IPC handler, so one throwing never
        // stopped the others; keep that isolation.
        try {
          listener(record);
        } catch (error) {
          console.error('[ai] session change listener failed:', error);
        }
      }
    }
  });
  window.praxis.ai.onSessionChanged(change => assembler.receive(change));
  window.praxis.ai.onSessionDeleted(issueKey => assembler.forget(issueKey));
}

/** Subscribe to whole session records; returns an unsubscribe function. */
export function onSessionChanged(listener: Listener): () => void {
  connect();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
