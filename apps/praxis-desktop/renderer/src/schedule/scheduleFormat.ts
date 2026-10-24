import type { ScheduledRunStatus, ScheduledRunView } from '@praxis/core';
import type { ChipSelectOption } from '../ui/ChipSelect';

/**
 * Display helpers for scheduled runs (FX-BF-047). Pure, and deliberately free of
 * value imports from core (the renderer cannot take them): the grouping and wording
 * here are presentation only, the rules about what a run may do live in core.
 */

export interface ScheduledRunGroups {
  running: ScheduledRunView[];
  upNext: ScheduledRunView[];
  attention: ScheduledRunView[];
  drafts: ScheduledRunView[];
  finished: ScheduledRunView[];
}

export const STATUS_LABEL: Record<ScheduledRunStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  missed: 'Missed',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Skipped',
  failed: 'Failed'
};

/** Soonest start first within each group, which is how the lineup reads. */
export function groupScheduledRuns(views: readonly ScheduledRunView[]): ScheduledRunGroups {
  const groups: ScheduledRunGroups = { running: [], upNext: [], attention: [], drafts: [], finished: [] };
  for (const view of views) {
    switch (view.run.status) {
      case 'running': groups.running.push(view); break;
      case 'scheduled': groups.upNext.push(view); break;
      case 'missed':
      case 'paused':
      case 'failed': groups.attention.push(view); break;
      case 'draft': groups.drafts.push(view); break;
      default: groups.finished.push(view);
    }
  }
  const byStart = (a: ScheduledRunView, b: ScheduledRunView) => Date.parse(a.run.scheduledStartAt) - Date.parse(b.run.scheduledStartAt);
  for (const key of Object.keys(groups) as Array<keyof ScheduledRunGroups>) groups[key].sort(byStart);
  // The most recent finished run first.
  groups.finished.reverse();
  return groups;
}

/** "Wed 21 Oct, 22:00", in the schedule's own timezone so it matches what was typed. */
export function formatStart(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "in 11h 48m", "in 3 days", or "overdue". */
export function describeCountdown(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return 'due now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export interface DisplayIssue {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
}

/**
 * Readiness repeats one warning per ticket ("SCH-1 has no acceptance criteria", "SCH-2 …"), which buries
 * everything else on a long belt. Those collapse into one line naming the tickets; any other issue is kept as is.
 */
export function condenseIssues(issues: ReadonlyArray<{ code: string; severity: 'blocker' | 'warning'; message: string }>): DisplayIssue[] {
  const out: DisplayIssue[] = [];
  const noCriteria = issues.filter(issue => issue.code === 'no-acceptance-criteria');
  for (const issue of issues) {
    if (issue.code !== 'no-acceptance-criteria') out.push({ code: issue.code, severity: issue.severity, message: issue.message });
  }
  if (noCriteria.length === 1) out.push({ ...noCriteria[0] });
  if (noCriteria.length > 1) {
    const keys = noCriteria.map(issue => issue.message.split(' ')[0]);
    const shown = keys.length > 3 ? `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more` : keys.join(', ');
    out.push({
      code: 'no-acceptance-criteria',
      severity: 'warning',
      message: `${noCriteria.length} tickets have no acceptance criteria (${shown}), so the agent may stop to ask.`
    });
  }
  return out;
}

/** The viewer's own IANA zone, which is the sensible default for a new schedule. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timeZoneOptions(current: string): ChipSelectOption[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const set = new Set<string>(['UTC', localTimeZone(), current, ...zones]);
  return [...set].filter(Boolean).sort().map(zone => ({ value: zone, label: zone }));
}

/** Tomorrow's date as `YYYY-MM-DD` in the local zone, the default start for a new schedule. */
export function tomorrowDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** "12k tokens · $0.42", or "No usage reported" — spend the provider did not report is never invented. */
export function formatSpend(spend: { tokens?: number; cost?: number; currency?: string } | undefined): string {
  if (!spend || (spend.tokens === undefined && spend.cost === undefined)) return 'No usage reported';
  const parts: string[] = [];
  if (spend.tokens !== undefined) parts.push(spend.tokens >= 1000 ? `${Math.round(spend.tokens / 100) / 10}k tokens` : `${spend.tokens} tokens`);
  if (spend.cost !== undefined && spend.currency) {
    try {
      parts.push(new Intl.NumberFormat(undefined, { style: 'currency', currency: spend.currency }).format(spend.cost));
    } catch {
      parts.push(`${spend.cost.toFixed(2)} ${spend.currency}`);
    }
  }
  return parts.join(' · ');
}

/** "1h 05m", "7m 12s", "42s"; empty when either end is missing or the span is negative. */
export function formatSpan(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso || !endIso) return '';
  const seconds = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

export const ENTRY_STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting',
  running: 'Running',
  paused: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped'
};
