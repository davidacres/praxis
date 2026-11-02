/**
 * How a scheduled run is likely to go, in time and spend (FX-BF-047 / FX-BE-193 /
 * TASK-506). The composer's rehearsal and the run monitor's "likely done" both
 * come from `forecastScheduledRun`, so the two screens never disagree.
 *
 * The forecast is built only from what this machine measured: how long each stage
 * of the same workflow took in earlier runs, and what those runs cost. With too
 * few earlier runs there is no time or spend forecast, and the screens say so
 * instead of showing a number nobody measured.
 *
 * It applies the runner's own rules: steps in order, a step waits for every ticket
 * before it, never more than `maxConcurrency` tickets at once. For a run already
 * going it starts from what happened: finished tickets keep their real times, a
 * running ticket gets its remaining estimate from now, and time spent waiting so
 * far is already in the clock.
 */

import type { AiUsageEvent } from '../ai/aiUsageLog';
import { dagEdges } from '../workflows/workflowEdges';
import type { WorkflowRun } from '../workflows/workflowRun';
import type { WorkflowDefinition, WorkflowNode } from '../workflows/workflowTypes';
import { scheduledConcurrency, scheduledSteps, type ScheduledRun } from './scheduledRun';
import { orderedWorkflowStages } from './scheduledRunDetail';

/** Fewer finished earlier runs of the workflow than this and a forecast would be a guess. */
export const MIN_FORECAST_RUNS = 3;

export interface ScheduledTicketEstimate {
  /** Seconds for one ticket: the median, and the slow end (90th percentile of each stage). */
  durationSec?: { likely: number; slow: number };
  /** Cost of one ticket from earlier runs: median, 25th and 90th percentile. */
  spend?: { likely: number; low: number; high: number; currency: string };
  /** Finished earlier runs of this workflow the figures come from. */
  basedOnRuns: number;
}

export interface ScheduledForecastEntry {
  entryId: string;
  /** The ticket, so a view whose entries have no stable id yet (the composer's preview) can match it. */
  issueKey: string;
  startAt: string;
  endAt: string;
  /** 1-based lane the ticket runs (or ran) in. */
  lane: number;
  state: 'done' | 'running' | 'waiting' | 'skipped';
}

export interface ScheduledRunForecast {
  /** The workflow's agent tasks in run order, for "each ticket runs". */
  stages: Array<{ nodeId: string; name: string; type: WorkflowNode['type'] }>;
  likelyFinishAt?: string;
  /** The slow end: every remaining stage at its 90th percentile. Labelled "could run to", never a promise. */
  slowFinishAt?: string;
  entries: ScheduledForecastEntry[];
  /** The whole run's spend: what finished tickets reported plus the estimate for the rest. */
  spend?: { likely: number; low: number; high: number; currency: string };
  perTicket?: ScheduledTicketEstimate['spend'];
  basedOnRuns: number;
  /** Why there is no time forecast, when there is none. */
  notEstimable?: string;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

/** Longest path through the workflow's forward edges, weighting each stage with `weight`. */
function longestPath(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>, weight: (nodeId: string) => number): number {
  const edges = dagEdges(definition).filter(edge => edge.on !== 'failure');
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const from = (nodeId: string): number => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const next = edges.filter(edge => edge.from === nodeId).map(edge => from(edge.to));
    visiting.delete(nodeId);
    const value = weight(nodeId) + (next.length ? Math.max(...next) : 0);
    memo.set(nodeId, value);
    return value;
  };
  return definition.nodes.reduce((best, node) => Math.max(best, from(node.id)), 0);
}

/**
 * What one ticket of this workflow takes, from earlier runs of it. `history` is
 * every stored run; only finished runs of the same workflow count.
 */
