import type { AgentEventSummary } from './agentTypes';

/**
 * Whether the file change recorded on the `tool_complete` event timestamped
 * `eventTimestamp` is still the most recent edit to `path` in this session.
 *
 * Backs "undo this edit": undoing anything but the latest edit to a file
 * would silently discard a later edit the user hasn't reviewed yet, so both
 * the renderer (to decide whether to offer the control) and the IPC handler
 * that performs the write (as the authoritative check) call this rather than
 * trusting stale UI state.
 *
 * Timestamps are ISO 8601 from the same clock, so string comparison sorts
 * them correctly; ties (two edits within the same millisecond) are treated
 * as "not superseded" rather than guessed at either way.
 */
export function isLatestEditToPath(events: readonly AgentEventSummary[], eventTimestamp: string, path: string): boolean {
  return !events.some(
    event =>
      event.type === 'tool_complete' &&
      event.timestamp > eventTimestamp &&
      event.data?.fileChanges?.some(change => change.path === path)
  );
}
