/**
 * Deterministic workflow scheduler (FX-BE-019 / TASK-096).
 *
 * Pure: given a run, decide what may start now. The orchestrator applies the
 * decision and feeds the resulting run back in. Keeping the choice free of I/O
 * is what makes fan-out, joins, and worktree contention testable without
 * spawning an agent.
 *
 * Two rules do the real work:
 *
 * - **Only joins wait on several branches.** Validation already forbids a
 *   non-join node with two concurrent parents, so readiness elsewhere is a
 *   question about one source node, never a race.
 * - **At most one mutating stage runs at a time.** Read-only stages fan out
 *   freely — that is what makes review, QA, and security parallel — but
 *   anything that writes to the canonical worktree is serialised, because two
 *   agents editing one tree corrupt each other's work in ways no gate catches.
 */

import { providerDisplayName } from '../ai/providers/registry';
import { awaitingSkeptic, dagEdges, describeFindingsPredicate, edgeStateFor, pendingLoop, type EdgeState } from './workflowEdges';
import {
  isApprovalNode,
  isJoinNode,
  isTerminalOutcome,
  nodeMutatesWorktree,
  type WorkflowEdge,
  type WorkflowNode
} from './workflowTypes';
import {
  applyWorkflowRunCommand,
  isPausedNode,
  pauseReasonOf,
  isRunSettled,
  type WorkflowRun,
  type WorkflowRunStatus
} from './workflowRun';

export interface WorkflowSchedule {
  /** Nodes that may start now, in definition order. */
  ready: string[];
  /**
   * Join nodes whose branches have converged. A join has no work to dispatch —
   * it exists to express a wait — so it is reported apart from `ready` and
   * settled straight through by `advanceJoins`.
   */
  autoAdvance: string[];
  /** Nodes whose branch was not taken and can never run. */
  skip: Array<{ nodeId: string; reason: string }>;
  /** Approval nodes whose turn it is, waiting on a human. */
  awaitingApproval: string[];
  /** Nodes currently in flight. */
  running: string[];
  /**
   * Why nothing is ready, when nothing is and the run has not settled. Present
   * only for a genuine stall, so the monitor can say something better than
   * "waiting".
   */
  blocked?: string;
}

export function scheduleWorkflowRun(run: WorkflowRun): WorkflowSchedule {
  const running = Object.values(run.nodes)
    .filter(state => state.outcome === 'running')
    .map(state => state.nodeId);

  if (isRunSettled(run)) {
    return { ready: [], autoAdvance: [], skip: [], awaitingApproval: [], running };
  }

  // A firing loop edge decides where the run goes next. Until it is taken — once
  // the stages still running have settled — or a person answers it, nothing new
  // starts and no branch is written off: whatever is downstream of the loop's
  // target is about to be reopened anyway.
  const loop = pendingLoop(run);
  if (loop) {
    const from = run.definition.nodes.find(node => node.id === loop.status.edge.from)?.name ?? loop.status.edge.from;
    const to = run.definition.nodes.find(node => node.id === loop.status.edge.to)?.name ?? loop.status.edge.to;
    const why = loop.status.edge.on === 'findings' ? ` (${describeFindingsPredicate(loop.status.edge.when)})` : '';
    return {
      ready: [],
      autoAdvance: [],
      skip: [],
      awaitingApproval: [],
      running,
      ...(running.length === 0 || loop.kind === 'decide'
        ? {
            blocked:
              loop.kind === 'decide'
                ? `Needs a decision: ${from} still matches its loop back to ${to}${why} after ${loop.status.iterationsTaken} of ${loop.status.budget} iterations.`
                : `Looping back from ${from} to ${to}${why}.`
          }
        : {})
    };
  }

  const ready: string[] = [];
  const autoAdvance: string[] = [];
  const skip: Array<{ nodeId: string; reason: string }> = [];
  const awaitingApproval: string[] = [];

  // Definition order, so a given run state always schedules identically.
  for (const node of run.definition.nodes) {
    const state = run.nodes[node.id];
    if (!state || state.outcome !== 'pending') continue;

    const verdict = evaluate(run, node);
    if (verdict.kind === 'skip') {
      skip.push({ nodeId: node.id, reason: verdict.reason });
      continue;
    }
    if (verdict.kind === 'wait') continue;

    // An approval is "ready" for a person, not for the orchestrator: it never
    // starts on its own, so it is reported separately from runnable work.
    if (isApprovalNode(node)) {
      awaitingApproval.push(node.id);
      continue;
    }
    if (isJoinNode(node)) {
      autoAdvance.push(node.id);
      continue;
    }
    ready.push(node.id);
  }

  const admitted = admit(run, ready, running);

  return {
    ready: admitted,
    autoAdvance,
    skip,
    awaitingApproval,
    running,
    ...(admitted.length === 0 &&
    autoAdvance.length === 0 &&
    running.length === 0 &&
    awaitingApproval.length === 0
      ? { blocked: describeStall(run, ready) }
      : {})
  };
}

