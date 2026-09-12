/**
 * A durable ledger of AI usage events (FX-BF-036-ish — no prior story; added
 * alongside the workflow agent-recommendation feature that first needed it).
 *
 * The app already tracks token usage and cost, but only as *current state* on
 * each session record (`AgentSessionRecord.tokenUsage` / `.cost`) — useful for
 * "how is this session doing right now", useless for "how much AI did we use
 * this week vs last week", since a session's own state gets overwritten, not
 * accumulated into history. This log is the missing time series: one entry
 * per reported usage delta, source-tagged, kept forever (capped) so
 * `aiUsageStats.ts` can bucket it by day/week/month.
 *
 * `source` distinguishes an ordinary agent session from a lightweight
 * internal AI call (e.g. the workflow agent recommendation) that never
 * becomes a session at all — both spend real tokens against the same
 * provider, and both belong in the same ledger.
 */

import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '../host/stateStore';
import type { AiProvider } from '../types';

export type AiUsageSource = 'session' | 'workflow-recommendation' | 'workflow-template-recommendation';

export interface AiUsageEvent {
  id: string;
  /** ISO 8601. */
  timestamp: string;
  source: AiUsageSource;
  /** The agent session this usage belongs to, when there is one. */
  sessionId?: string;
  provider?: AiProvider;
  model?: string;
  /** A delta for this one event, never a running total — see the module doc. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * A delta for this one event. Only ACP hosts report cost at all, and only
   * as a cumulative figure per session — `aiUsageTracking.ts` (main process)
   * is responsible for diffing that into a delta before it reaches here.
   */
  cost?: { amount: number; currency: string };
  /** Set when this usage happened inside a governed workflow run. */
  workflowRunId?: string;
  workflowNodeId?: string;
}

export type AiUsageEventInput = Omit<AiUsageEvent, 'id' | 'timestamp'> & { timestamp?: string };

const USAGE_LOG_KEY = 'praxis.aiUsageLog.v1';

/** Oldest entries fall off past this so the log file can't grow without bound. */
const MAX_EVENTS = 20000;

function isFiniteNonZero(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

/** True when an event actually reports something — guards against logging empty no-op deltas. */
export function hasReportableUsage(event: AiUsageEventInput): boolean {
  return (
    isFiniteNonZero(event.inputTokens) ||
    isFiniteNonZero(event.outputTokens) ||
    isFiniteNonZero(event.totalTokens) ||
    (typeof event.cost?.amount === 'number' && event.cost.amount !== 0)
  );
}

export class AiUsageLog {
  constructor(private readonly store: KeyValueStore) {}

  private readAll(): AiUsageEvent[] {
    return this.store.get<AiUsageEvent[]>(USAGE_LOG_KEY) ?? [];
  }

  /** Appends one event; a no-op input (see `hasReportableUsage`) is still recorded if the caller insists — callers should check first. */
  public async record(event: AiUsageEventInput): Promise<AiUsageEvent> {
    const full: AiUsageEvent = {
      id: randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      source: event.source,
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      cost: event.cost,
      workflowRunId: event.workflowRunId,
      workflowNodeId: event.workflowNodeId
    };
    const next = [...this.readAll(), full];
    const trimmed = next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    await this.store.update(USAGE_LOG_KEY, trimmed);
    return full;
  }

  /** Every event, oldest first. Callers bucket/filter via `aiUsageStats.ts`. */
  public list(): AiUsageEvent[] {
    return this.readAll();
  }
}
