import type { AgentEventSummary, AgentToolFileChange } from './agentTypes';

/** Lines one session's own tools reported adding and removing in one file. */
export interface SessionFileChange {
  path: string;
  added: number;
  removed: number;
}

/**
 * What a session's tools reported writing, totalled per file.
 *
 * Built from the `fileChanges` on its `tool_complete` events, not from `git status`:
 * a working folder's diff mixes in your own edits and other sessions', so it cannot
 * say what *this* session did. The counts add up every edit the agent made, so a line
 * written and then rewritten counts twice. They describe the work done, not a net diff.
 */
export interface SessionChangeSummary {
  files: SessionFileChange[];
  added: number;
  removed: number;
}

/** Lines added and removed by one reported change: from its unified diff, else from its before/after text. */
export function countChangedLines(change: AgentToolFileChange): { added: number; removed: number } {
  if (change.diff) {
    let added = 0;
    let removed = 0;
    for (const line of change.diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
  }
  if (change.oldText === undefined && change.newText === undefined) return { added: 0, removed: 0 };
  // No diff: compare the two texts as multisets of lines. Exact for appends and
  // deletions, and close enough for a count of rewritten lines.
  const before = new Map<string, number>();
  const lines = (text: string | undefined) => (text ? text.split('\n') : []);
  for (const line of lines(change.oldText)) before.set(line, (before.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(change.newText)) {
    const left = before.get(line) ?? 0;
    if (left > 0) before.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  before.forEach(count => { removed += count; });
  return { added, removed };
}

/** Folds newly appended events into a session's change summary; returns the previous one when nothing changed. */
export function addToChangeSummary(
  previous: SessionChangeSummary | undefined,
  events: readonly AgentEventSummary[]
): SessionChangeSummary | undefined {
  let files: Map<string, SessionFileChange> | undefined;
  for (const event of events) {
    if (event.type !== 'tool_complete') continue;
    for (const change of event.data?.fileChanges ?? []) {
      const path = change.path?.trim();
      if (!path) continue;
      files ??= new Map((previous?.files ?? []).map(file => [file.path, { ...file }]));
      const counts = countChangedLines(change);
      const file = files.get(path) ?? { path, added: 0, removed: 0 };
      file.added += counts.added;
      file.removed += counts.removed;
      files.set(path, file);
    }
  }
  if (!files) return previous;
  const list = [...files.values()];
  return {
    files: list,
    added: list.reduce((sum, file) => sum + file.added, 0),
    removed: list.reduce((sum, file) => sum + file.removed, 0)
  };
}
