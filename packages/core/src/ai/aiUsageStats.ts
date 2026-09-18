/**
 * Aggregates the `AiUsageLog` ledger into chartable buckets (day/week/month)
 * and a latest-vs-previous-period comparison. Lives in core, not the
 * renderer: it's plain data transformation over a large event list, and
 * running it here means only the already-bucketed result — small, JSON-safe
 * — crosses the IPC boundary, not the raw log.
 *
 * All bucket boundaries are UTC. A week starts Monday (ISO-8601), not the
 * viewer's locale week — the log has no per-event timezone to render "the
 * user's Monday" correctly anyway, so a fixed, documented convention beats a
 * silently wrong local one.
 */

import type { AiUsageEvent, AiUsageSource } from './aiUsageLog';

export type UsageGranularity = 'hour' | 'day' | 'week' | 'month';

export interface UsageBucket {
  /** ISO 8601 UTC instant marking the start of this bucket. */
  periodStart: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  eventCount: number;
  /** Never summed across currencies — see `AiUsageStatsSummary`'s doc. */
  costByCurrency: Array<{ currency: string; amount: number }>;
  byModel: Array<{ model: string; totalTokens: number }>;
  bySource: Partial<Record<AiUsageSource, number>>;
}

export interface UsageComparison {
  granularity: UsageGranularity;
  current: UsageBucket;
  previous: UsageBucket;
  deltaTokens: number;
  /** Undefined when the previous period reported zero tokens — a percentage against zero is not a real number. */
  deltaPercent: number | undefined;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcHour(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

/** Monday of the ISO week containing `date`, at UTC midnight. */
function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  // getUTCDay(): 0=Sunday..6=Saturday. Distance back to Monday.
  const weekday = day.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function periodStart(date: Date, granularity: UsageGranularity): Date {
  switch (granularity) {
    case 'hour':
      return startOfUtcHour(date);
    case 'day':
      return startOfUtcDay(date);
    case 'week':
      return startOfUtcWeek(date);
    case 'month':
      return startOfUtcMonth(date);
  }
}

function nextPeriodStart(start: Date, granularity: UsageGranularity): Date {
  const next = new Date(start);
  switch (granularity) {
    case 'hour':
      next.setUTCHours(next.getUTCHours() + 1);
      return next;
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
  }
}

function previousPeriodStart(start: Date, granularity: UsageGranularity): Date {
  const prev = new Date(start);
  switch (granularity) {
    case 'hour':
      prev.setUTCHours(prev.getUTCHours() - 1);
      return prev;
    case 'day':
      prev.setUTCDate(prev.getUTCDate() - 1);
      return prev;
    case 'week':
      prev.setUTCDate(prev.getUTCDate() - 7);
      return prev;
    case 'month':
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      return prev;
  }
}

function emptyBucket(start: Date): UsageBucket {
  return {
    periodStart: start.toISOString(),
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    eventCount: 0,
    costByCurrency: [],
    byModel: [],
    bySource: {}
  };
}

function addEventToBucket(bucket: UsageBucket, event: AiUsageEvent, costTotals: Map<string, number>, modelTotals: Map<string, number>): void {
  bucket.eventCount += 1;
  if (typeof event.totalTokens === 'number') bucket.totalTokens += event.totalTokens;
  if (typeof event.inputTokens === 'number') bucket.inputTokens += event.inputTokens;
  if (typeof event.outputTokens === 'number') bucket.outputTokens += event.outputTokens;
  if (event.cost && Number.isFinite(event.cost.amount)) {
    costTotals.set(event.cost.currency, (costTotals.get(event.cost.currency) ?? 0) + event.cost.amount);
  }
  if (event.model && typeof event.totalTokens === 'number') {
    modelTotals.set(event.model, (modelTotals.get(event.model) ?? 0) + event.totalTokens);
  }
  bucket.bySource[event.source] = (bucket.bySource[event.source] ?? 0) + (event.totalTokens ?? 0);
}

/**
 * `periodsBack` consecutive buckets ending with (and including) the bucket
 * containing `referenceDate`, oldest first. A period with no events still
 * appears, zeroed — a chart with silently-skipped gaps reads as "no data
 * exists" instead of "nothing happened", and week-over-week comparison needs
 * the immediately preceding bucket to exist even when it's empty.
 */
export function usageSeries(
  events: readonly AiUsageEvent[],
  granularity: UsageGranularity,
  periodsBack: number,
  referenceDate: Date = new Date()
): UsageBucket[] {
  const latestStart = periodStart(referenceDate, granularity);
  const starts: Date[] = [latestStart];
  for (let i = 1; i < periodsBack; i++) {
    starts.unshift(previousPeriodStart(starts[0], granularity));
  }

  const buckets = new Map<string, { bucket: UsageBucket; costTotals: Map<string, number>; modelTotals: Map<string, number> }>();
  for (const start of starts) {
    buckets.set(start.toISOString(), { bucket: emptyBucket(start), costTotals: new Map(), modelTotals: new Map() });
  }

  const rangeStart = starts[0];
  const rangeEnd = nextPeriodStart(starts[starts.length - 1], granularity);

  for (const event of events) {
    const at = new Date(event.timestamp);
    if (Number.isNaN(at.getTime()) || at < rangeStart || at >= rangeEnd) {
      continue;
    }
    const key = periodStart(at, granularity).toISOString();
    const entry = buckets.get(key);
    if (!entry) continue; // shouldn't happen given the range check, but never crash a stats view over it
    addEventToBucket(entry.bucket, event, entry.costTotals, entry.modelTotals);
  }

  return starts.map(start => {
    const entry = buckets.get(start.toISOString())!;
    entry.bucket.costByCurrency = [...entry.costTotals.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((left, right) => right.amount - left.amount);
    entry.bucket.byModel = [...entry.modelTotals.entries()]
      .map(([model, totalTokens]) => ({ model, totalTokens }))
      .sort((left, right) => right.totalTokens - left.totalTokens);
    return entry.bucket;
  });
}

/** The latest complete-so-far period against the one immediately before it — "more or less AI than last week", generalised to any granularity. */
export function compareLatestPeriod(
  events: readonly AiUsageEvent[],
  granularity: UsageGranularity,
  referenceDate: Date = new Date()
): UsageComparison {
  const [previous, current] = usageSeries(events, granularity, 2, referenceDate);
  const deltaTokens = current.totalTokens - previous.totalTokens;
  const deltaPercent = previous.totalTokens > 0 ? (deltaTokens / previous.totalTokens) * 100 : undefined;
  return { granularity, current, previous, deltaTokens, deltaPercent };
}
