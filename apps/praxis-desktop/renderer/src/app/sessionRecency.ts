import type { AgentSessionRecord } from '@praxis/core';

/**
 * Recency grouping for the sidebar's session ledger (E6 design).
 *
 * Sessions and team chats share one flat feed per project, ordered by last
 * activity and split into Today, This week (the last seven days),
 * Last week (the preceding seven days), and Older.
 * The buckets are labels, not folders — rows keep their own order inside a
 * bucket, and the feed stays one continuous list the SessionOrganizer can
 * reorder.
 */

export type RecencyBucket = 'today' | 'this-week' | 'last-week' | 'older';

export const RECENCY_BUCKET_LABEL: Record<RecencyBucket, string> = {
  today: 'Today',
  'this-week': 'This week',
  'last-week': 'Last week',
  older: 'Older'
};

/** The recency buckets in feed order. */
export const RECENCY_BUCKETS: RecencyBucket[] = ['today', 'this-week', 'last-week', 'older'];

/**
 * When a session was last touched: its completion time when it has one, then
 * the newest event on its transcript, then its start. Older records carry only
 * `startedAt`, so that is the floor rather than "now" — a session with no
 * activity since launch belongs where it started.
 */
export function sessionLastActivityAt(session: AgentSessionRecord): string {
  const lastEvent = session.events?.[session.events.length - 1]?.timestamp;
  return session.completedAt ?? lastEvent ?? session.startedAt;
}

export function recencyBucket(isoTimestamp: string, now: Date = new Date()): RecencyBucket {
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) return 'older';
  const day = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  const time = when.getTime();
  if (time >= day(0)) return 'today';
  if (time >= day(6)) return 'this-week';
  if (time >= day(13)) return 'last-week';
  return 'older';
}

/**
 * "1m ago" style relative times for the right edge of a ledger row. Under a
 * minute reads as "now"; past six weeks an absolute date is more useful than
 * "43d ago", so the label stops ageing there.
 */
export function relativeTime(isoTimestamp: string | undefined, now: Date = new Date()): string | undefined {
  if (!isoTimestamp) return undefined;
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) return undefined;
  const seconds = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 42) return `${days}d ago`;
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