export function estimateScheduledTicket(definition: WorkflowDefinition, history: readonly WorkflowRun[], usage: readonly AiUsageEvent[]): ScheduledTicketEstimate {
  const finished = history.filter(run => run.workflowId === definition.id && run.status === 'succeeded');
  const basedOnRuns = finished.length;
  if (basedOnRuns < MIN_FORECAST_RUNS) return { basedOnRuns };

  const samples = new Map<string, number[]>();
  for (const run of finished) {
    for (const [nodeId, state] of Object.entries(run.nodes)) {
      // One stage's time in one run: every attempt it took, since a retry or a loop is part of the cost.
      let seconds = 0;
      for (const attempt of state.attempts) {
        if (!attempt.endedAt) continue;
        seconds += Math.max(0, (Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)) / 1000);
      }
      if (seconds > 0) samples.set(nodeId, [...(samples.get(nodeId) ?? []), seconds]);
    }
  }
  const likely = longestPath(definition, nodeId => percentile(samples.get(nodeId) ?? [], 0.5));
  const slow = longestPath(definition, nodeId => percentile(samples.get(nodeId) ?? [], 0.9));

  const ids = new Set(finished.map(run => run.runId));
  const costs = new Map<string, { amount: number; currency: string }>();
  let mixed = false;
  for (const event of usage) {
    if (!event.workflowRunId || !ids.has(event.workflowRunId) || !event.cost) continue;
    const row = costs.get(event.workflowRunId) ?? { amount: 0, currency: event.cost.currency };
    if (row.currency !== event.cost.currency) mixed = true;
    row.amount += event.cost.amount;
    costs.set(event.workflowRunId, row);
  }
  const amounts = [...costs.values()].map(row => row.amount);
  const currency = [...costs.values()][0]?.currency;
  const spend = !mixed && currency && amounts.length >= MIN_FORECAST_RUNS
    ? { likely: percentile(amounts, 0.5), low: percentile(amounts, 0.25), high: percentile(amounts, 0.9), currency }
    : undefined;

  return { ...(likely > 0 ? { durationSec: { likely, slow: Math.max(slow, likely) } } : {}), ...(spend ? { spend } : {}), basedOnRuns };
}

interface Placed { entryId: string; issueKey: string; start: number; end: number; lane: number; state: ScheduledForecastEntry['state'] }

function simulate(run: ScheduledRun, origin: number, now: number, ticketSec: number): Placed[] {
  const lanes = scheduledConcurrency(run.policy);
  const placed: Placed[] = [];
  let stepStart = origin;
  for (const step of scheduledSteps(run.entries)) {
    const free = Array.from({ length: lanes }, () => stepStart);
    let stepEnd = stepStart;
    const take = (preferred: number | undefined, at: number) => {
      let lane = preferred !== undefined && preferred >= 1 && preferred <= lanes ? preferred - 1 : -1;
      if (lane < 0) {
        lane = 0;
        for (let index = 1; index < lanes; index += 1) if (free[index] < free[lane]) lane = index;
      }
      return { lane, start: Math.max(free[lane], at) };
    };
    // Tickets that already started keep their lane and time; the rest fill lanes after them.
    const ordered = [...step].sort((a, b) => Number(!a.outcome?.startedAt) - Number(!b.outcome?.startedAt));
    for (const entry of ordered) {
      const outcome = entry.outcome;
      const status = outcome?.status ?? 'queued';
      const startedAt = outcome?.startedAt ? Date.parse(outcome.startedAt) : undefined;
      if (status === 'skipped' || ((status === 'done' || status === 'failed') && !startedAt)) {
        const end = outcome?.endedAt ? Date.parse(outcome.endedAt) : stepStart;
        placed.push({ entryId: entry.id, issueKey: entry.ticket.issueKey, start: end, end, lane: outcome?.lane ?? 1, state: 'skipped' });
        continue;
      }
      if (status === 'done' && startedAt !== undefined) {
        const end = outcome?.endedAt ? Date.parse(outcome.endedAt) : now;
        const { lane } = take(outcome?.lane, startedAt);
        free[lane] = Math.max(free[lane], end);
        stepEnd = Math.max(stepEnd, end);
        placed.push({ entryId: entry.id, issueKey: entry.ticket.issueKey, start: startedAt, end, lane: lane + 1, state: 'done' });
        continue;
      }
      if (startedAt !== undefined) {
        // Running, waiting at a gate, or failed and waiting for a decision: the rest of its estimate from now.
        const elapsed = Math.max(0, now - startedAt);
        const remaining = Math.max(ticketSec * 1000 - elapsed, ticketSec * 100);
        const end = now + remaining;
        const { lane } = take(outcome?.lane, startedAt);
        free[lane] = Math.max(free[lane], end);
        stepEnd = Math.max(stepEnd, end);
        placed.push({ entryId: entry.id, issueKey: entry.ticket.issueKey, start: startedAt, end, lane: lane + 1, state: 'running' });
        continue;
      }
      const { lane, start } = take(undefined, Math.max(stepStart, now));
      const end = start + ticketSec * 1000;
      free[lane] = end;
      stepEnd = Math.max(stepEnd, end);
      placed.push({ entryId: entry.id, issueKey: entry.ticket.issueKey, start, end, lane: lane + 1, state: 'waiting' });
    }
    stepStart = stepEnd;
  }
  return placed;
}

