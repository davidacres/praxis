/**
 * Gate evaluation, approval, and audited bypass (FX-BE-020 / TASK-100).
 *
 * A gate is satisfied by a **node outcome**, never by a claim. The node that
 * declares `satisfiesGate` owns that gate, and its outcome is decided by the
 * engine: an exit code for a check, or — for an agent stage — success plus the
 * artifacts its contract required, enforced in `workflowRun`. An agent cannot
 * reach into a check's outcome, so prose cannot mark QA or security passed.
 *
 * Worth being straight about the limit: a *review* gate backed by an agent is
 * only as good as that agent, because the agent decides whether it succeeded.
 * What the engine guarantees is that the stage genuinely ran and genuinely
 * produced the report it promised. A project that wants a gate no model can
 * assert should back it with a check node.
 *
 * Policy passed in must be the composed profile from
 * `WorkflowPolicyStore.effectiveForProject`. A raw project profile can be
 * weaker than the org's, and reading one here would undo the strictest-wins
 * composition entirely.
 */

import {
  isApprovalNode,
  nodeGate,
  type WorkflowGateDecision,
  type WorkflowGateKind,
  type WorkflowPolicyProfile
} from './workflowTypes';
import { applyWorkflowRunCommand, type WorkflowRun } from './workflowRun';

export interface GateStatus {
  gate: WorkflowGateKind;
  /** The node that owns this gate, if the workflow has one. */
  nodeId?: string;
  state: 'passed' | 'failed' | 'pending' | 'missing' | 'bypassed';
  /** Whether the gate rests on a deterministic check rather than an agent. */
  deterministic: boolean;
  detail: string;
}

export interface ApprovalReadiness {
  canApprove: boolean;
  /** Gates the approval is waiting on, with why. */
  blocking: GateStatus[];
  /** Gates a bypass could clear, when policy permits one. */
  bypassable: GateStatus[];
  gates: GateStatus[];
}

/**
 * Evaluates every gate an approval node requires, widened by policy.
 *
 * The union is the point: policy can add gates the definition did not name,
 * and validation already refuses a workflow that cannot satisfy them.
 */
export function evaluateGates(
  run: WorkflowRun,
  approvalNodeId: string,
  policy?: WorkflowPolicyProfile
): GateStatus[] {
  const approval = run.definition.nodes.find(node => node.id === approvalNodeId);
  if (!approval || !isApprovalNode(approval)) return [];

  const required = [...new Set([...approval.requiredGates, ...(policy?.requiredGates ?? [])])].sort();

  return required.map(gate => {
    const owner = run.definition.nodes.find(node => nodeGate(node) === gate);
    const decision = run.gateDecisions.find(candidate => candidate.gate === gate);

    if (decision?.bypassed) {
      return {
        gate,
        ...(owner ? { nodeId: owner.id } : {}),
        state: 'bypassed' as const,
        deterministic: owner?.type === 'check',
        detail: `Bypassed by ${decision.bypassedBy ?? 'unknown'}: ${decision.reason ?? 'no reason given'}`
      };
    }

    if (!owner) {
      return {
        gate,
        state: 'missing' as const,
        deterministic: false,
        detail: `No stage in this workflow satisfies the "${gate}" gate.`
      };
    }

    const state = run.nodes[owner.id];
    const deterministic = owner.type === 'check';

    if (state?.outcome === 'succeeded') {
      return { gate, nodeId: owner.id, state: 'passed' as const, deterministic, detail: `${owner.name} succeeded.` };
    }
    if (state?.outcome === 'failed' || state?.outcome === 'cancelled' || state?.outcome === 'skipped') {
      return {
        gate,
        nodeId: owner.id,
        state: 'failed' as const,
        deterministic,
        detail: `${owner.name} ${state.outcome}.`
      };
    }
    return {
      gate,
      nodeId: owner.id,
      state: 'pending' as const,
      deterministic,
      detail: `${owner.name} has not finished.`
    };
  });
}

/**
 * Whether approval may be offered, and what is standing in the way.
 *
 * A gate is only bypassable when policy allows it *and* the approval node
 * allows it. Either saying no is enough to refuse.
 */
