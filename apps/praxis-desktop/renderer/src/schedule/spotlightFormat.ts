import type { ScheduledQueueEntry, ScheduledStageDetail } from '@praxis/core';

/**
 * Pure display helpers for the Spotlight monitor, the Line composer and the run
 * report (FX-BE-193). No React and no value imports from core, so they can be
 * unit-tested directly (`test/scheduleSpotlight.test.ts`).
 */

/** A bead's state; the composer's rehearsal uses the same set as the live run. */
export type BeadState = 'queued' | 'running' | 'waiting' | 'failed' | 'done' | 'skipped';

/** "SCH-12" stays; "PRX-T111-487" becomes "487", so a long rail still reads. */
export function shortKey(issueKey: string): string {
  const parts = issueKey.split('-');
  return parts.length > 2 ? parts[parts.length - 1] : issueKey;
}

/** Steps numbered from 1, as the runner groups them (`withPrevious`). */
export function stepNumbers(entries: readonly Pick<ScheduledQueueEntry, 'id' | 'withPrevious'>[]): Map<string, number> {
  const steps = new Map<string, number>();
  let step = 0;
  entries.forEach((entry, index) => {
    if (index === 0 || !entry.withPrevious) step += 1;
    steps.set(entry.id, step);
  });
  return steps;
}

export function entryBeadState(entry: ScheduledQueueEntry, pausedEntryId?: string): BeadState {
  const status = entry.outcome?.status ?? 'queued';
  if (status === 'done') return 'done';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') return 'failed';
  if (status === 'paused' || pausedEntryId === entry.id) return 'waiting';
  if (status === 'running') return 'running';
  return 'queued';
}

/** "42s", "7m 12s", "1h 05m". */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "22:00" in the schedule's own timezone. */
export function formatHourMinute(iso: string | undefined, timezone: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

export function formatMoney(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined || !currency) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount >= 100 ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** How long a stage took, or has been going. A running stage's time comes from its reported start. */
export function stageTime(stage: ScheduledStageDetail, now: number): string {
  if (stage.durationMs !== undefined && stage.lane !== 'running') return formatMs(stage.durationMs);
  if ((stage.lane === 'running' || stage.lane === 'awaiting' || stage.lane === 'paused') && stage.startedAt) return formatMs(now - Date.parse(stage.startedAt));
  return '';
}

