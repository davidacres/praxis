import assert from 'node:assert/strict';
import test from 'node:test';
import { latestCodexActivity, parseCodexActivityUpdates } from '../src/ai/codexActivity.ts';

test('splits markdown status updates and removes their emphasis', () => {
  assert.deepEqual(parseCodexActivityUpdates('**Inspecting project picker**\n\n**Building project switcher**'), [
    'Inspecting project picker',
    'Building project switcher'
  ]);
});

test('uses the last status update as the current activity', () => {
  assert.equal(latestCodexActivity('Inspecting project picker\n\nBuilding project switcher'), 'Building project switcher');
});

test('preserves a plain streamed thought as one update when it has no separators', () => {
  assert.deepEqual(parseCodexActivityUpdates('Checking the ACP thought path.'), ['Checking the ACP thought path.']);
});