/**
 * Settles every converged join — and every node on a branch that can no longer be taken —
 * repeatedly, until none remain.
 *
 * Joins can chain — one join feeding another — and a join carries no work, so
 * resolving them in a loop keeps the orchestrator's step function to "advance
 * joins, then dispatch what is ready".
 */
export function advanceJoins(run: WorkflowRun, at: string): WorkflowRun {
  let next = run;
  // Bounded by node count: each pass settles at least one join, and a settled
  // join never becomes pending again.
  for (let pass = 0; pass < run.definition.nodes.length; pass += 1) {
    const schedule = scheduleWorkflowRun(next);
    const { autoAdvance } = schedule;
    // Only a branch closed by a decision that stands — a skipped approval, a success that took the
    // other edge — is settled here. One closed by a failure stays pending: a person can retry the
    // failed stage, which reopens it.
    const skip = schedule.skip.filter(({ nodeId }) =>
      !next.definition.edges.some(edge => edge.to === nodeId && next.nodes[edge.from]?.outcome === 'failed')
    );
    if (autoAdvance.length === 0 && skip.length === 0) return next;
    for (const nodeId of autoAdvance) {
      next = applyWorkflowRunCommand(next, { kind: 'node-started', nodeId, at });
      next = applyWorkflowRunCommand(next, { kind: 'node-succeeded', nodeId, at });
    }
    // A branch that was not taken can never run. Recording it as skipped is what lets the run
    // settle — left pending, it would hold a finished run at "running" forever.
    for (const { nodeId, reason } of skip) {
      next = applyWorkflowRunCommand(next, { kind: 'node-skipped', nodeId, at, reason });
    }
  }
  return next;
}

/**
 * The status a run should be showing, given what can move.
 *
 * Derived rather than stored so it cannot drift: `awaiting-approval` in
 * particular is a fact about the graph, not an event anything emits.
 */
export function deriveRunStatus(run: WorkflowRun): WorkflowRunStatus {
  if (isRunSettled(run)) return run.status;
  const schedule = scheduleWorkflowRun(run);
  const stalled = schedule.ready.length === 0 && schedule.autoAdvance.length === 0 && schedule.running.length === 0;
  return stalled && schedule.awaitingApproval.length > 0 ? 'awaiting-approval' : 'running';
}

/**
 * Applies worktree contention to the runnable set.
 *
 * Read-only stages all pass. Mutating stages queue behind whatever is already
 * writing, and only the first in definition order is admitted per pass — the
 * next is picked up once this one settles.
 */
function admit(run: WorkflowRun, ready: string[], running: string[]): string[] {
  const mutating = (nodeId: string): boolean => {
    const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
    return !!node && nodeMutatesWorktree(node);
  };

  const worktreeBusy = running.some(mutating);
  const admitted: string[] = [];
  let claimed = worktreeBusy;

  for (const nodeId of ready) {
    if (!mutating(nodeId)) {
      admitted.push(nodeId);
      continue;
    }
    if (claimed) continue;
    claimed = true;
    admitted.push(nodeId);
  }

  return admitted;
}

