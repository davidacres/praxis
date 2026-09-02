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
  type WorkflowEdge,
  type WorkflowGateKind,
  type WorkflowNode
} from './workflowTypes';
import {
  isRunSettled,
  type WorkflowNodeState,
  type WorkflowRun,
  type WorkflowRunEvent
} from './workflowRun';
import { deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { nextActions, outstandingNodes, type WorkflowNextAction } from './workflowRecovery';
import { evaluateGates, type GateStatus } from './workflowGates';
import { stageSessionKey } from './workflowStageTask';
import type { WorkflowPolicyProfile } from './workflowTypes';

export interface StageRow {
  nodeId: string;
  name: string;
  type: WorkflowNode['type'];
  outcome: WorkflowNodeState['outcome'];
  /** 'running' | 'ready' | 'blocked' | 'skipped' | 'done' — for the monitor's dot. */
  lane: 'idle' | 'ready' | 'running' | 'done' | 'failed' | 'skipped' | 'awaiting';
  attempts: number;
  maxAttempts?: number;
  sessionId?: string;
  /** The session store key for this stage, so the monitor can link to it. */
  sessionKey?: string;
  snapshotRef?: string;
  gate?: WorkflowGateKind;
  artifacts: Array<{ contractId: string; kind: string; path?: string }>;
  lastError?: string;
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
  outstanding: string[];
  /** Newest last. */
  events: WorkflowRunEvent[];
  startedAt: string;
  endedAt?: string;
}

function laneFor(
  run: WorkflowRun,
  nodeId: string,
  ready: Set<string>,
  awaiting: Set<string>
): StageRow['lane'] {
  const outcome = run.nodes[nodeId]?.outcome ?? 'pending';
  if (outcome === 'running') return 'running';
  if (outcome === 'succeeded') return 'done';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'skipped' || outcome === 'cancelled') return 'skipped';
  if (awaiting.has(nodeId)) return 'awaiting';
  if (ready.has(nodeId)) return 'ready';
  return 'idle';
}

function attemptBudget(node: WorkflowNode): number | undefined {
  return node.type === 'agent-task' || node.type === 'check' ? node.maxAttempts : undefined;
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
      ...(lastAttempt?.error ? { lastError: lastAttempt.error } : {})
    };
  });

  const approvalNode = run.definition.nodes.find(isApprovalNode);
  const gates = approvalNode ? evaluateGates(run, approvalNode.id, policy) : [];

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
    outstanding: outstandingNodes(run),
    events: run.events,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {})
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
