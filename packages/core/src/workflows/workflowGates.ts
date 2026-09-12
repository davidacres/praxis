/**
 * Gate evaluation, approval, and audited bypass (FX-BE-020 / TASK-100).
 *
 * A gate is satisfied by a **node outcome**, never by a claim. The node that
 * declares `satisfiesGate` owns that gate, and its outcome is decided by the
 * engine: an exit code for a check, success plus the required artifacts for a
 * deployment stage's health verification, or — for an agent stage — success
 * plus the artifacts its contract required, enforced in `workflowRun`. An
 * agent cannot reach into a check's or a deployment's outcome, so prose
 * cannot mark QA or security passed.
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
  type CheckFindingSeverity,
  type CheckFindings,
  type GateThresholdCondition,
  type WorkflowGateDecision,
  type WorkflowGateKind,
  type WorkflowPolicyProfile
} from './workflowTypes';
import { applyWorkflowRunCommand, type WorkflowRun } from './workflowRun';
import { filterUnwaivedFindings } from './waiverRegister';

const SEVERITY_RANK: Record<CheckFindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface GateStatus {
  gate: WorkflowGateKind;
  /** The node that owns this gate, if the workflow has one. */
  nodeId?: string;
  state: 'passed' | 'failed' | 'pending' | 'missing' | 'bypassed';
  /** Whether the gate rests on a deterministic check rather than an agent. */
  deterministic: boolean;
  detail: string;
}

export interface CiImportedEvidenceRecord {
  provider: 'github-actions' | 'gitlab-ci';
  runId: string;
  sha: string;
  available: boolean;
  findings?: CheckFindings;
}