export function approvalReadiness(
  run: WorkflowRun,
  approvalNodeId: string,
  policy?: WorkflowPolicyProfile
): ApprovalReadiness {
  const approval = run.definition.nodes.find(node => node.id === approvalNodeId);
  const gates = evaluateGates(run, approvalNodeId, policy);
  const blocking = gates.filter(gate => gate.state !== 'passed' && gate.state !== 'bypassed');

  const bypassAllowed =
    !!approval && isApprovalNode(approval) && approval.allowBypass && (policy?.allowGateBypass ?? false);

  return {
    canApprove: blocking.length === 0,
    blocking,
    // A pending gate is not bypassable: it has not failed, it simply has not
    // finished, and waving through work that is still running is not an
    // exemption — it is a race.
    bypassable: bypassAllowed ? blocking.filter(gate => gate.state !== 'pending') : [],
    gates
  };
}

export interface GateBypassInput {
  gate: WorkflowGateKind;
  /** Who is overriding. Required — an anonymous bypass is not auditable. */
  actor: string;
  /** Why. Required, and refused if blank. */
  reason: string;
  at: string;
}

/**
 * Records an attributed bypass.
 *
 * Refuses rather than throws for a policy or state violation, so the caller can
 * put the reason in front of the user. Throws only for a missing actor or
 * reason, which is a programming error — the UI must collect both.
 */
export function bypassGate(
  run: WorkflowRun,
  approvalNodeId: string,
  input: GateBypassInput,
  policy?: WorkflowPolicyProfile
): { run: WorkflowRun; ok: boolean; reason?: string } {
  if (!input.actor.trim()) throw new Error('A gate bypass must record who performed it.');
  if (!input.reason.trim()) throw new Error('A gate bypass must record why.');

  const readiness = approvalReadiness(run, approvalNodeId, policy);
  const target = readiness.bypassable.find(gate => gate.gate === input.gate);
  if (!target) {
    const known = readiness.gates.find(gate => gate.gate === input.gate);
    return {
      run,
      ok: false,
      reason: !known
        ? `Gate "${input.gate}" is not required here.`
        : known.state === 'pending'
          ? `Gate "${input.gate}" has not finished; wait for it rather than bypassing it.`
          : `Gate "${input.gate}" cannot be bypassed under the active policy.`
    };
  }

  const decision: WorkflowGateDecision = {
    gate: input.gate,
    nodeId: target.nodeId ?? approvalNodeId,
    passed: false,
    bypassed: true,
    bypassedBy: input.actor,
    reason: input.reason,
    decidedAt: input.at
  };

  return { run: applyWorkflowRunCommand(run, { kind: 'gate-decided', at: input.at, decision }), ok: true };
}

export interface ApprovalInput {
  actor: string;
  at: string;
  note?: string;
}

/**
 * Grants approval, settling the approval stage.
 *
 * Refuses while any required gate is unmet — the check is made here rather
 * than trusted to the caller, so no UI path can approve around it.
 */
export function approveStage(
  run: WorkflowRun,
  approvalNodeId: string,
  input: ApprovalInput,
  policy?: WorkflowPolicyProfile
): { run: WorkflowRun; ok: boolean; reason?: string } {
  if (!input.actor.trim()) throw new Error('An approval must record who granted it.');

  const readiness = approvalReadiness(run, approvalNodeId, policy);
  if (!readiness.canApprove) {
    return {
      run,
      ok: false,
      reason: `Blocked on ${readiness.blocking.map(gate => `${gate.gate} (${gate.state})`).join(', ')}.`
    };
  }

  let next = run;
  for (const gate of readiness.gates) {
    if (gate.state !== 'passed') continue;
    next = applyWorkflowRunCommand(next, {
      kind: 'gate-decided',
      at: input.at,
      decision: {
        gate: gate.gate,
        nodeId: gate.nodeId ?? approvalNodeId,
        passed: true,
        bypassed: false,
        decidedAt: input.at
      }
    });
  }

  next = applyWorkflowRunCommand(next, { kind: 'node-started', nodeId: approvalNodeId, at: input.at });
  next = applyWorkflowRunCommand(next, { kind: 'node-succeeded', nodeId: approvalNodeId, at: input.at });
  return { run: next, ok: true };
}

/** Rejects at an approval stage, failing the branch with an attributed reason. */
export function rejectStage(
  run: WorkflowRun,
  approvalNodeId: string,
  input: { actor: string; reason: string; at: string }
): WorkflowRun {
  if (!input.actor.trim()) throw new Error('A rejection must record who made it.');
  if (!input.reason.trim()) throw new Error('A rejection must record why.');

  const next = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: approvalNodeId, at: input.at });
  return applyWorkflowRunCommand(next, {
    kind: 'node-failed',
    nodeId: approvalNodeId,
    at: input.at,
    error: `Rejected by ${input.actor}: ${input.reason}`
  });
}
