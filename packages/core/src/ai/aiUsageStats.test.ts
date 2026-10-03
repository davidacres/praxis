import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLatestPeriod, dashboardUsageSummary, periodStart, usageSeries } from './aiUsageStats';
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

test('periodStart: hour buckets to the UTC hour', () => {
  const at = new Date('2026-09-16T23:59:42.000Z');
  assert.equal(periodStart(at, 'hour').toISOString(), '2026-09-16T23:00:00.000Z');
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

// Wednesday 2026-09-16; week starts Monday 2026-09-14; month starts 2026-09-01.
const NOW = new Date('2026-09-16T12:00:00.000Z');

function ledger(): AiUsageEvent[] {
  return [
    event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 100, inputTokens: 60, outputTokens: 40, provider: 'claude-code-cli', model: 'opus', cost: { amount: 0.5, currency: 'USD' } }),
    event({ timestamp: '2026-09-16T10:00:00.000Z', totalTokens: 300, provider: 'openai', model: 'gpt' }),
    event({ timestamp: '2026-09-14T09:00:00.000Z', totalTokens: 200, provider: 'claude-code-cli', model: 'opus', cost: { amount: 1, currency: 'USD' } }),
    event({ timestamp: '2026-09-02T09:00:00.000Z', totalTokens: 50, provider: 'openai', model: 'gpt' }),
    event({ timestamp: '2026-08-31T23:59:00.000Z', totalTokens: 1000, provider: 'codex-cli', model: 'codex', cost: { amount: 2, currency: 'EUR' } })
  ];
}

test('dashboardUsageSummary: period totals match usageSeries', () => {
  const events = ledger();
  const summary = dashboardUsageSummary(events, NOW);
  const [day] = usageSeries(events, 'day', 1, NOW);
  const [week] = usageSeries(events, 'week', 1, NOW);
  const [month] = usageSeries(events, 'month', 1, NOW);
  for (const [window, bucket] of [[summary.today, day], [summary.week, week], [summary.month, month]] as const) {
    assert.equal(window.totalTokens, bucket.totalTokens);
    assert.equal(window.inputTokens, bucket.inputTokens);
    assert.equal(window.outputTokens, bucket.outputTokens);
    assert.equal(window.eventCount, bucket.eventCount);
    assert.deepEqual(window.costByCurrency, bucket.costByCurrency);
  }
  assert.equal(summary.today.totalTokens, 400);
  assert.equal(summary.week.totalTokens, 600);
  assert.equal(summary.month.totalTokens, 650);
  assert.equal(summary.allTime.totalTokens, 1650);
  assert.equal(summary.allTime.eventCount, 5);
});

test('dashboardUsageSummary: all-time carries first and last event and keeps currencies separate', () => {
  const { allTime } = dashboardUsageSummary(ledger(), NOW);
  assert.equal(allTime.firstEventAt, '2026-08-31T23:59:00.000Z');
  assert.equal(allTime.lastEventAt, '2026-09-16T10:00:00.000Z');
  assert.deepEqual(allTime.costByCurrency, [{ currency: 'EUR', amount: 2 }, { currency: 'USD', amount: 1.5 }]);
});

test('dashboardUsageSummary: model breakdown ranks, shares and attributes cost to the right model', () => {
  const { allTime, month } = dashboardUsageSummary(ledger(), NOW);
  assert.deepEqual(allTime.models.map(model => model.model), ['codex', 'gpt', 'opus']);
  const opus = allTime.models.find(model => model.model === 'opus')!;
  assert.equal(opus.totalTokens, 300);
  assert.equal(opus.eventCount, 2);
  assert.deepEqual(opus.costByCurrency, [{ currency: 'USD', amount: 1.5 }]);
  assert.equal(opus.provider, 'claude-code-cli');
  assert.ok(Math.abs(allTime.models.reduce((sum, model) => sum + model.tokenShare, 0) - 1) < 1e-9);
  // codex's event is in August, so it is outside the month window.
  assert.deepEqual(month.models.map(model => model.model), ['gpt', 'opus']);
});

test('dashboardUsageSummary: a model that reports no cost has an empty cost list, not zero', () => {
  const { allTime } = dashboardUsageSummary(ledger(), NOW);
  assert.deepEqual(allTime.models.find(model => model.model === 'gpt')!.costByCurrency, []);
  const zero = dashboardUsageSummary([event({ timestamp: '2026-09-16T09:00:00.000Z', totalTokens: 5, model: 'free', cost: { amount: 0, currency: 'USD' } })], NOW);
  assert.deepEqual(zero.allTime.models[0].costByCurrency, [{ currency: 'USD', amount: 0 }]);
});

test('dashboardUsageSummary: highs use UTC boundaries and Monday weeks', () => {
  const { highs } = dashboardUsageSummary(ledger(), NOW);
  assert.deepEqual(highs.day, { periodStart: '2026-08-31T00:00:00.000Z', granularity: 'day', totalTokens: 1000 });
  assert.equal(highs.week?.periodStart, '2026-08-31T00:00:00.000Z');
  assert.equal(highs.week?.totalTokens, 1050);
  assert.equal(highs.month?.periodStart, '2026-08-01T00:00:00.000Z');
});

test('dashboardUsageSummary: period peaks sit inside their own window', () => {
  const summary = dashboardUsageSummary(ledger(), NOW);
  assert.deepEqual(summary.today.peak, { periodStart: '2026-09-16T10:00:00.000Z', granularity: 'hour', totalTokens: 300 });
  assert.equal(summary.week.peak?.periodStart, '2026-09-16T00:00:00.000Z');
  assert.equal(summary.week.peak?.totalTokens, 400);
  assert.equal(summary.allTime.peak?.periodStart, '2026-08-01T00:00:00.000Z');
});

test('dashboardUsageSummary: a tie resolves to the earlier period', () => {
  const tied = dashboardUsageSummary([
    event({ timestamp: '2026-09-15T09:00:00.000Z', totalTokens: 100 }),
    event({ timestamp: '2026-09-14T09:00:00.000Z', totalTokens: 100 })
  ], NOW);
  assert.equal(tied.highs.day?.periodStart, '2026-09-14T00:00:00.000Z');
});

test('dashboardUsageSummary: an empty ledger yields zeroed windows and no peaks', () => {
  const summary = dashboardUsageSummary([], NOW);
  assert.equal(summary.allTime.totalTokens, 0);
  assert.equal(summary.allTime.firstEventAt, undefined);
  assert.deepEqual(summary.allTime.models, []);
  assert.equal(summary.today.peak, undefined);
  assert.deepEqual([summary.highs.day, summary.highs.week, summary.highs.month], [undefined, undefined, undefined]);
});
