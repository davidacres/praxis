import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLatestEditToPath, reportedSessionPaths } from './agentEventUtils';
import type { AgentEventSummary } from './agentTypes';

function toolComplete(timestamp: string, path: string): AgentEventSummary {
  return {
    timestamp,
    type: 'tool_complete',
    summary: `Edited ${path}`,
    data: { fileChanges: [{ path, oldText: 'before', newText: 'after' }] }
  };
}

test('the only edit to a path is its own latest edit', () => {
  const events = [toolComplete('2026-01-01T00:00:00.000Z', 'a.ts')];
  assert.equal(isLatestEditToPath(events, events[0].timestamp, 'a.ts'), true);
});

test('a later edit to the same path supersedes an earlier one', () => {
  const events = [
    toolComplete('2026-01-01T00:00:00.000Z', 'a.ts'),
    toolComplete('2026-01-01T00:00:01.000Z', 'a.ts')
  ];
  assert.equal(isLatestEditToPath(events, events[0].timestamp, 'a.ts'), false);
  assert.equal(isLatestEditToPath(events, events[1].timestamp, 'a.ts'), true);
});

test('a later edit to a different path does not supersede this one', () => {
  const events = [
    toolComplete('2026-01-01T00:00:00.000Z', 'a.ts'),
    toolComplete('2026-01-01T00:00:01.000Z', 'b.ts')
  ];
  assert.equal(isLatestEditToPath(events, events[0].timestamp, 'a.ts'), true);
});

test('a tool_start event never counts as a superseding edit', () => {
  const events: AgentEventSummary[] = [
    toolComplete('2026-01-01T00:00:00.000Z', 'a.ts'),
    { timestamp: '2026-01-01T00:00:01.000Z', type: 'tool_start', summary: 'Running tool' }
  ];
  assert.equal(isLatestEditToPath(events, events[0].timestamp, 'a.ts'), true);
});

function writeEvent(paths: string[], timestamp = '2026-09-13T10:00:00.000Z'): AgentEventSummary {
  return {
    type: 'tool_complete',
    summary: 'Tool completed: write_file',
    timestamp,
    data: { fileChanges: paths.map(path => ({ path })) }
  } as AgentEventSummary;
}

test('maps an absolute reported path into the repository', () => {
  const events = [writeEvent(['/Users/dev/repo/src/sum.js'])];
  assert.deepEqual([...reportedSessionPaths(events, '/Users/dev/repo')], ['src/sum.js']);
});

test('keeps a working-directory-relative path as it is', () => {
  const events = [writeEvent(['src/sum.js', './notes.md'])];
  assert.deepEqual([...reportedSessionPaths(events, '/Users/dev/repo')].sort(), ['notes.md', 'src/sum.js']);
});

test('drops an absolute path outside the repository rather than guessing', () => {
  // The result narrows a destructive action, so an unmappable path must fall
  // out of the set — including one that was never attributed to this session
  // is not recoverable, losing one is.
  const events = [writeEvent(['/etc/hosts', '/Users/dev/other-repo/src/a.ts'])];
  assert.deepEqual([...reportedSessionPaths(events, '/Users/dev/repo')], []);
});

test('normalises Windows separators and a trailing slash on the root', () => {
  const events = [writeEvent(['C:\\work\\repo\\src\\sum.js'])];
  assert.deepEqual([...reportedSessionPaths(events, 'C:\\work\\repo\\')], ['src/sum.js']);
});

test('deduplicates repeated edits to one file', () => {
  const events = [
    writeEvent(['src/sum.js'], '2026-09-13T10:00:00.000Z'),
    writeEvent(['/Users/dev/repo/src/sum.js'], '2026-09-13T10:01:00.000Z')
  ];
  assert.deepEqual([...reportedSessionPaths(events, '/Users/dev/repo')], ['src/sum.js']);
});

test('ignores events that are not completed tool runs', () => {
  const started = { type: 'tool_start', summary: 'Running tool: write_file', timestamp: '2026-09-13T10:00:00.000Z', data: { fileChanges: [{ path: 'src/sum.js' }] } } as AgentEventSummary;
  const message = { type: 'message', summary: 'done', timestamp: '2026-09-13T10:01:00.000Z' } as AgentEventSummary;
  assert.deepEqual([...reportedSessionPaths([started, message], '/Users/dev/repo')], []);
});

test('a session whose host reports nothing yields an empty set', () => {
  // Copilot never populates `fileChanges`, and no host reports a shell
  // command's writes — so "empty" means "nothing was reported", not
  // "nothing was changed". Callers have to say which.
  const shellRun = { type: 'tool_complete', summary: 'Tool completed: shell', timestamp: '2026-09-13T10:00:00.000Z', data: { output: 'added 120 packages' } } as AgentEventSummary;
  assert.deepEqual([...reportedSessionPaths([shellRun], '/Users/dev/repo')], []);
});
