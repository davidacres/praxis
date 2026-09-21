/**
 * Run monitor view model (FX-BE-022 / TASK-105).
 *
 * Derives everything the monitor renders from a `WorkflowRun` value: a row per
 * stage with its status and evidence, the gate ledger, the parallel branches
 * and where they converge, and a single sentence explaining why the run is
 * active, blocked, failed, or complete. Pure, so the UI never has to reconstruct
 * run logic and the explanation can be asserted in a test.
 */

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
  isPausedNode,
  pauseReasonOf,
  isRunSettled,
  type WorkflowNodeState,
  type WorkflowRun,
  type WorkflowPauseReason,
  type WorkflowRunEvent
} from './workflowRun';
import { deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { nextActions, outstandingNodes, type WorkflowNextAction } from './workflowRecovery';
import type { AiProvider } from '../types';
import { approvalReadiness, type GateStatus } from './workflowGates';
import { stageSessionKey } from './workflowStageTask';
import type { WorkflowPolicyProfile } from './workflowTypes';
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
  artifacts: Array<{ contractId: string; kind: string; path?: string }>;
  lastError?: string;
  /** The last attempt stopped without a verdict (AI provider limit, or the stage's tooling could not run); retrying does not spend an attempt. */
  pause?: WorkflowPauseReason;
  /** The in-flight attempt's reported sub-phase, e.g. a deployment stage's `'deploying'`/`'verifying'` — see `WorkflowNodeState.phase`. */
  phase?: string;
  findings?: CheckFindings;
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
  /** Whether this run is archived by the user. */
  archived?: boolean;
  archivedAt?: string;
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

  const stages: StageRow[] = run.definition.nodes.map(node => {
    const state = run.nodes[node.id];
    const lastAttempt = state?.attempts[state.attempts.length - 1];
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
        ...(artifact.path ? { path: artifact.path } : {})
      })),
      ...(lastAttempt?.error ? { lastError: lastAttempt.error } : {}),
      ...(state && pauseReasonOf(state) ? { pause: pauseReasonOf(state) } : {}),
      ...(state?.phase ? { phase: state.phase } : {}),
      ...(state?.findings ? { findings: state.findings } : {})
    };
  });

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
    workflowName: run.definition.name,
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
    permissionMode: run.permissionMode === 'auto' ? 'auto' : 'ask'
  };
}

/** The parallel branches feeding each join, and whether they have converged. */
export function branchGroups(run: WorkflowRun): BranchGroup[] {
  return run.definition.nodes.filter(isJoinNode).map(join => {
    const inbound = run.definition.edges.filter(edge => edge.to === join.id);
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
  if (status === 'succeeded') return 'The run completed: every required stage passed and approval was granted.';
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

  const paused = Object.values(run.nodes).filter(state => isPausedNode(state));
  if (paused.length > 0) {
    const names = paused
      .map(state => run.definition.nodes.find(node => node.id === state.nodeId)?.name ?? state.nodeId)
      .sort();
    return paused.some(state => pauseReasonOf(state) === 'environment')
      ? `${names.join(', ')} could not run in this environment — for example a registry that does not serve the request, a missing command, or no network. Fix that, then retry; nothing is lost and no attempt was used.`
      : `The AI provider's credits or usage limit were reached at ${names.join(', ')}. Restore them (or switch that stage's agent), then retry — nothing is lost and no attempt was used.`;
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