/**
 * The forecast for a schedule. `now` is the clock; a schedule that has not started
 * is forecast from its own start time (or from now, when that has passed).
 */
export function forecastScheduledRun(run: ScheduledRun, estimate: ScheduledTicketEstimate, definition: WorkflowDefinition | undefined, now: string): ScheduledRunForecast {
  const stages = definition ? orderedWorkflowStages(definition).map(node => ({ nodeId: node.id, name: node.name, type: node.type })) : [];
  const base: ScheduledRunForecast = { stages, entries: [], basedOnRuns: estimate.basedOnRuns, ...(estimate.spend ? { perTicket: estimate.spend } : {}) };

  const remainingTickets = run.entries.filter(entry => !['done', 'failed', 'skipped'].includes(entry.outcome?.status ?? 'queued')).length;
  if (estimate.spend) {
    const reported = run.entries.reduce((sum, entry) => sum + (['done', 'failed', 'skipped'].includes(entry.outcome?.status ?? 'queued') ? entry.outcome?.spend?.cost ?? 0 : 0), 0);
    base.spend = {
      likely: reported + remainingTickets * estimate.spend.likely,
      low: reported + remainingTickets * estimate.spend.low,
      high: reported + remainingTickets * estimate.spend.high,
      currency: estimate.spend.currency
    };
  }
  if (!estimate.durationSec) {
    return {
      ...base,
      notEstimable: estimate.basedOnRuns < MIN_FORECAST_RUNS
        ? `Needs ${MIN_FORECAST_RUNS} finished runs of this workflow to forecast; ${estimate.basedOnRuns === 0 ? 'none yet' : `${estimate.basedOnRuns} so far`}.`
        : 'Earlier runs of this workflow recorded no stage times.'
    };
  }
  if (run.entries.length === 0) return base;

  const clock = Date.parse(now);
  const attempt = run.attempts[run.attempts.length - 1];
  const started = ['running', 'paused', 'completed', 'cancelled', 'failed'].includes(run.status) && attempt;
  const origin = started ? Date.parse(attempt.startedAt) : Math.max(Date.parse(run.scheduledStartAt), clock);
  const effectiveNow = started ? clock : origin;
  const likely = simulate(run, origin, effectiveNow, estimate.durationSec.likely);
  const slow = simulate(run, origin, effectiveNow, estimate.durationSec.slow);
  const finish = (placed: Placed[]) => new Date(placed.reduce((latest, row) => Math.max(latest, row.end), origin)).toISOString();
  return {
    ...base,
    likelyFinishAt: finish(likely),
    slowFinishAt: finish(slow),
    entries: likely.map(row => ({ entryId: row.entryId, issueKey: row.issueKey, startAt: new Date(row.start).toISOString(), endAt: new Date(row.end).toISOString(), lane: row.lane, state: row.state }))
  };
}