type Verdict = { kind: 'ready' } | { kind: 'wait' } | { kind: 'skip'; reason: string };

function evaluate(run: WorkflowRun, node: WorkflowNode): Verdict {
  // Loop edges are not inbound branches: a loop's target becomes ready again by
  // being reopened (`loop-taken`), never by waiting on the stage that loops back.
  const inbound = dagEdges(run.definition).filter(edge => edge.to === node.id);

  // The entry node — and any node validation accepted with no parents — starts
  // as soon as the run does.
  if (inbound.length === 0) return { kind: 'ready' };

  const states = inbound.map(edge => [edge, edgeState(run, edge)] as const);

  if (isJoinNode(node)) {
    // `all-required` ignores advisory branches entirely: it releases as soon as
    // the required ones are satisfied, which means an advisory branch's result
    // cannot gate anything downstream. That is what "advisory" has to mean —
    // a branch nobody waits for cannot also be a branch anybody depends on.
    const considered = node.mode === 'all-required' ? states.filter(([edge]) => edge.required) : states;

    const dead = considered.find(([, state]) => state === 'dead');
    if (dead) return { kind: 'skip', reason: `branch from "${dead[0].from}" did not reach this join` };
    if (considered.some(([, state]) => state === 'waiting')) return { kind: 'wait' };
    return { kind: 'ready' };
  }

  // Validation guarantees a single source node here, though it may reach this
  // node by several mutually exclusive outcome edges.
  if (states.some(([, state]) => state === 'satisfied')) return { kind: 'ready' };
  if (states.some(([, state]) => state === 'waiting')) return { kind: 'wait' };
  return { kind: 'skip', reason: `no inbound branch from "${inbound[0].from}" was taken` };
}

function edgeState(run: WorkflowRun, edge: WorkflowEdge): EdgeState {
  // A findings edge waits for any skeptic of its source to deliver its verdicts.
  if (edge.on === 'findings' && isTerminalOutcome(run.nodes[edge.from]?.outcome ?? 'pending') && awaitingSkeptic(run, edge.from)) return 'waiting';
  const sourceNode = run.definition.nodes.find(node => node.id === edge.from);
  const recovery =
    sourceNode?.type === 'check' && sourceNode.failureRecovery?.repairNodeId === edge.to
      ? { exhausted: (run.recoveryAttempts?.[sourceNode.id] ?? 0) >= sourceNode.failureRecovery.maxAttempts }
      : undefined;
  return edgeStateFor(edge, run.nodes[edge.from], recovery);
}

/**
 * Names the reason a run has stalled, so the monitor can offer the right
 * action instead of spinning.
 */
function describeStall(run: WorkflowRun, readyBeforeAdmission: string[]): string {
  if (readyBeforeAdmission.length > 0) {
    return 'Waiting for the implementation worktree to free up.';
  }

  const paused = Object.values(run.nodes).filter(state => isPausedNode(state));
  if (paused.length > 0) {
    const ids = paused.map(state => state.nodeId).sort().join(', ');
    const ais = [...new Set(paused.map(state => state.attempts[state.attempts.length - 1]?.provider).filter((id): id is string => Boolean(id)))];
    const who = ais.length ? ais.map(providerDisplayName).join(' and ') : 'the AI provider';
    return paused.every(state => pauseReasonOf(state) === 'provider-limit')
      ? `Paused: ${who} ran out of credits or hit its usage limit at ${ids}. Switch to another AI, or restore them and retry.`
      : `Paused: ${ids} could not run in this environment. Fix that, then retry.`;
  }

  const retryable = Object.values(run.nodes).filter(state => state.outcome === 'failed');
  if (retryable.length > 0) {
    return `Blocked on failed ${retryable.length === 1 ? 'stage' : 'stages'}: ${retryable
      .map(state => state.nodeId)
      .sort()
      .join(', ')}.`;
  }

  const unfinished = Object.values(run.nodes).filter(state => !isTerminalOutcome(state.outcome));
  if (unfinished.length === 0) return 'Every stage has settled.';
  return `No stage can start; ${unfinished.length} left unreachable.`;
}
