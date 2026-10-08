/**
 * Edges as the engine reads them (FX-BE-162).
 *
 * Two kinds of edge share `WorkflowDefinition.edges`:
 *
 * - **DAG edges** — everything without `loop`. Readiness, snapshots, ancestry,
 *   reachability and "what is downstream" are all questions about these alone,
 *   so every one of those walks stays acyclic exactly as it was before loops
 *   existed. Use `dagEdges` wherever a walk follows edges.
 * - **Loop edges** — back-edges with a budget. They are read only by the loop
 *   logic in `workflowLoops.ts`, which takes one by reopening its target as a
 *   new revision.
 *
 * The findings arithmetic lives here too, shared by gate thresholds and
 * findings edges so "two high findings" means the same thing to both.
 */

import {
  WORKFLOW_MAX_LOOP_ITERATIONS,
  type CheckFinding,
  type CheckFindings,
  type CheckFindingSeverity,
  type MetricThresholdCondition,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowFindingsPredicate
} from './workflowTypes';
// Type-only: `workflowRun` calls into this module, so a value import back would be a cycle.
import type { WorkflowNodeState, WorkflowRun } from './workflowRun';

export const SEVERITY_RANK: Record<CheckFindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export function isLoopEdge(edge: Pick<WorkflowEdge, 'loop'>): boolean {
  return !!edge.loop;
}

/** The run's DAG: every edge that is not a loop edge. */
export function dagEdges(definition: Pick<WorkflowDefinition, 'edges'>): WorkflowEdge[] {
  return definition.edges.filter(edge => !isLoopEdge(edge));
}

export function loopEdges(definition: Pick<WorkflowDefinition, 'edges'>): WorkflowEdge[] {
  return definition.edges.filter(isLoopEdge);
}

/** Findings that still count: a skeptic's `refuted` verdict takes a finding out of play. */
export function countableFindings(findings: readonly CheckFinding[]): CheckFinding[] {
  return findings.filter(finding => finding.verdict !== 'refuted');
}

/** How many findings sit at or above `level`. */
export function countAtOrAbove(findings: readonly CheckFinding[], level: CheckFindingSeverity): number {
  const rank = SEVERITY_RANK[level] ?? SEVERITY_RANK.high;
  return findings.filter(finding => (SEVERITY_RANK[finding.severity] ?? 0) >= rank).length;
}

/** Whether `actual <operator> value`. A missing reading never holds. */
export function compareMetric(
  actual: number | undefined,
  operator: MetricThresholdCondition['operator'],
  value: number
): boolean {
  if (actual === undefined || !Number.isFinite(actual)) return false;
  switch (operator) {
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '>': return actual > value;
    case '<': return actual < value;
    case '==': return actual === value;
  }
}

/** Whether any clause of a findings predicate holds for these findings. */
export function findingsPredicateHolds(predicate: WorkflowFindingsPredicate | undefined, findings: CheckFindings | undefined): boolean {
  if (!findings) return false;
  const when = predicate ?? {};
  const hasSeverityClause = when.severity !== undefined || when.minCount !== undefined || (when.categories?.length ?? 0) > 0;
  const clauses: boolean[] = [];

  if (hasSeverityClause || !when.metric) {
    const categories = when.categories?.length ? new Set(when.categories.map(category => category.toLowerCase())) : undefined;
    const pool = countableFindings(findings.findings).filter(finding => !categories || categories.has((finding.category ?? '').toLowerCase()));
    clauses.push(countAtOrAbove(pool, when.severity ?? 'high') >= Math.max(1, when.minCount ?? 1));
  }
  if (when.metric) {
    clauses.push(compareMetric(findings.metrics?.[when.metric.metric], when.metric.operator, when.metric.value));
  }
  return clauses.some(Boolean);
}

/** A short, human reading of a predicate: "2+ findings at high or above, or score < 90". */
export function describeFindingsPredicate(predicate: WorkflowFindingsPredicate | undefined): string {
  const when = predicate ?? {};
  const parts: string[] = [];
  const hasSeverityClause = when.severity !== undefined || when.minCount !== undefined || (when.categories?.length ?? 0) > 0;
  if (hasSeverityClause || !when.metric) {
    const count = Math.max(1, when.minCount ?? 1);
    const categories = when.categories?.length ? ` in ${when.categories.join('/')}` : '';
    parts.push(`${count === 1 ? 'any finding' : `${count}+ findings`} at ${when.severity ?? 'high'} or above${categories}`);
  }
  if (when.metric) parts.push(`${when.metric.metric} ${when.metric.operator} ${when.metric.value}`);
  return parts.join(', or ');
}

/** How an inbound edge stands given its source node's recorded outcome. */
export type EdgeState = 'satisfied' | 'dead' | 'waiting';

/**
 * Whether `edge` is taken given its source's state. Shared by the scheduler
 * (DAG edges) and the loop logic (loop edges), so a loop edge fires on exactly
 * the outcome a forward edge with the same `on` would.
 */
