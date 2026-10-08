/**
 * Stage session attribution and artifact handoff (FX-BE-020 / TASK-099).
 *
 * The existing `AiSessionManager` is keyed by issue, because a session there
 * belongs to a ticket. A workflow stage is not a ticket — it is a node in a
 * run — so attribution lives here as its own record and the session layer is
 * reached through `WorkflowSessionPort`. When FX-BF-011 lands a real session
 * lifecycle, it implements that port; nothing in the workflow engine moves.
 *
 * The handoff rule is the point of this module. A downstream stage receives
 * the artifacts its node declared as inputs, plus the immutable implementation
 * snapshot — and nothing else. Not the upstream conversation, not the raw
 * transcript. A reviewer that reads the implementer's chat is reviewing an
 * argument; a reviewer that reads the diff is reviewing the change.
 */

import {
  isAgentTaskNode,
  nodeOutputs,
  type WorkflowArtifactContract,
  type WorkflowArtifactRef,
  type WorkflowNode
} from './workflowTypes';
import type { WorkflowRun } from './workflowRun';
import { dagEdges } from './workflowEdges';
import type { StageAgentBinding } from './workflowPreflight';
import type { AgentWorkflowProvenance, AgentWorkflowReference } from '../ai/agentTypes';

/** A workflow-pack snapshot resolved before a governed stage is launched. */
export interface WorkflowPackContext {
  reference: AgentWorkflowReference;
  /** Bounded SKILL.md content; never an arbitrary path supplied to the host. */
  instructions: string;
  provenance: AgentWorkflowProvenance;
}

/** Links one stage attempt to the agent session that ran it. */
export interface WorkflowStageSession {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId: string;
  agentId: string;
  startedAt: string;
  /** A short account of what the stage did, for the run monitor. */
  summary?: string;
}

/** The immutable thing a verification stage inspects. */
export interface WorkflowImplementationSnapshot {
  /** Commit sha or worktree ref. */
  ref: string;
  producedByNodeId: string;
}

/** Everything a stage is given when it starts. Deliberately closed. */
export interface WorkflowStageContext {
  runId: string;
  nodeId: string;
  stageName: string;
  instructions: string;
  /** Resolved artifacts for the ids this node declared as inputs. */
  inputs: WorkflowArtifactRef[];
  /** What the stage must produce to be allowed to succeed. */
  expectedOutputs: WorkflowArtifactContract[];
  /** The frozen implementation, when an upstream stage produced one. */
  snapshot?: WorkflowImplementationSnapshot;
  /** Present for agent stages that passed preflight. */
  binding?: StageAgentBinding;
  /** Present when the node declares a workspace workflow pack. */
  workflowPack?: WorkflowPackContext;
}

/**
 * The session lifecycle the orchestrator needs from the runtime.
 *
 * Deliberately four methods wide. FX-BF-011 owns the implementation; keeping
 * the surface this narrow is what lets FX-BE-020 be built and tested before
 * that story exists.
 */
export interface WorkflowSessionPort {
  /** Creates a session bound to a stage, returning its id. */
  createStageSession(context: WorkflowStageContext, binding: StageAgentBinding): Promise<string>;
  /** Cancels a session, e.g. on timeout or run cancellation. */
  cancelStageSession(sessionId: string): Promise<void>;
  /** A short summary of what the session did, for the run monitor. */
  summarizeStageSession(sessionId: string): Promise<string | undefined>;
}

/**
 * Builds the context for a stage about to run.
 *
 * Inputs are resolved from what upstream stages actually produced. An input
 * whose artifact is missing is omitted rather than faked — the stage then
 * fails its own contract, which is the honest outcome.
 */
export function buildStageContext(
  run: WorkflowRun,
  nodeId: string,
  binding?: StageAgentBinding
): WorkflowStageContext | undefined {
  const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
  if (!node) return undefined;

  const produced = new Map<string, WorkflowArtifactRef>();
  for (const state of Object.values(run.nodes)) {
    for (const artifact of state.artifacts) produced.set(artifact.contractId, artifact);
  }

  const inputs = node.inputs
    .map(contractId => produced.get(contractId))
    .filter((artifact): artifact is WorkflowArtifactRef => !!artifact);

  const snapshot = findSnapshot(run, nodeId);

  return {
    runId: run.runId,
    nodeId,
    stageName: node.name,
    instructions: isAgentTaskNode(node) ? node.instructions : '',
    inputs,
    expectedOutputs: nodeOutputs(node),
    ...(snapshot ? { snapshot } : {}),
    ...(binding ? { binding } : {})
  };
}

/**
 * The implementation snapshot a stage should inspect: the nearest one produced
 * upstream of it.
 *
 * Walking backwards matters — a workflow can have several mutating stages, and
 * a reviewer must see the one that actually feeds its branch, not whichever
 * happened to run last.
 */
export function findSnapshot(run: WorkflowRun, nodeId: string): WorkflowImplementationSnapshot | undefined {
  const inbound = new Map<string, string[]>();
  // A loop edge is not an inbound branch: walking it would hand a stage the
  // snapshot of work that runs *after* it in the same revision.
  for (const edge of dagEdges(run.definition)) {
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge.from]);
  }

  const seen = new Set<string>();
  let frontier = [...(inbound.get(nodeId) ?? [])];

  // Breadth-first so "nearest" means fewest hops, not first-found.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ref = run.nodes[id]?.snapshotRef;
      if (ref) return { ref, producedByNodeId: id };
      next.push(...(inbound.get(id) ?? []));
    }
    frontier = next;
  }

  return undefined;
}

/** Every stage session recorded on this run, newest attempt last. */
export function stageSessions(run: WorkflowRun): WorkflowStageSession[] {
  const sessions: WorkflowStageSession[] = [];
  for (const node of run.definition.nodes) {
    const state = run.nodes[node.id];
    if (!state) continue;
    for (const attempt of state.attempts) {
      if (!attempt.sessionId) continue;
      sessions.push({
        runId: run.runId,
        nodeId: node.id,
        attempt: attempt.attempt,
        sessionId: attempt.sessionId,
        agentId: agentIdOf(node) ?? '',
        startedAt: attempt.startedAt
      });
    }
  }
  return sessions;
}

/** The session backing a stage's current attempt, if it has one. */
export function currentStageSession(run: WorkflowRun, nodeId: string): WorkflowStageSession | undefined {
  return stageSessions(run)
    .filter(session => session.nodeId === nodeId)
    .pop();
}

function agentIdOf(node: WorkflowNode): string | undefined {
  return isAgentTaskNode(node) ? node.agent.agentId : undefined;
}
