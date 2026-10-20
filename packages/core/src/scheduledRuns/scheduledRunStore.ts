/**
 * Durable storage for scheduled runs (FX-BF-047 / FX-BE-147 / TASK-383).
 *
 * Same shape as `projects/deploymentRunStore.ts`: a `KeyValueStore`-backed list,
 * `save` replacing by id, and a defensive `normalizeScheduledRun` so one
 * malformed record comes back as a best-effort run instead of hiding every
 * other schedule beside it. The normaliser is also the migration point: a record
 * written before a field existed gains it here.
 */

import type { KeyValueStore } from '../host/stateStore';
import {
  SCHEDULED_RUN_SCHEMA_VERSION,
  isValidTimeZone,
  reconcileScheduledRunOnLaunch,
  renumberEntries,
  type ScheduledEntryOutcome,
  type ScheduledEntryStatus,
  type ScheduledQueueEntry,
  type ScheduledRun,
  type ScheduledRunAttempt,
  type ScheduledRunEvent,
  type ScheduledRunStatus
} from './scheduledRun';

const RUNS_KEY = 'praxis.scheduledRuns.v1';

const RUN_STATUSES: ReadonlySet<string> = new Set(['draft', 'scheduled', 'missed', 'running', 'paused', 'completed', 'cancelled', 'failed']);
const ENTRY_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'paused', 'done', 'failed', 'skipped']);
const EVENT_KINDS: ReadonlySet<string> = new Set([
  'created', 'renamed', 'tickets-added', 'ticket-removed', 'reordered', 'rescheduled', 'armed', 'held', 'missed', 'start-now', 'skipped'
]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeOutcome(value: unknown): ScheduledEntryOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const status = typeof raw.status === 'string' && ENTRY_STATUSES.has(raw.status) ? (raw.status as ScheduledEntryStatus) : 'queued';
  return {
    status,
    ...(text(raw.sessionId) ? { sessionId: text(raw.sessionId) } : {}),
    ...(text(raw.workflowRunId) ? { workflowRunId: text(raw.workflowRunId) } : {}),
    ...(text(raw.startedAt) ? { startedAt: text(raw.startedAt) } : {}),
    ...(text(raw.endedAt) ? { endedAt: text(raw.endedAt) } : {}),
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {})
  };
}

function normalizeEntry(value: unknown, fallbackSequence: number): ScheduledQueueEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const ticket = raw.ticket && typeof raw.ticket === 'object' ? (raw.ticket as Record<string, unknown>) : undefined;
  const id = text(raw.id);
  const connectionId = text(ticket?.connectionId);
  const issueKey = text(ticket?.issueKey);
  if (!id || !connectionId || !issueKey) return undefined;
  const outcome = normalizeOutcome(raw.outcome);
  return {
    id,
    sequence: typeof raw.sequence === 'number' && Number.isFinite(raw.sequence) ? raw.sequence : fallbackSequence,
    ticket: { connectionId, issueKey, title: text(ticket?.title) ?? issueKey },
    ...(outcome ? { outcome } : {})
  };
}

function normalizeAttempt(value: unknown): ScheduledRunAttempt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  const startedAt = text(raw.startedAt);
  if (!id || !startedAt) return undefined;
  return {
    id,
    trigger: raw.trigger === 'start-now' ? 'start-now' : 'schedule',
    startedAt,
    ...(text(raw.endedAt) ? { endedAt: text(raw.endedAt) } : {})
  };
}

function normalizeEvent(value: unknown): ScheduledRunEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const at = text(raw.at);
  const message = text(raw.message);
  if (!at || !message || typeof raw.kind !== 'string' || !EVENT_KINDS.has(raw.kind)) return undefined;
  return { at, kind: raw.kind as ScheduledRunEvent['kind'], message, ...(text(raw.entryId) ? { entryId: text(raw.entryId) } : {}) };
}

/** Parses whatever the store hands back; `undefined` only when the record is unusable (no id, name or valid start). */
export function normalizeScheduledRun(value: unknown): ScheduledRun | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  const name = text(raw.name);
  const start = text(raw.scheduledStartAt);
  if (!id || !name || !start || !Number.isFinite(Date.parse(start))) return undefined;

  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((entry, index) => normalizeEntry(entry, index + 1))
    .filter((entry): entry is ScheduledQueueEntry => !!entry);
  // Stable by stored sequence, ties broken by position, then renumbered so the sequence is always contiguous.
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.sequence - b.entry.sequence || a.index - b.index)
    .map(item => item.entry);

  const createdAt = text(raw.createdAt) ?? start;
  return {
    schemaVersion: SCHEDULED_RUN_SCHEMA_VERSION,
    id,
    name,
    ...(text(raw.projectId) ? { projectId: text(raw.projectId) } : {}),
    scheduledStartAt: new Date(start).toISOString(),
    timezone: text(raw.timezone) && isValidTimeZone(raw.timezone as string) ? (raw.timezone as string) : 'UTC',
    policy: { mode: 'sequential' },
    entries: renumberEntries(ordered),
    status: typeof raw.status === 'string' && RUN_STATUSES.has(raw.status) ? (raw.status as ScheduledRunStatus) : 'draft',
    attempts: (Array.isArray(raw.attempts) ? raw.attempts : []).map(normalizeAttempt).filter((a): a is ScheduledRunAttempt => !!a),
    createdAt,
    updatedAt: text(raw.updatedAt) ?? createdAt,
    events: (Array.isArray(raw.events) ? raw.events : []).map(normalizeEvent).filter((e): e is ScheduledRunEvent => !!e)
  };
}

export class ScheduledRunStore {
  public constructor(private readonly state: KeyValueStore) {}

  /** Soonest start first, so the lineup and the close warning agree on what is next. */
  public list(): ScheduledRun[] {
    const value = this.state.get<unknown[]>(RUNS_KEY);
    if (!Array.isArray(value)) return [];
    return value
      .map(entry => normalizeScheduledRun(entry))
      .filter((entry): entry is ScheduledRun => !!entry)
      .sort((left, right) => Date.parse(left.scheduledStartAt) - Date.parse(right.scheduledStartAt));
  }

  public get(id: string): ScheduledRun | undefined {
    return this.list().find(run => run.id === id);
  }

  /** Inserts or replaces a run. The run is the unit of atomicity. */
  public async save(run: ScheduledRun): Promise<ScheduledRun> {
    const runs = this.list();
    const index = runs.findIndex(candidate => candidate.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await this.state.update(RUNS_KEY, runs);
    return run;
  }

  public async remove(id: string): Promise<void> {
    const runs = this.list();
    const next = runs.filter(run => run.id !== id);
    if (next.length === runs.length) throw new Error(`Scheduled run ${id} was not found.`);
    await this.state.update(RUNS_KEY, next);
  }

  /**
   * Marks every armed run whose start passed as missed and persists the change.
   * Call once at launch. Returns the runs that changed.
   */
  public async reconcileOnLaunch(now: string): Promise<ScheduledRun[]> {
    const runs = this.list();
    const changed: ScheduledRun[] = [];
    const next = runs.map(run => {
      const reconciled = reconcileScheduledRunOnLaunch(run, now);
      if (reconciled !== run) changed.push(reconciled);
      return reconciled;
    });
    if (changed.length > 0) await this.state.update(RUNS_KEY, next);
    return changed;
  }
}
