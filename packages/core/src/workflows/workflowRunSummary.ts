/**
 * Run monitor view model (FX-BE-022 / TASK-105).
 *
 * Derives everything the monitor renders from a `WorkflowRun` value: a row per
 * stage with its status and evidence, the gate ledger, the parallel branches
 * and where they converge, and a single sentence explaining why the run is
 * active, blocked, failed, or complete. Pure, so the UI never has to reconstruct
 * run logic and the explanation can be asserted in a test.
 */

import { dagEdges, describeFindingsPredicate, loopStatuses, pendingLoop } from './workflowEdges';
import {
  isApprovalNode,
  isJoinNode,
  nodeGate,
  type CheckFindings,
  type WorkflowEdge,
  type WorkflowGateKind,
  type WorkflowNode
} from './workflowTypes';
import {
  bestIteration,
  downstreamNodeIds,
  isPausedNode,
  pauseReasonOf,
  isRunSettled,
  type WorkflowNodeState,
  exhaustedProviders,
  type WorkflowRun,
  type WorkflowPauseReason,
  type WorkflowProviderLimitPolicy,
  type WorkflowRunEvent
} from './workflowRun';
import { deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { nextActions, outstandingNodes, type WorkflowNextAction } from './workflowRecovery';
import type { AiProvider } from '../types';
import { approvalReadiness, type GateStatus } from './workflowGates';
import { stageSessionKey } from './workflowStageTask';
import { providerDisplayName } from '../ai/providers/registry';
import type { WorkflowBoardReference, WorkflowPolicyProfile } from './workflowTypes';
import type { WorkflowPlanInput } from './workflowRun';

export interface StageRow {
  nodeId: string;
  name: string;
  type: WorkflowNode['type'];
  outcome: WorkflowNodeState['outcome'];
  /** 'running' | 'ready' | 'blocked' | 'skipped' | 'done' — for the monitor's dot. */
  lane: 'idle' | 'ready' | 'running' | 'done' | 'failed' | 'skipped' | 'awaiting' | 'paused';
  attempts: number;
  maxAttempts?: number;
  sessionId?: string;
  /** The session store key for this stage, so the monitor can link to it. */
  sessionKey?: string;
  snapshotRef?: string;
  gate?: WorkflowGateKind;
  artifacts: Array<{ contractId: string; kind: string; path?: string; reference?: WorkflowBoardReference }>;
  lastError?: string;
  /** The last attempt stopped without a verdict (AI provider limit, or the stage's tooling could not run); retrying does not spend an attempt. */
  pause?: WorkflowPauseReason;
  /** The in-flight attempt's reported sub-phase, e.g. a deployment stage's `'deploying'`/`'verifying'` — see `WorkflowNodeState.phase`. */
  phase?: string;
  findings?: CheckFindings;
  /** The AI that ran the latest attempt (a provider id). */
  provider?: string;
  /** The model the latest attempt ran on, when one was chosen. */
  model?: string;
  /** For an independent reviewer: whether its latest attempt ran apart from the stage it judges. */
  independence?: { independent: boolean; reason: string };
  /** The AI this stage is set to use: one it was switched to in this run, else its own choice. Absent means the run's. */
  chosenProvider?: string;
  /** The model this stage is set to use: one it was switched to in this run, else its own choice. */
  chosenModel?: string;
  /** The CLI command executed by a check or merge stage. */
  command?: string;
  /** Process exit code for a check stage. */
  exitCode?: number;
  /** Execution duration of the latest attempt in milliseconds. */
  durationMs?: number;
  /** Decision prompt for an approval stage. */
  prompt?: string;
  /** Gates required by an approval stage. */
  requiredGates?: WorkflowGateKind[];
  /** Set for a stage inside a loop: which pass of the loop it is on. */
  loopIteration?: { edgeId: string; iteration: number; budget: number };
}

/** One recorded pass of a loop, for the run view's history. */
export interface LoopHistoryRow {
  iteration: number;
  at: string;
  outcome: 'succeeded' | 'failed';
  findingCount: number;
  /** The most severe findings that triggered it, capped for display. */
  topFindings: Array<{ severity: string; message: string; file?: string; line?: number }>;
  error?: string;
  score?: number;
  restoredTo?: string;
}

/** A loop edge as the run view shows it. */
export interface LoopSummary {
  edgeId: string;
  fromNodeId: string;
  fromName: string;
  toNodeId: string;
  toName: string;
  on: WorkflowEdge['on'];
  /** "any finding at high or above", "score < 90" … */
  condition: string;
  iterationsTaken: number;
  budget: number;
  /** The loop fires now and will be taken once running stages settle. */
  firing: boolean;
  /** Fires with its budget spent: the run waits for a person (accept, grant more, or stop). */
  needsDecision: boolean;
  history: LoopHistoryRow[];
  /** Keep-best loops: the metric, and the best iteration so far. */
  keepBest?: { metric: string; higherIsBetter: boolean; bestIteration?: number; bestScore?: number; currentScore?: number };
  /** The source's open findings now (countable, most severe first), for a decision. */
  openFindings?: LoopHistoryRow['topFindings'];
  decisions: Array<{ at: string; actor: string; decision: 'accept' | 'grant' | 'stop'; reason?: string; extraIterations?: number }>;
  /**
   * Why a loop that ran is no longer going round: its condition cleared (`condition-met` —
   * a target reached, the findings fixed), it stopped improving (`no-improvement`), or a
   * person accepted the result after the budget ran out (`accepted`). Absent while it fires.
   */
  stoppedBecause?: 'condition-met' | 'no-improvement' | 'accepted';
}

export interface BranchGroup {
  /** The join every branch in this group feeds. */
  joinNodeId: string;
  joinName: string;
  converged: boolean;
  branches: Array<{ headNodeId: string; headName: string; outcome: WorkflowNodeState['outcome']; required: boolean }>;
}

export interface WorkflowRunSummary {
  runId: string;
  /** The project the run belongs to — what access checks (e.g. the phone's) scope it by. */
  projectId: string;
  workflowName: string;
  status: WorkflowRun['status'];
  /** One sentence: why this run is where it is. */
  explanation: string;
  stages: StageRow[];
  /** Graph shape for the monitor's read-only pipeline diagram. */
  graph: { nodes: Array<Pick<WorkflowNode, 'id' | 'x' | 'y' | 'type'>>; edges: WorkflowEdge[]; entryNodeId: string };
  gates: GateStatus[];
  branchGroups: BranchGroup[];
  actions: WorkflowNextAction[];
  /**
   * The run is stopped without a verdict — on the AI provider's credit/quota/rate
   * limit, or because a stage's tooling could not run — and is waiting for the
   * user to fix that and retry. It is not failed: the run is still open and keeps
   * its worktree. `pauseReason` says which; `environment` wins when both apply,
   * since that is the one only the user can diagnose.
   */
  paused?: boolean;
  pauseReason?: WorkflowPauseReason;
  outstanding: string[];
  /** Newest last. */
  events: WorkflowRunEvent[];
  startedAt: string;
  endedAt?: string;
  /** The ticket this run was started from, if any — see `WorkflowRun.issueKey`. */
  issueKey?: string;
  controllerSessionKey?: string;
  controllerSessionId?: string;
  planInput?: WorkflowPlanInput;
  /** How this run's stage sessions handle tool-permission prompts. */
  permissionMode: 'ask' | 'auto';
  aiProvider?: AiProvider;
  aiModel?: string;
  /** What happens when a stage's AI runs out of budget. */
  providerLimitPolicy: WorkflowProviderLimitPolicy;
  /** AIs that ran out of budget during this run. */
  exhaustedProviders: string[];
  /** Whether this run is archived by the user. */
  archived?: boolean;
  archivedAt?: string;
  /** Every loop edge's state and history; empty for a workflow with none. */
  loops: LoopSummary[];
  /** The loop waiting on a person, when one is. */
  needsDecision?: { edgeId: string; message: string };
  /** Values given for the workflow's parameters at start. */
  parameters?: Record<string, string | number>;
}

function laneFor(
  run: WorkflowRun,
  nodeId: string,
  ready: Set<string>,
  awaiting: Set<string>
): StageRow['lane'] {
  const outcome = run.nodes[nodeId]?.outcome ?? 'pending';
  if (outcome === 'running') return 'running';
  if (run.nodes[nodeId] && isPausedNode(run.nodes[nodeId])) return 'paused';
  if (outcome === 'succeeded') return 'done';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'skipped' || outcome === 'cancelled') return 'skipped';
  if (awaiting.has(nodeId)) return 'awaiting';
  if (ready.has(nodeId)) return 'ready';
  return 'idle';
}

