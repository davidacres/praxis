import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLatestPeriod, periodStart, usageSeries } from './aiUsageStats';
import type { AiUsageEvent } from './aiUsageLog';

function event(partial: Partial<AiUsageEvent> & { timestamp: string; totalTokens: number }): AiUsageEvent {
  return {
    id: `id-${partial.timestamp}-${Math.random()}`,
    source: 'session',
    ...partial
  };
}

test('periodStart: week starts on Monday (ISO), not Sunday', () => {
  // 2026-09-16 is a Wednesday.
  const wednesday = new Date('2026-09-16T12:00:00.000Z');
  const start = periodStart(wednesday, 'week');
  assert.equal(start.getUTCDay(), 1); // Monday
  assert.equal(start.toISOString(), '2026-09-14T00:00:00.000Z');
});

test('periodStart: day and month bucket to UTC midnight', () => {
  const at = new Date('2026-09-16T23:59:00.000Z');
  assert.equal(periodStart(at, 'day').toISOString(), '2026-09-16T00:00:00.000Z');
  assert.equal(periodStart(at, 'month').toISOString(), '2026-09-01T00:00:00.000Z');
});

test('usageSeries: sums tokens per day and zero-fills empty periods', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z'); // Wednesday
  const events: AiUsageEvent[] = [
    event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 100, inputTokens: 60, outputTokens: 40 }),
    event({ timestamp: '2026-09-16T11:00:00.000Z', totalTokens: 50, inputTokens: 20, outputTokens: 30 }),
    // Two days ago — should land in its own bucket, not today's.
    event({ timestamp: '2026-09-14T09:00:00.000Z', totalTokens: 20, inputTokens: 10, outputTokens: 10 })
  ];

  const series = usageSeries(events, 'day', 4, reference);
  assert.equal(series.length, 4);
  // Oldest first: Sep 13 (empty), Sep 14 (20), Sep 15 (empty), Sep 16 (150).
  assert.equal(series[0].totalTokens, 0);
  assert.equal(series[0].eventCount, 0);
  assert.equal(series[1].totalTokens, 20);
  assert.equal(series[2].totalTokens, 0);
  assert.equal(series[3].totalTokens, 150);
  assert.equal(series[3].inputTokens, 80);
  assert.equal(series[3].outputTokens, 70);
  assert.equal(series[3].eventCount, 2);
});

test('usageSeries: an event outside the requested window is dropped, not misfiled', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z');
  const events: AiUsageEvent[] = [event({ timestamp: '2020-01-01T00:00:00.000Z', totalTokens: 999 })];
  const series = usageSeries(events, 'day', 3, reference);
  assert.equal(series.reduce((sum, bucket) => sum + bucket.totalTokens, 0), 0);
});

test('usageSeries: cost is grouped by currency, never summed across currencies', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z');
  const events: AiUsageEvent[] = [
    event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 10, cost: { amount: 1.5, currency: 'USD' } }),
    event({ timestamp: '2026-09-16T09:30:00.000Z', totalTokens: 10, cost: { amount: 0.8, currency: 'USD' } }),
    event({ timestamp: '2026-09-16T09:45:00.000Z', totalTokens: 10, cost: { amount: 2, currency: 'EUR' } })
  ];
  const [today] = usageSeries(events, 'day', 1, reference);
  const usd = today.costByCurrency.find(entry => entry.currency === 'USD');
  const eur = today.costByCurrency.find(entry => entry.currency === 'EUR');
  assert.ok(usd);
  assert.ok(eur);
  assert.equal(Math.round((usd!.amount + Number.EPSILON) * 100) / 100, 2.3);
  assert.equal(eur!.amount, 2);
});

test('usageSeries: source totals split correctly', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z');
  const events: AiUsageEvent[] = [
    event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 100, source: 'session' }),
    event({ timestamp: '2026-09-16T09:30:00.000Z', totalTokens: 40, source: 'workflow-recommendation' })
  ];
  const [today] = usageSeries(events, 'day', 1, reference);
  assert.equal(today.bySource.session, 100);
  assert.equal(today.bySource['workflow-recommendation'], 40);
});

test('compareLatestPeriod: reports a positive delta when this period used more', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z');
  const events: AiUsageEvent[] = [
    event({ timestamp: '2026-09-15T09:00:00.000Z', totalTokens: 100 }), // yesterday
    event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 150 }) // today
  ];
  const comparison = compareLatestPeriod(events, 'day', reference);
  assert.equal(comparison.previous.totalTokens, 100);
  assert.equal(comparison.current.totalTokens, 150);
  assert.equal(comparison.deltaTokens, 50);
  assert.equal(comparison.deltaPercent, 50);
});

test('compareLatestPeriod: deltaPercent is undefined (not Infinity) when the previous period was empty', () => {
  const reference = new Date('2026-09-16T10:00:00.000Z');
  const events: AiUsageEvent[] = [event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 150 })];
  const comparison = compareLatestPeriod(events, 'day', reference);
  assert.equal(comparison.previous.totalTokens, 0);
  assert.equal(comparison.deltaPercent, undefined);
});
