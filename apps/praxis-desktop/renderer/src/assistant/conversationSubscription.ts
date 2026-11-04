import type { AssistantIpc, DurableConversation } from '@praxis/core';

/** Subscribe first; coalesce invalidations and never publish an older snapshot. */
export function subscribeConversation(bridge: AssistantIpc, id: string, publish: (value: DurableConversation | undefined) => void, failed: (error: unknown) => void): () => void {
  let disposed = false;
  let loading = false;
  let dirty = true;
  let revision = -1;
  let requiredRevision = -1;
  const refresh = async () => {
    if (loading || disposed) return;
    loading = true;
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
        if (revision < requiredRevision) dirty = true;
      }
    } catch (error) { if (!disposed) failed(error); }
    finally { loading = false; }
  };
  const unsubscribe = bridge.subscribeConversation(id, update => {
    if (update.revision <= revision) return;
    requiredRevision = Math.max(requiredRevision, update.revision);
    dirty = true;
    void refresh();
  });
  void refresh();
  return () => { disposed = true; unsubscribe(); };
}