const TOP_FINDINGS = 5;

function topFindings(findings: CheckFindings['findings']): LoopHistoryRow['topFindings'] {
  const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  return findings
    .filter(finding => finding.verdict !== 'refuted')
    .sort((left, right) => (rank[right.severity] ?? 0) - (rank[left.severity] ?? 0))
    .slice(0, TOP_FINDINGS)
    .map(finding => ({
      severity: finding.severity,
      message: finding.message,
      ...(finding.file ? { file: finding.file } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {})
    }));
}

/** Loop edges as the run view reads them. */
export function summarizeLoops(run: WorkflowRun): LoopSummary[] {
  const pending = pendingLoop(run);
  const name = (id: string): string => run.definition.nodes.find(node => node.id === id)?.name ?? id;
  return loopStatuses(run).map(status => {
    const { edge } = status;
    const history = (run.loopHistory ?? []).filter(entry => entry.edgeId === edge.id);
    const keepBest = edge.loop?.keepBest;
    const best = keepBest ? bestIteration(run.loopHistory ?? [], edge.id, keepBest.higherIsBetter) : undefined;
    const source = run.nodes[edge.from];
    const currentScore = keepBest ? source?.findings?.metrics?.[keepBest.metric] : undefined;
    const needsDecision = pending?.kind === 'decide' && pending.status.edge.id === edge.id;
    return {
      edgeId: edge.id,
      fromNodeId: edge.from,
      fromName: name(edge.from),
      toNodeId: edge.to,
      toName: name(edge.to),
      on: edge.on,
      condition: edge.on === 'findings' ? describeFindingsPredicate(edge.when, run.parameters) : edge.on === 'failure' ? 'the stage fails' : edge.on === 'always' ? 'every time' : 'the stage succeeds',
      iterationsTaken: status.iterationsTaken,
      budget: status.budget,
      firing: status.fires && !status.exhausted,
      needsDecision,
      history: history.map(entry => ({
        iteration: entry.iteration,
        at: entry.at,
        outcome: entry.outcome,
        findingCount: entry.findingCount,
        topFindings: topFindings(entry.findings),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.score !== undefined ? { score: entry.score } : {}),
        ...(entry.restoredTo ? { restoredTo: entry.restoredTo } : {})
      })),
      ...(keepBest
        ? {
            keepBest: {
              metric: keepBest.metric,
              higherIsBetter: keepBest.higherIsBetter,
              ...(best ? { bestIteration: best.iteration, bestScore: best.score } : {}),
              ...(typeof currentScore === 'number' ? { currentScore } : {})
            }
          }
        : {}),
      ...(needsDecision && source?.findings ? { openFindings: topFindings(source.findings.findings) } : {}),
      ...(status.fires || !source || !['succeeded', 'failed'].includes(source.outcome)
        ? {}
        : {
            stoppedBecause: status.outOfPatience
              ? ('no-improvement' as const)
              : (run.loopDecisions ?? []).some(decision => decision.edgeId === edge.id && decision.decision === 'accept' && decision.sourceAttempt === source.attempts.length)
                ? ('accepted' as const)
                : ('condition-met' as const)
          }),
      decisions: (run.loopDecisions ?? [])
        .filter(decision => decision.edgeId === edge.id)
        .map(decision => ({
          at: decision.at,
          actor: decision.actor,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.extraIterations ? { extraIterations: decision.extraIterations } : {})
        }))
    };
  });
}