export function edgeStateFor(
  edge: WorkflowEdge,
  source: Pick<WorkflowNodeState, 'outcome' | 'attempts' | 'findings'> | undefined,
  recovery?: { exhausted: boolean }
): EdgeState {
  if (!source) return 'dead';
  const paused = source.outcome === 'failed' && !!source.attempts[source.attempts.length - 1]?.pause;

  switch (source.outcome) {
    case 'succeeded':
      if (edge.on === 'findings') return findingsPredicateHolds(edge.when, source.findings) ? 'satisfied' : 'dead';
      return edge.on === 'success' || edge.on === 'always' ? 'satisfied' : 'dead';
    case 'failed':
      // Paused (provider limit / environment): the stage has no verdict yet, so
      // no edge — failure/always included — is taken. Routing into a fix stage
      // would only spend more effort against the same broken precondition.
      if (paused) return 'waiting';
      if (edge.on === 'findings') return findingsPredicateHolds(edge.when, source.findings) ? 'satisfied' : 'dead';
      if (edge.on !== 'failure' && edge.on !== 'always') return 'dead';
      if (recovery?.exhausted) return 'dead';
      return 'satisfied';
    case 'skipped':
    case 'cancelled':
      // The source never ran, so nothing downstream of it can be reached.
      return 'dead';
    default:
      return 'waiting';
  }
}

// ── Loops ────────────────────────────────────────────────────────────────

/** Where one loop edge stands in a run. */
export interface LoopStatus {
  edge: WorkflowEdge;
  /** Times the loop has been taken in this run. */
  iterationsTaken: number;
  /** Times it may be taken: its budget, a run parameter's override, plus any grants, capped. */
  budget: number;
  /** The source's latest result satisfies the edge and no one has accepted it. */
  fires: boolean;
  /** Fires with nothing left in the budget: a person must decide. */
  exhausted: boolean;
}

/** Times a loop edge has been taken in this run. */
export function loopIterationsTaken(run: Pick<WorkflowRun, 'loopHistory'>, edgeId: string): number {
  return (run.loopHistory ?? []).filter(entry => entry.edgeId === edgeId).length;
}

/**
 * A loop's budget for this run: the edge's own `maxIterations`, replaced by an
 * integer run parameter bound to it, plus every iteration a person granted —
 * never more than `WORKFLOW_MAX_LOOP_ITERATIONS`.
 */
export function loopBudget(run: Pick<WorkflowRun, 'definition' | 'parameters' | 'loopDecisions'>, edge: WorkflowEdge): number {
  const bound = (run.definition.parameters ?? []).find(parameter => parameter.bindsLoopEdge === edge.id);
  const fromParameter = bound ? run.parameters?.[bound.id] : undefined;
  const base =
    typeof fromParameter === 'number' && Number.isInteger(fromParameter) && fromParameter >= 1
      ? fromParameter
      : edge.loop?.maxIterations ?? 0;
  const granted = (run.loopDecisions ?? [])
    .filter(decision => decision.edgeId === edge.id && decision.decision === 'grant')
    .reduce((sum, decision) => sum + Math.max(0, decision.extraIterations ?? 0), 0);
  return Math.min(WORKFLOW_MAX_LOOP_ITERATIONS, base + granted);
}

/** Every loop edge's status, in definition order. */
export function loopStatuses(run: Pick<WorkflowRun, 'definition' | 'nodes' | 'parameters' | 'loopDecisions' | 'loopHistory'>): LoopStatus[] {
  return loopEdges(run.definition).map(edge => {
    const source = run.nodes[edge.from];
    const iterationsTaken = loopIterationsTaken(run, edge.id);
    const budget = loopBudget(run, edge);
    const satisfied = edgeStateFor(edge, source) === 'satisfied';
    // A person accepting this exact result ("approve anyway") stops it firing again;
    // the next result the source produces is judged afresh.
    const accepted = !!source && (run.loopDecisions ?? []).some(
      decision => decision.edgeId === edge.id && decision.decision === 'accept' && decision.sourceAttempt === source.attempts.length
    );
    const fires = satisfied && !accepted;
    return { edge, iterationsTaken, budget, fires, exhausted: fires && iterationsTaken >= budget };
  });
}

/**
 * The loop the run must act on next, if any: the first firing loop edge in
 * definition order. `take` it once nothing is running; `decide` means its
 * budget is spent and the run waits for a person.
 *
 * While one is pending the run starts nothing new, skips nothing and does not
 * settle — the source's result has not finished deciding where the run goes.
 */
export function pendingLoop(
  run: Pick<WorkflowRun, 'definition' | 'nodes' | 'parameters' | 'loopDecisions' | 'loopHistory' | 'status'>
): { kind: 'take' | 'decide'; status: LoopStatus } | undefined {
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return undefined;
  const status = loopStatuses(run).find(candidate => candidate.fires);
  if (!status) return undefined;
  return { kind: status.exhausted ? 'decide' : 'take', status };
}
