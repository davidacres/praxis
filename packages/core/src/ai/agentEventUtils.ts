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

/**
 * Repo-relative paths this session's tools reported writing.
 *
 * Exists so an action scoped to "this session" can be scoped honestly. The
 * Changes surface reads `git status`, which reports *everything* dirty in the
 * folder — the agent's edits, your own work in progress, and anything another
 * session left behind. Committing or discarding that whole list on a button
 * labelled for one session is how unrelated work gets swept up.
 *
 * Three path forms have to meet here, which is the fiddly part:
 *
 * - `git status --porcelain` → relative to the **repository root**
 * - ACP diff blocks (`acpAgentHost`) → **absolute**
 * - the gateway's `write_file` (`localTools`) → relative to the session's
 *   **working directory**
 *
 * A reported path that cannot be mapped into the repository is left out rather
 * than guessed at. That direction is deliberate: the result is used to *narrow*
 * a destructive action, so under-matching means the action touches less than it
 * might have, while over-matching means it touches a file nobody attributed to
 * this session. Losing a file from the set is recoverable; adding one is not.
 *
 * Note this is what the agent *said* it wrote. Files changed by a shell command
 * it ran, and deletes or renames, are not reported by any host — so this is a
 * lower bound on what the session did, never an upper one.
 */
export function reportedSessionPaths(
  events: readonly AgentEventSummary[],
  repositoryPath: string
): Set<string> {
  const toPosix = (value: string) => value.replace(/\\/g, '/');
  const isAbsolute = (value: string) => value.startsWith('/') || /^[A-Za-z]:\//.test(value);
  const root = toPosix(repositoryPath).replace(/\/+$/, '');

  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_complete') continue;
    for (const change of event.data?.fileChanges ?? []) {
      const reported = toPosix(change.path ?? '').trim();
      if (!reported) continue;

      if (root && reported.startsWith(`${root}/`)) {
        paths.add(reported.slice(root.length + 1));
      } else if (!isAbsolute(reported)) {
        paths.add(reported.replace(/^\.\//, ''));
      }
      // Absolute and outside the repository: unmappable, so deliberately dropped.
    }
  }
  return paths;
}
