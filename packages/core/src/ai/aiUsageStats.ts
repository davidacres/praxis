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

import type { AiProvider } from '../types';
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

/** Cost never summed across currencies; an empty list means "not reported", which is not the same as zero. */
export type UsageCost = Array<{ currency: string; amount: number }>;

export interface ModelUsage {
  model: string;
  provider?: AiProvider;
  totalTokens: number;
  /** Fraction (0..1) of the window's total tokens. */
  tokenShare: number;
  eventCount: number;
  /** Empty when no event for this model reported cost. */
  costByCurrency: UsageCost;
}

export interface UsagePeak {
  /** ISO 8601 UTC start of the busiest sub-period. */
  periodStart: string;
  granularity: UsageGranularity;
  totalTokens: number;
}

export interface UsageWindowSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  eventCount: number;
  costByCurrency: UsageCost;
  /** Ranked by tokens, highest first. */
  models: ModelUsage[];
  /** Busiest sub-period inside this window: hour for today, day for week/month, month for all time. */
  peak?: UsagePeak;
}

export interface UsageAllTimeSummary extends UsageWindowSummary {
  /** The ledger is capped, so "all time" is only as old as its first event. */
  firstEventAt?: string;
  lastEventAt?: string;
}

export interface UsageDashboardSummary {
  generatedAt: string;
  today: UsageWindowSummary;
  week: UsageWindowSummary;
  month: UsageWindowSummary;
  allTime: UsageAllTimeSummary;
  /** Busiest day, week and month across the whole ledger, by tokens. */
  highs: { day?: UsagePeak; week?: UsagePeak; month?: UsagePeak };
}

interface WindowAccumulator {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  eventCount: number;
  cost: Map<string, number>;
  models: Map<string, { model: string; provider?: AiProvider; totalTokens: number; eventCount: number; cost: Map<string, number> }>;
}

function newAccumulator(): WindowAccumulator {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, eventCount: 0, cost: new Map(), models: new Map() };
}

function costList(cost: Map<string, number>): UsageCost {
  return [...cost.entries()].map(([currency, amount]) => ({ currency, amount })).sort((left, right) => right.amount - left.amount);
}

function accumulate(acc: WindowAccumulator, event: AiUsageEvent): void {
  const tokens = typeof event.totalTokens === 'number' ? event.totalTokens : 0;
  acc.eventCount += 1;
  acc.totalTokens += tokens;
  if (typeof event.inputTokens === 'number') acc.inputTokens += event.inputTokens;
  if (typeof event.outputTokens === 'number') acc.outputTokens += event.outputTokens;
  const reportsCost = !!event.cost && Number.isFinite(event.cost.amount);
  if (reportsCost) acc.cost.set(event.cost!.currency, (acc.cost.get(event.cost!.currency) ?? 0) + event.cost!.amount);

  const model = event.model || 'Unknown model';
  const key = `${event.provider ?? ''}\u0000${model}`;
  let entry = acc.models.get(key);
  if (!entry) {
    entry = { model, provider: event.provider, totalTokens: 0, eventCount: 0, cost: new Map() };
    acc.models.set(key, entry);
  }
  entry.eventCount += 1;
  entry.totalTokens += tokens;
  if (reportsCost) entry.cost.set(event.cost!.currency, (entry.cost.get(event.cost!.currency) ?? 0) + event.cost!.amount);
}

type PeakMap = Map<number, number>;

function bump(map: PeakMap, key: number, tokens: number): void {
  map.set(key, (map.get(key) ?? 0) + tokens);
}

/** Busiest entry at or after `from` (and before `to`); an earlier period wins a tie so the answer is stable. */
function busiest(map: PeakMap, granularity: UsageGranularity, from = -Infinity, to = Infinity): UsagePeak | undefined {
  let best: { key: number; tokens: number } | undefined;
  for (const [key, tokens] of [...map.entries()].sort((left, right) => left[0] - right[0])) {
    if (key < from || key >= to || tokens <= 0) continue;
    if (!best || tokens > best.tokens) best = { key, tokens };
  }
  return best && { periodStart: new Date(best.key).toISOString(), granularity, totalTokens: best.tokens };
}

function finalize(acc: WindowAccumulator, peak: UsagePeak | undefined): UsageWindowSummary {
  const models = [...acc.models.values()]
    .map<ModelUsage>(entry => ({
      model: entry.model,
      provider: entry.provider,
      totalTokens: entry.totalTokens,
      tokenShare: acc.totalTokens > 0 ? entry.totalTokens / acc.totalTokens : 0,
      eventCount: entry.eventCount,
      costByCurrency: costList(entry.cost)
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
  return {
    totalTokens: acc.totalTokens,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    eventCount: acc.eventCount,
    costByCurrency: costList(acc.cost),
    models,
    peak
  };
}

/**
 * Everything the Overview usage panel and the Settings model breakdown show,
 * in one pass over the ledger — today / this week / this month / all time, each
 * with a per-model breakdown, plus the busiest day, week and month overall.
 * Reuses `periodStart`, so "this week" means exactly what `usageSeries` says.
 */
export function dashboardUsageSummary(events: readonly AiUsageEvent[], referenceDate: Date = new Date()): UsageDashboardSummary {
  const dayStart = periodStart(referenceDate, 'day');
  const weekStart = periodStart(referenceDate, 'week');
  const monthStart = periodStart(referenceDate, 'month');
  const dayEnd = nextPeriodStart(dayStart, 'day').getTime();
  const weekEnd = nextPeriodStart(weekStart, 'week').getTime();
  const monthEnd = nextPeriodStart(monthStart, 'month').getTime();

  const today = newAccumulator();
  const week = newAccumulator();
  const month = newAccumulator();
  const all = newAccumulator();
  const hours: PeakMap = new Map();
  const days: PeakMap = new Map();
  const weeks: PeakMap = new Map();
  const months: PeakMap = new Map();
  let first: number | undefined;
  let last: number | undefined;

  for (const event of events) {
    const at = new Date(event.timestamp);
    const time = at.getTime();
    if (Number.isNaN(time)) continue;
    accumulate(all, event);
    if (first === undefined || time < first) first = time;
    if (last === undefined || time > last) last = time;
    if (time >= dayStart.getTime() && time < dayEnd) accumulate(today, event);
    if (time >= weekStart.getTime() && time < weekEnd) accumulate(week, event);
    if (time >= monthStart.getTime() && time < monthEnd) accumulate(month, event);
    const tokens = typeof event.totalTokens === 'number' ? event.totalTokens : 0;
    bump(hours, periodStart(at, 'hour').getTime(), tokens);
    bump(days, periodStart(at, 'day').getTime(), tokens);
    bump(weeks, periodStart(at, 'week').getTime(), tokens);
    bump(months, periodStart(at, 'month').getTime(), tokens);
  }

  return {
    generatedAt: referenceDate.toISOString(),
    today: finalize(today, busiest(hours, 'hour', dayStart.getTime(), dayEnd)),
    week: finalize(week, busiest(days, 'day', weekStart.getTime(), weekEnd)),
    month: finalize(month, busiest(days, 'day', monthStart.getTime(), monthEnd)),
    allTime: {
      ...finalize(all, busiest(months, 'month')),
      firstEventAt: first === undefined ? undefined : new Date(first).toISOString(),
      lastEventAt: last === undefined ? undefined : new Date(last).toISOString()
    },
    highs: { day: busiest(days, 'day'), week: busiest(weeks, 'week'), month: busiest(months, 'month') }
  };
}