export type CiImportedEvidenceState = Record<string, CiImportedEvidenceRecord>;

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
  policy?: WorkflowPolicyProfile,
  ciEvidence?: CiImportedEvidenceState
): GateStatus[] {
  const approval = run.definition.nodes.find(node => node.id === approvalNodeId);
  if (!approval || !isApprovalNode(approval)) return [];

  const required = [...new Set([...approval.requiredGates, ...(policy?.requiredGates ?? [])])].sort();

  return required.map(gate => {
    const owners = run.definition.nodes.filter(node => nodeGate(node) === gate);
    const decision = run.gateDecisions.find(candidate => candidate.gate === gate);

    if (decision?.bypassed) {
      return {
        gate,
        ...(owners.length === 1 ? { nodeId: owners[0].id } : {}),
        state: 'bypassed' as const,
        deterministic: owners.length > 0 && owners.every(o => o.type === 'check' || o.type === 'deployment'),
        detail: `Bypassed by ${decision.bypassedBy ?? 'unknown'}: ${decision.reason ?? 'no reason given'}`
      };
    }

    if (owners.length === 0) {
      return {
        gate,
        state: 'missing' as const,
        deterministic: false,
        detail: `No stage in this workflow satisfies the "${gate}" gate.`
      };
    }

    const waivers = [...(policy?.waivers ?? []), ...(approval.waivers ?? [])];
    const currentSnapshotRef = Object.values(run.nodes).find(n => !!n.snapshotRef)?.snapshotRef;

    if (owners.length === 1) {
      const owner = owners[0];
      const deterministic = owner.type === 'check' || owner.type === 'deployment';

      // Observe mode for CI evidence (TASK-252)
      if (owner.type === 'check' && owner.observe?.enabled) {
        const evidence = ciEvidence?.[owner.id] ?? ciEvidence?.[gate];
        if (evidence) {
          if (evidence.sha === currentSnapshotRef) {
            if (!evidence.available) {
              return {
                gate,
                nodeId: owner.id,
                state: 'pending' as const,
                deterministic,
                detail: `${owner.name} is observing CI for ${evidence.sha.slice(0, 7)}: report reconciling/not yet available.`
              };
            }

            const rawFindings = evidence.findings?.findings ?? [];
            const { activeFindings, waivedFindings } = filterUnwaivedFindings(
              rawFindings,
              waivers,
              new Date(),
              currentSnapshotRef
            );

            const conditions: GateThresholdCondition[] = [
              ...(policy?.gateThresholds?.[gate] ?? []),
              ...(approval.gateThresholds?.[gate] ?? []),
              ...((owner as any).gateThresholds ?? [])
            ];

            for (const cond of conditions) {
              if (cond.type === 'severity') {
                const targetLevel = cond.severityLevel ?? 'high';
                const targetRank = SEVERITY_RANK[targetLevel] ?? 3;
                const count = activeFindings.filter(
                  f => (SEVERITY_RANK[f.severity] ?? 0) >= targetRank
                ).length;
                if (count > cond.maxCount) {
                  return {
                    gate,
                    nodeId: owner.id,
                    state: 'failed' as const,
                    deterministic,
                    detail: `Observed from CI (${evidence.provider} run ${evidence.runId}@${evidence.sha.slice(0, 7)}): Found ${count} finding(s) with severity >= ${targetLevel} (max allowed: ${cond.maxCount}).`
                  };
                }
              }
            }

            const waivedNote = waivedFindings.length > 0 ? ` (${waivedFindings.length} findings waived)` : '';
            return {
              gate,
              nodeId: owner.id,
              state: 'passed' as const,
              deterministic,
              detail: `Observed from CI (${evidence.provider} run ${evidence.runId}@${evidence.sha.slice(0, 7)})${waivedNote}.`
            };
          }
          // Snapshot mismatch falls through to local check below
        }
      }

      const state = run.nodes[owner.id];

      if (!state || state.outcome === 'pending' || state.outcome === 'ready' || state.outcome === 'running') {
        return {
          gate,
          nodeId: owner.id,
          state: 'pending' as const,
          deterministic,
          detail: `${owner.name} has not finished.`
        };
      }

      if (state.outcome === 'failed' || state.outcome === 'cancelled' || state.outcome === 'skipped') {
        return {
          gate,
          nodeId: owner.id,
          state: 'failed' as const,
          deterministic,
          detail: `${owner.name} ${state.outcome}.`
        };
      }

      if (state.outcome === 'succeeded') {
        const conditions: GateThresholdCondition[] = [
          ...(policy?.gateThresholds?.[gate] ?? []),
          ...(approval.gateThresholds?.[gate] ?? []),
          ...((owner as any).gateThresholds ?? [])
        ];

        const rawFindings = state.findings?.findings ?? [];
        const { activeFindings, waivedFindings } = filterUnwaivedFindings(
          rawFindings,
          waivers,
          new Date(),
          currentSnapshotRef
        );

        for (const cond of conditions) {
          if (cond.type === 'metric') {
            const actual = state.findings?.metrics?.[cond.metric];
            let passed = false;
            if (actual !== undefined) {
              switch (cond.operator) {
                case '>=': passed = actual >= cond.value; break;
                case '<=': passed = actual <= cond.value; break;
                case '>': passed = actual > cond.value; break;
                case '<': passed = actual < cond.value; break;
                case '==': passed = actual === cond.value; break;
              }
            }
            if (!passed) {
              return {
                gate,
                nodeId: owner.id,
                state: 'failed' as const,
                deterministic,
                detail: `Metric "${cond.metric}" was ${actual !== undefined ? actual : 'missing'}, required ${cond.operator} ${cond.value}.`
              };
            }
          } else if (cond.type === 'severity') {
            const targetLevel = cond.severityLevel ?? 'high';
            const targetRank = SEVERITY_RANK[targetLevel] ?? 3;
            const count = activeFindings.filter(
              f => (SEVERITY_RANK[f.severity] ?? 0) >= targetRank
            ).length;
            if (count > cond.maxCount) {
              return {
                gate,
                nodeId: owner.id,
                state: 'failed' as const,
                deterministic,
                detail: `Found ${count} finding(s) with severity >= ${targetLevel} (max allowed: ${cond.maxCount}).`
              };
            }
          }
        }

        const waivedNote = waivedFindings.length > 0 ? ` (${waivedFindings.length} findings waived)` : '';
        return { gate, nodeId: owner.id, state: 'passed' as const, deterministic, detail: `${owner.name} succeeded${waivedNote}.` };
      }

      return {
        gate,
        nodeId: owner.id,
        state: 'pending' as const,
        deterministic,
        detail: `${owner.name} has not finished.`
      };
    }

    // Multi-owner gate resolution (TASK-243)
    const enabledOwners = owners.filter(o => o.enabled !== false && run.nodes[o.id]?.outcome !== 'skipped');
    const disabledOwners = owners.filter(o => o.enabled === false || run.nodes[o.id]?.outcome === 'skipped');
    const deterministic = owners.every(o => o.type === 'check' || o.type === 'deployment');

    if (enabledOwners.length === 0) {
      return {
        gate,
        state: 'failed' as const,
        deterministic,
        detail: `All scanners for gate "${gate}" are disabled.`
      };
    }

    const failedOwners = enabledOwners.filter(o => {
      const st = run.nodes[o.id];
      return st?.outcome === 'failed' || st?.outcome === 'cancelled';
    });
    if (failedOwners.length > 0) {
      return {
        gate,
        state: 'failed' as const,
        deterministic,
        detail: `${failedOwners.map(o => `${o.name} ${run.nodes[o.id]?.outcome ?? 'failed'}`).join('; ')}.`
      };
    }

    const pendingOwners = enabledOwners.filter(o => {
      const st = run.nodes[o.id];
      return !st || st.outcome === 'pending' || st.outcome === 'ready' || st.outcome === 'running';
    });
    if (pendingOwners.length > 0) {
      return {
        gate,
        state: 'pending' as const,
        deterministic,
        detail: `${pendingOwners.map(o => o.name).join(', ')} has not finished.`
      };
    }

    // All enabled owners succeeded! Combine findings & metrics
    const combinedFindings = enabledOwners.flatMap(o => run.nodes[o.id]?.findings?.findings ?? []);
    const combinedMetrics: Record<string, number> = Object.assign(
      {},
      ...enabledOwners.map(o => run.nodes[o.id]?.findings?.metrics ?? {})
    );

    const { activeFindings, waivedFindings } = filterUnwaivedFindings(
      combinedFindings,
      waivers,
      new Date(),
      currentSnapshotRef
    );

    const conditions: GateThresholdCondition[] = [
      ...(policy?.gateThresholds?.[gate] ?? []),
      ...(approval.gateThresholds?.[gate] ?? [])
    ];

    for (const cond of conditions) {
      if (cond.type === 'metric') {
        const actual = combinedMetrics[cond.metric];
        let passed = false;
        if (actual !== undefined) {
          switch (cond.operator) {
            case '>=': passed = actual >= cond.value; break;
            case '<=': passed = actual <= cond.value; break;
            case '>': passed = actual > cond.value; break;
            case '<': passed = actual < cond.value; break;
            case '==': passed = actual === cond.value; break;
          }
        }
        if (!passed) {
          return {
            gate,
            state: 'failed' as const,
            deterministic,
            detail: `Metric "${cond.metric}" was ${actual !== undefined ? actual : 'missing'}, required ${cond.operator} ${cond.value}.`
          };
        }
      } else if (cond.type === 'severity') {
        const targetLevel = cond.severityLevel ?? 'high';
        const targetRank = SEVERITY_RANK[targetLevel] ?? 3;
        const count = activeFindings.filter(
          f => (SEVERITY_RANK[f.severity] ?? 0) >= targetRank
        ).length;
        if (count > cond.maxCount) {
          return {
            gate,
            state: 'failed' as const,
            deterministic,
            detail: `Found ${count} finding(s) with severity >= ${targetLevel} across scanners (max allowed: ${cond.maxCount}).`
          };
        }
      }
    }

    const disabledText = disabledOwners.length > 0 ? ` (${disabledOwners.map(o => `${o.name} disabled`).join(', ')})` : '';
    const waivedText = waivedFindings.length > 0 ? `, ${waivedFindings.length} waived` : '';
    return {
      gate,
      state: 'passed' as const,
      deterministic,
      detail: `Scanners passed: ${enabledOwners.map(o => o.name).join(', ')}${disabledText} (${activeFindings.length} findings${waivedText}).`
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
