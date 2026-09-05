import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLatestEditToPath } from './agentEventUtils';
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
