/**
 * Timeout, cancellation, and restart recovery (FX-BE-019 / TASK-097).
 *
 * The hard requirement is that a completed stage is never done twice. A run is
 * persisted after every transition, so what survives a crash is an accurate
 * record of settled stages plus, at most, one or more attempts that were still
 * in flight. Recovery closes those attempts — it does not resume them.
 *
 * That choice is deliberate. The app cannot know whether an agent session that
 * died mid-stage left the worktree half-written, so it records what it saw,
 * marks the attempt interrupted, and surfaces an explicit retry. Silently
 * re-running would risk duplicating side effects; silently continuing would
 * risk building on a half-finished change.
 */

import { isAgentTaskNode, isCheckNode, isDeploymentNode, isTerminalOutcome } from './workflowTypes';
import {
  applyWorkflowRunCommand,
  attemptsSpent,
  isRunSettled,
  type WorkflowRun
} from './workflowRun';
import { scheduleWorkflowRun } from './workflowScheduler';
import { evaluateGates } from './workflowGates';
import { findSnapshot } from './workflowStageSession';

export interface WorkflowRecoveryResult {
  run: WorkflowRun;
  /** Attempts that were in flight when the app stopped. */
  interrupted: string[];
}

/**
 * Reconciles a run loaded from storage against the fact that the process
 * restarted. Completed nodes are left exactly as they are.
 */
export function recoverWorkflowRun(run: WorkflowRun, at: string): WorkflowRecoveryResult {
  if (isRunSettled(run)) {
    // A run that ended with stages still marked running (an older build let a
    // failed run drop its siblings' results) is repaired rather than left
    // showing spinners on a finished run.
    let repaired = run;
    for (const state of Object.values(run.nodes)) {
      if (state.outcome !== 'running') continue;
      repaired = applyWorkflowRunCommand(repaired, {
        kind: 'node-stopped',
        nodeId: state.nodeId,
        at,
        reason: 'the run had already ended.'
      });
    }
    return { run: repaired, interrupted: [] };
  }

  const interrupted = Object.values(run.nodes)
    .filter(state => state.outcome === 'running')
    .map(state => state.nodeId)
    .sort();

  let next = run;
  for (const nodeId of interrupted) {
    next = applyWorkflowRunCommand(next, { kind: 'node-interrupted', nodeId, at });
  }

  return { run: next, interrupted };
}

/**
 * Nodes whose in-flight attempt has outrun its timeout.
 *
 * Returned rather than applied so the caller decides — the orchestrator kills
 * the underlying session first, then records the timeout.
 */
export function findTimedOutNodes(run: WorkflowRun, now: string): string[] {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return [];

  return Object.values(run.nodes)
    .filter(state => state.outcome === 'running')
    .filter(state => {
      const node = run.definition.nodes.find(candidate => candidate.id === state.nodeId);
      const timeoutMs =
        node && (isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node)) ? node.timeoutMs : undefined;
      if (!timeoutMs) return false;
      const startedAt = Date.parse(state.attempts[state.attempts.length - 1]?.startedAt ?? '');
      return !Number.isNaN(startedAt) && nowMs - startedAt > timeoutMs;
    })
    .map(state => state.nodeId)
    .sort();
}

export type WorkflowNextAction =
  | { kind: 'start-stage'; nodeId: string; label: string }
  | { kind: 'retry-stage'; nodeId: string; label: string; attemptsUsed: number; maxAttempts: number }
  | { kind: 'rework-stage'; nodeId: string; label: string }
  | { kind: 'approve'; nodeId: string; label: string }
  | { kind: 'cancel-run'; label: string }
  | { kind: 'none'; label: string };

/**
 * What a person can actually do with this run right now.
 *
 * Every non-terminal state resolves to at least one concrete action, so a
 * failed, cancelled, or waiting run never presents as a dead end.
 */
export function nextActions(run: WorkflowRun): WorkflowNextAction[] {
  const label = (nodeId: string): string =>
    run.definition.nodes.find(node => node.id === nodeId)?.name ?? nodeId;

  // A failed stage can always be tried again by a person; `maxAttempts` only
  // bounds the run continuing on its own. A failed run is reopened by doing so.
  const retryActions = (): WorkflowNextAction[] =>
    Object.values(run.nodes)
      .filter(state => state.outcome === 'failed')
      .map(state => {
        const node = run.definition.nodes.find(candidate => candidate.id === state.nodeId);
        const maxAttempts =
          (node && (isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node)) ? node.maxAttempts : undefined) ?? 1;
        return {
          kind: 'retry-stage' as const,
          nodeId: state.nodeId,
          label: `Retry ${label(state.nodeId)}`,
          attemptsUsed: attemptsSpent(state),
          maxAttempts
        };
      });

  const reworkActions = (): WorkflowNextAction[] => {
    const reworkSources = new Map<string, { stale: string[]; failed: string[] }>();
    for (const approval of run.definition.nodes.filter(node => node.type === 'approval')) {
      for (const gate of evaluateGates(run, approval.id)) {
        if (!gate.nodeId) continue;
        if (gate.state !== 'stale' && gate.state !== 'failed') continue;
        const source = findSnapshot(run, gate.nodeId)?.producedByNodeId;
        if (!source) continue;
        const current = reworkSources.get(source) ?? { stale: [], failed: [] };
        if (gate.state === 'stale') current.stale.push(gate.gate);
        if (gate.state === 'failed') current.failed.push(gate.gate);
        reworkSources.set(source, current);
      }
    }
    const result: WorkflowNextAction[] = [];
    for (const [nodeId, reasons] of reworkSources) {
      const parts: string[] = [];
      const failedGates = [...new Set(reasons.failed)];
      const staleGates = [...new Set(reasons.stale)];
      if (failedGates.length > 0) parts.push(`${failedGates.join(', ')} failed`);
      if (staleGates.length > 0) parts.push(`${staleGates.join(', ')} stale`);
      result.push({
        kind: 'rework-stage',
        nodeId,
        label: `Start a new revision from ${label(nodeId)} (${parts.join(', ')})`
      });
    }
    return result;
  };

  if (isRunSettled(run)) {
    return [
      { kind: 'none', label: `Run ${run.status}${run.endedReason ? `: ${run.endedReason}` : '.'}` },
      ...(run.status === 'failed' ? retryActions() : []),
      ...(run.status === 'failed' ? reworkActions() : [])
    ];
  }

  const schedule = scheduleWorkflowRun(run);
  const actions: WorkflowNextAction[] = [];

  for (const nodeId of schedule.awaitingApproval) {
    actions.push({ kind: 'approve', nodeId, label: `Approve at ${label(nodeId)}` });
  }
  for (const nodeId of schedule.ready) {
    actions.push({ kind: 'start-stage', nodeId, label: `Start ${label(nodeId)}` });
  }

  actions.push(...retryActions());
  actions.push(...reworkActions());

  if (schedule.running.length > 0 || actions.length > 0) {
    actions.push({ kind: 'cancel-run', label: 'Cancel run' });
    return actions;
  }

  // Nothing runnable and nothing settled: say why, and still offer the exit.
  return [
    { kind: 'none', label: schedule.blocked ?? 'Waiting.' },
    { kind: 'cancel-run', label: 'Cancel run' }
  ];
}

/** Stages left unfinished, for a monitor summary line. */
export function outstandingNodes(run: WorkflowRun): string[] {
  return Object.values(run.nodes)
    .filter(state => !isTerminalOutcome(state.outcome))
    .map(state => state.nodeId)
    .sort();
}
