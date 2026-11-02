import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEventSummary, AgentToolFileChange } from './agentTypes';
import { addToChangeSummary, countChangedLines } from './sessionChangeSummary';

const edit = (fileChanges: AgentToolFileChange[], type: AgentEventSummary['type'] = 'tool_complete'): AgentEventSummary =>
  ({ timestamp: '2026-11-02T10:00:00.000Z', type, summary: 'Edit', data: { fileChanges } });

test('a unified diff counts its + and - lines, not the file headers', () => {
  const diff = ['--- a/theme.css', '+++ b/theme.css', '@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+added'].join('\n');
  assert.deepEqual(countChangedLines({ path: 'theme.css', diff }), { added: 2, removed: 1 });
});

test('without a diff, before and after text are compared line by line', () => {
  assert.deepEqual(countChangedLines({ path: 'a.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc\nd' }), { added: 2, removed: 1 });
  assert.deepEqual(countChangedLines({ path: 'new.ts', newText: 'one\ntwo' }), { added: 2, removed: 0 });
  assert.deepEqual(countChangedLines({ path: 'gone.ts' }), { added: 0, removed: 0 });
});

test('edits accumulate per file across events, and only completed tool calls count', () => {
  let summary = addToChangeSummary(undefined, [edit([{ path: 'a.ts', newText: 'x\ny' }])]);
  summary = addToChangeSummary(summary, [
    edit([{ path: 'a.ts', oldText: 'x\ny', newText: 'x\ny\nz' }, { path: 'b.ts', oldText: 'q', newText: '' }]),
    edit([{ path: 'c.ts', newText: 'ignored' }], 'tool_start')
  ]);
  assert.deepEqual(summary, {
    files: [{ path: 'a.ts', added: 3, removed: 0 }, { path: 'b.ts', added: 0, removed: 1 }],
    added: 3,
    removed: 1
  });
});

test('events with no file changes leave the summary untouched', () => {
  const previous = { files: [{ path: 'a.ts', added: 1, removed: 0 }], added: 1, removed: 0 };
  assert.equal(addToChangeSummary(previous, [{ timestamp: 't', type: 'message', summary: 'hi' }]), previous);
  assert.equal(addToChangeSummary(undefined, []), undefined);
});