/**
 * Which pass of a loop each stage is on: every stage from the loop's target to
 * its source (inclusive) is "in" the loop. A stage inside two loops reports the
 * first in definition order.
 */
function loopIterationsByNode(run: WorkflowRun): Map<string, NonNullable<StageRow['loopIteration']>> {
  const byNode = new Map<string, NonNullable<StageRow['loopIteration']>>();
  for (const status of loopStatuses(run)) {
    const { edge } = status;
    const downstreamOfTarget = downstreamNodeIds(run, edge.to);
    if (!downstreamOfTarget.has(edge.from)) continue;
    for (const nodeId of downstreamOfTarget) {
      // In the loop body only when the source is reachable from it too.
      if (nodeId !== edge.from && !downstreamNodeIds(run, nodeId).has(edge.from)) continue;
      if (byNode.has(nodeId)) continue;
      byNode.set(nodeId, { edgeId: edge.id, iteration: Math.min(status.iterationsTaken + 1, status.budget + 1), budget: status.budget + 1 });
    }
  }
  return byNode;
}

function attemptBudget(node: WorkflowNode): number | undefined {
  return node.type === 'agent-task' || node.type === 'check' || node.type === 'deployment'
    ? node.maxAttempts
    : undefined;
}

/** Builds the monitor view. Pass the composed policy so gate rows match enforcement. */
export function summarizeWorkflowRun(run: WorkflowRun, policy?: WorkflowPolicyProfile): WorkflowRunSummary {
  const schedule = scheduleWorkflowRun(run);
  const ready = new Set(schedule.ready);
  const awaiting = new Set(schedule.awaitingApproval);
  const inLoop = loopIterationsByNode(run);

  const stages: StageRow[] = run.definition.nodes.map(node => {
    const state = run.nodes[node.id];
    const lastAttempt = state?.attempts[state.attempts.length - 1];
    const durationMs =
      lastAttempt?.startedAt && lastAttempt?.endedAt
        ? Math.max(0, new Date(lastAttempt.endedAt).getTime() - new Date(lastAttempt.startedAt).getTime())
        : undefined;
    const command =
      node.type === 'check'
        ? [node.command, ...(node.args ?? [])].filter(Boolean).join(' ')
        : undefined;
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      outcome: state?.outcome ?? 'pending',
      lane: laneFor(run, node.id, ready, awaiting),
      attempts: state?.attempts.length ?? 0,
      ...(attemptBudget(node) !== undefined ? { maxAttempts: attemptBudget(node) } : {}),
      ...(lastAttempt?.sessionId
        ? { sessionId: lastAttempt.sessionId, sessionKey: stageSessionKey(run.runId, node.id) }
        : {}),
      ...(state?.snapshotRef ? { snapshotRef: state.snapshotRef } : {}),
      ...(nodeGate(node) ? { gate: nodeGate(node) } : {}),
      artifacts: (state?.artifacts ?? []).map(artifact => ({
        contractId: artifact.contractId,
        kind: artifact.kind,
        ...(artifact.path ? { path: artifact.path } : {}),
        ...(artifact.reference ? { reference: artifact.reference } : {})
      })),
      ...(lastAttempt?.error ? { lastError: lastAttempt.error } : {}),
      ...(state && pauseReasonOf(state) ? { pause: pauseReasonOf(state) } : {}),
      ...(state?.phase ? { phase: state.phase } : {}),
      ...(state?.findings ? { findings: state.findings } : {}),
      ...(lastAttempt?.provider ? { provider: lastAttempt.provider } : {}),
      ...(lastAttempt?.model ? { model: lastAttempt.model } : {}),
      ...(lastAttempt?.independence ? { independence: lastAttempt.independence } : {}),
      ...(chosenProviderOf(run, node) ? { chosenProvider: chosenProviderOf(run, node) } : {}),
      ...(chosenModelOf(run, node) ? { chosenModel: chosenModelOf(run, node) } : {}),
      ...(command ? { command } : {}),
      ...(lastAttempt?.exitCode !== undefined ? { exitCode: lastAttempt.exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(isApprovalNode(node) ? { prompt: node.prompt, requiredGates: node.requiredGates } : {}),
      ...(inLoop.has(node.id) ? { loopIteration: inLoop.get(node.id) } : {})
    };
  });
  const loops = summarizeLoops(run);
  const deciding = loops.find(loop => loop.needsDecision);

  // Union across every approval node, not just the first — a gate kind
  // required by more than one approval node evaluates identically for each
  // (the owning stage decides it), so the first evaluation wins the dedupe.
  // `approvalReadiness` (rather than `evaluateGates` directly) so each row
  // can also carry whether it is currently bypassable and which approval
  // node a bypass/approve of it would target.
  const gatesByKind = new Map<string, GateStatus>();
  for (const approval of run.definition.nodes.filter(isApprovalNode)) {
    const readiness = approvalReadiness(run, approval.id, policy);
    const bypassableKinds = new Set(readiness.bypassable.map(candidate => candidate.gate));
    for (const gate of readiness.gates) {
      if (gatesByKind.has(gate.gate)) continue;
      const bypassable = bypassableKinds.has(gate.gate);
      // The workflow itself would allow waiving this, but the effective
      // policy (an explicit forbid, or none at all — the deny-by-default
      // case) is what's actually stopping it.
      const bypassBlockedByPolicy =
        !bypassable && approval.allowBypass && gate.state !== 'pending' && gate.state !== 'passed' && gate.state !== 'bypassed';
      gatesByKind.set(gate.gate, {
        ...gate,
        bypassable,
        approvalNodeId: approval.id,
        ...(bypassBlockedByPolicy ? { bypassBlockedByPolicy: true } : {})
      });
    }
  }
  const gates = [...gatesByKind.values()];

  // `run.status` is only advanced by settling commands; `awaiting-approval` is a
  // fact about the graph, so it is derived here the same way the scheduler does.
  const status = deriveRunStatus(run);

  return {
    runId: run.runId,
    projectId: run.projectId,
    workflowName: run.displayName ?? run.definition.name,
    status,
    explanation: explainRun(run, status, schedule.blocked),
    stages,
    graph: {
      nodes: run.definition.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, type: node.type })),
      edges: run.definition.edges,
      entryNodeId: run.definition.entryNodeId
    },
    gates,
    branchGroups: branchGroups(run),
    actions: nextActions(run),
    ...(status === 'running' && stages.some(stage => stage.lane === 'paused') && !stages.some(stage => stage.lane === 'running')
      ? {
          paused: true,
          pauseReason: stages.some(stage => stage.pause === 'environment') ? ('environment' as const) : ('provider-limit' as const)
        }
      : {}),
    outstanding: outstandingNodes(run),
    events: run.events,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.issueKey ? { issueKey: run.issueKey } : {}),
    ...(run.controllerSessionKey ? { controllerSessionKey: run.controllerSessionKey } : {}),
    ...(run.controllerSessionId ? { controllerSessionId: run.controllerSessionId } : {}),
    ...(run.planInput ? { planInput: run.planInput } : {}),
    ...(run.aiProvider ? { aiProvider: run.aiProvider } : {}),
    ...(run.aiModel ? { aiModel: run.aiModel } : {}),
    ...(run.archived ? { archived: true, archivedAt: run.archivedAt } : {}),
    permissionMode: run.permissionMode === 'auto' ? 'auto' : 'ask',
    providerLimitPolicy: run.providerLimitPolicy ?? 'ask',
    exhaustedProviders: exhaustedProviders(run),
    loops,
    ...(deciding && schedule.blocked ? { needsDecision: { edgeId: deciding.edgeId, message: schedule.blocked } } : {}),
    ...(run.parameters ? { parameters: run.parameters } : {})
  };
}

