import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistoryForReplay, type WireMessage } from './wire';

test('compactHistoryForReplay strips tool round-trips, keeps the text exchange', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'open example.com and summarise it' },
    {
      role: 'assistant',
      content: 'Let me look.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_navigate', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(12000) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'browser_read', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c2', content: 'another 8000 chars of page text' },
    { role: 'assistant', content: 'It is a placeholder page owned by IANA.' },
    { role: 'user', content: 'who runs it?' }
  ];

  const compacted = compactHistoryForReplay(history);

  assert.deepEqual(compacted, [
    { role: 'user', content: 'open example.com and summarise it' },
    { role: 'assistant', content: 'Let me look.' },
    { role: 'assistant', content: 'It is a placeholder page owned by IANA.' },
    { role: 'user', content: 'who runs it?' }
  ]);
  // No tool traffic survives.
  assert.equal(compacted.some(m => m.role === 'tool' || m.tool_calls), false);
});

test('compactHistoryForReplay is a no-op for a plain chat history', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  assert.deepEqual(compactHistoryForReplay(history), history);
});
