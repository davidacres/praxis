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
  MAX_SCHEDULED_CONCURRENCY,
  SCHEDULED_RUN_SCHEMA_VERSION,
  isValidTimeZone,
  reconcileScheduledRunOnLaunch,
  renumberEntries,
  type ScheduledEntryOutcome,
  type ScheduledEntryStatus,
  type ScheduledHandover,
  type ScheduledPauseReason,
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
  'created', 'renamed', 'tickets-added', 'ticket-removed', 'reordered', 'rescheduled', 'armed', 'held', 'missed', 'start-now', 'skipped',
  'workflow-changed', 'started', 'entry-launching', 'entry-started', 'entry-gate', 'entry-done', 'entry-failed', 'entry-skipped',
  'entry-retried', 'paused', 'resumed', 'budget-checked', 'provider-handover', 'completed', 'cancelled'
]);
const PAUSE_REASONS: ReadonlySet<string> = new Set(['budget', 'approval', 'policy', 'trust', 'no-provider', 'failure', 'user', 'launch-interrupted']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeOutcome(value: unknown): ScheduledEntryOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const status = typeof raw.status === 'string' && ENTRY_STATUSES.has(raw.status) ? (raw.status as ScheduledEntryStatus) : 'queued';
  const gate = normalizeGate(raw.gate);
  const spend = normalizeSpend(raw.spend);
  const estimate = normalizeEstimate(raw.estimate);
  const artifacts = (Array.isArray(raw.artifacts) ? raw.artifacts : []).filter((artifact): artifact is NonNullable<ScheduledEntryOutcome['artifacts']>[number] =>
    !!artifact && typeof artifact === 'object' && ['artifactId', 'contractId', 'nodeId', 'runId', 'kind', 'createdAt'].every(key => typeof artifact[key] === 'string'));
  const handovers = (Array.isArray(raw.handovers) ? raw.handovers : []).map(normalizeHandover).filter((h): h is ScheduledHandover => !!h);
  const exhausted = (Array.isArray(raw.exhausted) ? raw.exhausted : []).filter((value): value is string => typeof value === 'string' && !!value);
  return {
    status,
    ...(text(raw.sessionId) ? { sessionId: text(raw.sessionId) } : {}),
    ...(text(raw.workflowRunId) ? { workflowRunId: text(raw.workflowRunId) } : {}),
    ...(text(raw.startedAt) ? { startedAt: text(raw.startedAt) } : {}),
    ...(text(raw.endedAt) ? { endedAt: text(raw.endedAt) } : {}),
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
    ...(text(raw.provider) ? { provider: text(raw.provider) } : {}),
    ...(text(raw.launchToken) ? { launchToken: text(raw.launchToken) } : {}),
    ...(gate ? { gate } : {}),
    ...(handovers.length > 0 ? { handovers } : {}),
    ...(exhausted.length > 0 ? { exhausted: [...new Set(exhausted)] } : {}),
    ...(spend ? { spend } : {}),
    ...(estimate ? { estimate } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(typeof raw.retries === 'number' && raw.retries > 0 ? { retries: Math.trunc(raw.retries) } : {}),
    ...(typeof raw.lane === 'number' && Number.isInteger(raw.lane) && raw.lane >= 1 ? { lane: raw.lane } : {}),
    ...(text(raw.laneReason) ? { laneReason: text(raw.laneReason) } : {}),
    ...(typeof raw.waitReason === 'string' && PAUSE_REASONS.has(raw.waitReason) ? { waitReason: raw.waitReason as ScheduledPauseReason } : {})
  };
}

/** A stored parallel policy with an impossible concurrency falls back to sequential rather than running wide. */
function storedPolicy(raw: Record<string, unknown> | undefined, workflowId: string | undefined): ScheduledRun['policy'] {
  const max = raw?.mode === 'parallel' ? raw.maxConcurrency : undefined;
  if (typeof max === 'number' && Number.isInteger(max) && max >= 2 && max <= MAX_SCHEDULED_CONCURRENCY) {
    return { mode: 'parallel', maxConcurrency: max, ...(workflowId ? { workflowId } : {}) };
  }
  return { mode: 'sequential', ...(workflowId ? { workflowId } : {}) };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeGate(value: unknown): ScheduledEntryOutcome['gate'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const nodeId = text(raw.nodeId);
  const since = text(raw.since);
  return nodeId && since ? { nodeId, label: text(raw.label) ?? nodeId, since } : undefined;
}

function normalizeSpend(value: unknown): ScheduledEntryOutcome['spend'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const spend = {
    ...(num(raw.tokens) !== undefined ? { tokens: num(raw.tokens) } : {}),
    ...(num(raw.cost) !== undefined ? { cost: num(raw.cost) } : {}),
    ...(text(raw.currency) ? { currency: text(raw.currency) } : {}),
    ...(raw.estimated === true ? { estimated: true } : {})
  };
  return Object.keys(spend).length > 0 ? spend : undefined;
}

function normalizeEstimate(value: unknown): ScheduledEntryOutcome['estimate'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const range = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined;
    const r = value as Record<string, unknown>;
    return typeof r.low === 'number' && Number.isFinite(r.low) && r.low >= 0 && typeof r.high === 'number' && Number.isFinite(r.high) && r.high >= r.low ? { low: r.low, high: r.high } : undefined;
  };
  const tokens = range(raw.tokens);
  const cost = range(raw.spend);
  const currency = raw.spend && typeof raw.spend === 'object' ? text((raw.spend as Record<string, unknown>).currency) : undefined;
  return {
    ...(tokens ? { tokens } : {}),
    ...(cost && currency ? { spend: { ...cost, currency } } : {}),
    ...(text(raw.notEstimable) ? { notEstimable: text(raw.notEstimable) } : {}),
    ...(num(raw.basedOnSessions) !== undefined ? { basedOnSessions: num(raw.basedOnSessions) } : {})
  };
}

function normalizeHandover(value: unknown): ScheduledHandover | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const at = text(raw.at);
  const from = text(raw.from);
  const to = text(raw.to);
  if (!at || !from || !to) return undefined;
  return { at, from, to, usedPercent: num(raw.usedPercent) ?? 0, ...(text(raw.checkpointRef) ? { checkpointRef: text(raw.checkpointRef) } : {}) };
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
    ...(raw.withPrevious === true ? { withPrevious: true as const } : {}),
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
  const status = typeof raw.status === 'string' && RUN_STATUSES.has(raw.status) ? (raw.status as ScheduledRunStatus) : 'draft';
  const rawPolicy = raw.policy && typeof raw.policy === 'object' ? (raw.policy as Record<string, unknown>) : undefined;
  const workflowId = text(rawPolicy?.workflowId);
  const rawPause = raw.pause && typeof raw.pause === 'object' ? (raw.pause as Record<string, unknown>) : undefined;
  const pause =
    status === 'paused' && rawPause && text(rawPause.message) && text(rawPause.at)
      ? {
          reason: (typeof rawPause.reason === 'string' && PAUSE_REASONS.has(rawPause.reason) ? rawPause.reason : 'user') as ScheduledPauseReason,
          ...(text(rawPause.entryId) ? { entryId: text(rawPause.entryId) } : {}),
          message: text(rawPause.message)!,
          at: text(rawPause.at)!
        }
      : undefined;
  return {
    schemaVersion: SCHEDULED_RUN_SCHEMA_VERSION,
    id,
    name,
    ...(text(raw.projectId) ? { projectId: text(raw.projectId) } : {}),
    scheduledStartAt: new Date(start).toISOString(),
    timezone: text(raw.timezone) && isValidTimeZone(raw.timezone as string) ? (raw.timezone as string) : 'UTC',
    policy: storedPolicy(rawPolicy, workflowId),
    entries: renumberEntries(ordered),
    status,
    attempts: (Array.isArray(raw.attempts) ? raw.attempts : []).map(normalizeAttempt).filter((a): a is ScheduledRunAttempt => !!a),
    ...(pause ? { pause } : {}),
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
