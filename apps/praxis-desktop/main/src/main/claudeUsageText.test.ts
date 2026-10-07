import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClaudeReset, parseClaudeUsageText } from './claudeUsageText';

const NOW = Date.parse('2026-10-07T00:30:00.000Z'); // 01:30 in London (BST)

test('reads the session and weekly windows from a real /usage reply', () => {
  const windows = parseClaudeUsageText([
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 23% used · resets Oct 7 at 4am (Europe/London)',
    'Current week (all models): 35% used · resets Oct 7 at 9am (Europe/London)',
    '',
    'Last 24h · 121 requests · 5 sessions'
  ].join('\n'), NOW);
  assert.deepEqual(windows, [
    { period: 'hour', label: '5-hour window', usedPercent: 23, windowDurationMinutes: 300, resetsAt: '2026-10-07T03:00:00.000Z' },
    { period: 'week', label: 'Weekly window', usedPercent: 35, windowDurationMinutes: 10080, resetsAt: '2026-10-07T08:00:00.000Z' }
  ]);
});

test('keeps a model-scoped weekly window under its own label', () => {
  const [window] = parseClaudeUsageText('Current week (Opus only): 80% used · resets Oct 9 at 10:30pm (Europe/London)', NOW);
  assert.equal(window.label, 'Weekly · Opus');
  assert.equal(window.usedPercent, 80);
  assert.equal(window.resetsAt, '2026-10-09T21:30:00.000Z');
});

test('a window without a reset time still reports its percentage', () => {
  const [window] = parseClaudeUsageText('Current session: 5% used', NOW);
  assert.equal(window.usedPercent, 5);
  assert.equal(window.resetsAt, undefined);
});

test('a reply that is not a plan report yields no windows', () => {
  assert.deepEqual(parseClaudeUsageText('You are using an API key. /usage is unavailable.', NOW), []);
  assert.deepEqual(parseClaudeUsageText('', NOW), []);
});

test('a time with no date resolves to the next occurrence', () => {
  assert.equal(parseClaudeReset('4am (Europe/London)', NOW), '2026-10-07T03:00:00.000Z');
  assert.equal(parseClaudeReset('1am (Europe/London)', NOW), '2026-10-08T00:00:00.000Z');
});

test('a month earlier than now rolls into next year, and winter time uses the winter offset', () => {
  assert.equal(parseClaudeReset('Jan 2 at 9am (Europe/London)', Date.parse('2026-12-30T12:00:00.000Z')), '2027-01-02T09:00:00.000Z');
});

test('an unknown time zone does not throw', () => {
  assert.equal(parseClaudeReset('Oct 7 at 4am (Not/AZone)', NOW), undefined);
});
