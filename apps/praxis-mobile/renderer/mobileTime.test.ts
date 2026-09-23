import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClock, formatDayAndClock, parseInstant } from './mobileTime';

test('ISO instants are read without the engine’s Date parser', () => {
  assert.equal(parseInstant('2026-09-23T10:21:58.812Z'), Date.UTC(2026, 8, 23, 10, 21, 58, 812));
  assert.equal(parseInstant('2026-09-23T11:21:58+01:00'), Date.UTC(2026, 8, 23, 10, 21, 58));
  assert.equal(parseInstant('2026-09-23T10:21Z'), Date.UTC(2026, 8, 23, 10, 21));
  assert.equal(parseInstant('not a time'), undefined);
  assert.equal(parseInstant(undefined), undefined);
});

test('times are shown as local HH:MM, and nothing when unreadable', () => {
  const local = new Date(Date.UTC(2026, 8, 23, 10, 21, 58));
  const expected = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  assert.equal(formatClock('2026-09-23T10:21:58.812Z'), expected);
  assert.equal(formatClock('garbage'), '');
  assert.match(formatDayAndClock('2026-09-23T10:21:58.812Z') ?? '', /^Sep \d{1,2}, \d{2}:\d{2}$/);
  assert.equal(formatDayAndClock(undefined), undefined);
});
