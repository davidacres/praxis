import type { ScheduledHandover, ScheduledQueueEntry, ScheduledRunEvent } from '@praxis/core';

/**
 * What the run report shows, consolidated (lineup report redesign "1 · Brief").
 * A long unattended run records hundreds of events, most of them repeats; the
 * report groups them so each kind of thing appears once with a count and the
 * time it cost. Pure and free of value imports from core, so it is unit-tested
 * directly (`test/reportModel.test.ts`).
 */

export type StopKind = 'loop' | 'failure' | 'approval' | 'blocked' | 'other';

export const STOP_LABEL: Record<StopKind, string> = {
  loop: 'Loop decisions',
  failure: 'Failed stages',
  approval: 'Approvals',
  blocked: 'Blocked launches',
  other: 'Other pauses'
};

export interface Stop {
  kind: StopKind;
  at: string;
  /** How long it waited for a person; undefined while it still waits. */
  waitedMs?: number;
  message: string;
  entryId?: string;
  issueKey?: string;
}

const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-[A-Z0-9]+(?:-\d+)?\b/;

/** Which kind of stop an event is, from the words the runner writes. */
export function stopKind(event: Pick<ScheduledRunEvent, 'kind' | 'message'>): StopKind {
  if (event.kind === 'entry-gate' || /waiting for (an )?approval/i.test(event.message)) return 'approval';
  if (/needs a decision|loop back/i.test(event.message)) return 'loop';
  if (/could not be started|uncommitted|needs (local )?workspace trust/i.test(event.message)) return 'blocked';
  if (/failed|interrupted|aborted|made no changes/i.test(event.message)) return 'failure';
  return 'other';
}

/**
 * Every time the run stopped for a person, with how long it waited. A stop is a
 * `paused` or `entry-gate` event; it ends at the next resume, the run's end, or
 * the entry it was about moving on.
 */
export function runStops(events: readonly ScheduledRunEvent[], entries: readonly ScheduledQueueEntry[]): Stop[] {
  const keyOf = new Map(entries.map(entry => [entry.id, entry.ticket.issueKey] as const));
  const stops: Stop[] = [];
  events.forEach((event, index) => {
    if (event.kind !== 'paused' && event.kind !== 'entry-gate') return;
    const end = events.slice(index + 1).find(next =>
      ['resumed', 'completed', 'cancelled'].includes(next.kind) ||
      (!!event.entryId && next.entryId === event.entryId && ['entry-done', 'entry-skipped', 'entry-retried', 'entry-failed'].includes(next.kind)));
    const issueKey = (event.entryId && keyOf.get(event.entryId)) || event.message.match(ISSUE_KEY)?.[0];
    stops.push({
      kind: stopKind(event),
      at: event.at,
      ...(end ? { waitedMs: Math.max(0, Date.parse(end.at) - Date.parse(event.at)) } : {}),
      message: event.message,
      ...(event.entryId ? { entryId: event.entryId } : {}),
      ...(issueKey ? { issueKey } : {})
    });
  });
  return stops;
}

export interface StopGroup { kind: StopKind; count: number; waitedMs: number }

/** Stops of one kind added up, longest wait first. */
export function groupStops(stops: readonly Stop[]): StopGroup[] {
  const groups = new Map<StopKind, StopGroup>();
  for (const stop of stops) {
    const group = groups.get(stop.kind) ?? { kind: stop.kind, count: 0, waitedMs: 0 };
    group.count += 1;
    group.waitedMs += stop.waitedMs ?? 0;
    groups.set(stop.kind, group);
  }
  return [...groups.values()].sort((a, b) => b.waitedMs - a.waitedMs || b.count - a.count);
}

export interface HandoverPair { from: string; to: string; count: number }
export interface HandoverSummary {
  total: number;
  pairs: HandoverPair[];
  firstAt?: string;
  lastAt?: string;
  /** More switches than there are distinct providers to switch to: the ticket bounced. */
  bounced: boolean;
}

/** A ticket's hand-overs folded into from → to pairs with counts. */
export function summarizeHandovers(handovers: readonly ScheduledHandover[]): HandoverSummary {
  const pairs = new Map<string, HandoverPair>();
  for (const handover of handovers) {
    const key = `${handover.from}\u0000${handover.to}`;
    const pair = pairs.get(key) ?? { from: handover.from, to: handover.to, count: 0 };
    pair.count += 1;
    pairs.set(key, pair);
  }
  const providers = new Set(handovers.flatMap(handover => [handover.from, handover.to]));
  return {
    total: handovers.length,
    pairs: [...pairs.values()].sort((a, b) => b.count - a.count),
    ...(handovers.length ? { firstAt: handovers[0].at, lastAt: handovers[handovers.length - 1].at } : {}),
    bounced: handovers.length > Math.max(2, providers.size)
  };
}

export interface LedgerLine { at: string; kind: ScheduledRunEvent['kind']; message: string; count: number; lastAt: string }

/**
 * The raw event log with runs of the same thing folded: consecutive events of one
 * kind about one ticket become a single line with a count ("×109"), so a burst of
 * hand-overs — even ones alternating between two providers — or of budget checks
 * reads as one entry. Pauses and resumes alternate, so they stay apart.
 */
export function collapseLedger(events: readonly ScheduledRunEvent[]): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const shape = (event: ScheduledRunEvent) => `${event.kind}\u0000${event.entryId ?? event.message.match(ISSUE_KEY)?.[0] ?? ''}`;
  let previous: string | undefined;
  for (const event of events) {
    const key = shape(event);
    const last = lines[lines.length - 1];
    if (last && key === previous) {
      last.count += 1;
      last.lastAt = event.at;
    } else {
      lines.push({ at: event.at, kind: event.kind, message: event.message, count: 1, lastAt: event.at });
    }
    previous = key;
  }
  return lines;
}

/** "42s", "7m", "1h 05m"; minutes are enough for a report. */
export function formatWait(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The first line of a long message, trimmed for a list. */
export function firstLine(text: string, max = 140): string {
  const line = text.split(/\n|(?<=\.)\s/)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
