import type { AssistantIpc, DurableConversation } from '@praxis/core';

/** A read that lags a notified revision is retried a few times with backoff, then left to the next notification. */
export const STALE_READ_RETRIES = 4;
const staleReadDelay = (attempt: number) => Math.min(250, 50 * 2 ** attempt);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Subscribe first; coalesce invalidations and never publish an older snapshot.
 *
 * Events invalidate, snapshots carry state (TASK-479): an update newer than the loaded revision
 * triggers one coalesced `getConversation`; one at or below it is a duplicate and is ignored. A
 * revision gap needs no special path — the snapshot is authoritative, and reading it never
 * replays or dispatches work. The client never derives conversation state from event deltas.
 */
export function subscribeConversation(bridge: AssistantIpc, id: string, publish: (value: DurableConversation | undefined) => void, failed: (error: unknown) => void): () => void {
  let disposed = false;
  let loading = false;
  let dirty = true;
  let revision = -1;
  let requiredRevision = -1;
  const refresh = async () => {
    if (loading || disposed) return;
    loading = true;
    let staleReads = 0;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const snapshot = await bridge.getConversation(id);
        if (disposed) return;
        if (!snapshot) { publish(undefined); return; }
        if (snapshot.revision >= revision) {
          revision = snapshot.revision;
          publish(snapshot);
        }
        if (revision < requiredRevision) {
          if (staleReads >= STALE_READ_RETRIES) { requiredRevision = revision; continue; }
          await wait(staleReadDelay(staleReads++));
          dirty = true;
        }
      }
    } catch (error) { if (!disposed) failed(error); }
    finally { loading = false; }
  };
  const unsubscribe = bridge.subscribeConversation(id, update => {
    if (update.error && !disposed) failed(update.error);
    if (update.revision <= revision) return;
    requiredRevision = Math.max(requiredRevision, update.revision);
    dirty = true;
    void refresh();
  });
  void refresh();
  return () => { disposed = true; unsubscribe(); };
}