function chosenProviderOf(run: WorkflowRun, node: WorkflowNode): string | undefined {
  if (node.type !== 'agent-task') return undefined;
  return run.stageProviders?.[node.id] ?? (node.agent.providerId?.trim() || undefined);
}

function chosenModelOf(run: WorkflowRun, node: WorkflowNode): string | undefined {
  if (node.type !== 'agent-task') return undefined;
  return run.stageModels?.[node.id] ?? (node.model?.trim() || undefined);
}

/** The parallel branches feeding each join, and whether they have converged. */
export function branchGroups(run: WorkflowRun): BranchGroup[] {
  return run.definition.nodes.filter(isJoinNode).map(join => {
    const inbound = dagEdges(run.definition).filter(edge => edge.to === join.id);
    return {
      joinNodeId: join.id,
      joinName: join.name,
      converged: run.nodes[join.id]?.outcome === 'succeeded',
      branches: inbound.map(edge => {
        const head = run.definition.nodes.find(node => node.id === edge.from);
        return {
          headNodeId: edge.from,
          headName: head?.name ?? edge.from,
          outcome: run.nodes[edge.from]?.outcome ?? 'pending',
          required: edge.required
        };
      })
    };
  });
}

function explainRun(run: WorkflowRun, status: WorkflowRun['status'], blocked: string | undefined): string {
  if (status === 'succeeded') {
    // A loop that ended without meeting its condition did not reach its goal, whatever the run did after.
    const short = summarizeLoops(run).find(loop => loop.stoppedBecause === 'accepted' || loop.stoppedBecause === 'no-improvement');
    if (short) {
      const best = short.keepBest?.bestScore !== undefined ? ` The best ${short.keepBest.metric} was ${short.keepBest.bestScore} (iteration ${short.keepBest.bestIteration}).` : '';
      return `The run completed, but the target was not reached: ${short.fromName} still matched "${short.condition}" when it stopped${short.stoppedBecause === 'no-improvement' ? ' improving' : ''}.${best}`;
    }
    return 'The run completed: every required stage passed and approval was granted.';
  }
  if (status === 'cancelled') return `The run was cancelled${run.endedReason ? `: ${run.endedReason}` : '.'}`;
  if (status === 'failed') return `The run failed${run.endedReason ? `: ${run.endedReason}` : '.'}`;

  const running = Object.values(run.nodes).filter(state => state.outcome === 'running');
  if (running.length > 0) {
    const names = running
      .map(state => run.definition.nodes.find(node => node.id === state.nodeId)?.name ?? state.nodeId)
      .sort();
    return `${names.length === 1 ? 'Stage' : 'Stages'} in progress: ${names.join(', ')}.`;
  }

  if (status === 'awaiting-approval') {
    return 'Every required gate has resolved; the run is waiting for a human approval.';
  }

  // A pending loop explains the run better than the failure that fired it.
  if (pendingLoop(run) && blocked) return blocked;

  const paused = Object.values(run.nodes).filter(state => isPausedNode(state));
  if (paused.length > 0) {
    const names = paused
      .map(state => run.definition.nodes.find(node => node.id === state.nodeId)?.name ?? state.nodeId)
      .sort();
    return paused.some(state => pauseReasonOf(state) === 'environment')
      ? `${names.join(', ')} could not run in this environment — for example a registry that does not serve the request, a missing command, or no network. Fix that, then retry; nothing is lost and no attempt was used.`
      : (() => {
          const ais = [...new Set(paused.map(state => state.attempts[state.attempts.length - 1]?.provider).filter((id): id is string => Boolean(id)))];
          const who = ais.length ? ais.map(providerDisplayName).join(' and ') : 'The AI provider';
          return `${who} ran out of credits or hit its usage limit at ${names.join(', ')}. Switch to another AI, or restore them and retry — nothing is lost and no attempt was used.`;
        })();
  }

  // A retryable failure is described by stage name before falling back to the
  // scheduler's terser stall message.
  const retryable = Object.values(run.nodes).filter(state => state.outcome === 'failed');
  if (retryable.length > 0) {
    const names = retryable
      .map(state => run.definition.nodes.find(node => node.id === state.nodeId)?.name ?? state.nodeId)
      .sort();
    return `${names.join(', ')} failed and can be retried or the run cancelled.`;
  }

  if (blocked) return blocked;

  return isRunSettled(run) ? 'The run has ended.' : 'Waiting for the next stage to be dispatched.';
}
