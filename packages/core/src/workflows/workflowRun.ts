/**
 * Durable workflow run state and event log (FX-BE-019 / TASK-095).
 *
 * A run is a reduced value, not an object with methods: every transition is a
 * pure `(run, command) => run` step that appends to an event log. Two
 * properties fall out of that, and both are load-bearing for recovery:
 *
 * - **Idempotent.** Re-applying a command the run has already absorbed returns
 *   the same run, unchanged, with no duplicate event. Restart recovery replays
 *   whatever it is unsure about; without this it would double-count attempts.
 * - **Observable.** The event log is the whole history, so the renderer can
 *   render a run's past without the orchestrator narrating it separately.
 *
 * A run embeds the definition it started against rather than a reference to
 * one. Editing or deleting a workflow must never rewrite the history of a run
 * already in flight, and a run has to stay recoverable after its definition is
 * gone.
 */

import {
  isAgentTaskNode,
  isCheckNode,
  isDeploymentNode,
  isMergeNode,
  isTerminalOutcome,
  nodeGate,
  nodeMutatesWorktree,
  nodeOutputs,
  WORKFLOW_SCHEMA_VERSION,
  type CheckFindings,
  type WorkflowArtifactRef,
  type WorkflowDefinition,
  type WorkflowGateDecision,
  type WorkflowNode,
  type WorkflowNodeOutcome
} from './workflowTypes';
import type { AiProvider } from '../types';
import { findSnapshot } from './workflowStageSession';
import { providerDisplayName } from '../ai/providers/registry';

/**
 * How a run's stage sessions handle their own tool-permission requests.
 * `ask` (the default) stops the session for Allow / Deny; `auto` allows them.
 * It never widens what a stage may do — each stage's tool access still applies —
 * and it never touches the human approval gate, which needs a person either way.
 */
export type WorkflowPermissionMode = 'ask' | 'auto';

/**
 * What a run does about uncommitted product changes in the checkout it starts from: `include` them
 * via a snapshot commit on the run's branch, or `omit` them and work from the last commit.
 */
export type WorkflowUncommittedChanges = 'include' | 'omit';

/**
 * Why a stage attempt stopped without a verdict, so the run waits for the user
 * instead of failing:
 * - `provider-limit` — the AI provider's credits, quota or rate limit ran out.
 * - `environment` — the tool the stage runs could not do its job (a registry that
 *   does not serve the request, a missing command, no network), as opposed to the
 *   thing it checks being wrong.
 * Either way the stage did not get to judge the work, so the attempt is free.
 */
export type WorkflowPauseReason = 'provider-limit' | 'environment';

/**
 * What a run does when a stage's AI runs out of credits or hits its usage limit:
 * - `ask` (the default) — pause and ask the user to switch AI, retry or stop;
 * - `switch` — move the stage to the next AI that is set up, without asking;
 * - `stop` — end the run, saying which AI ran out and where.
 */
export type WorkflowProviderLimitPolicy = 'ask' | 'switch' | 'stop';

export type WorkflowRunStatus =
  | 'running'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type WorkflowRunEventKind =
  | 'run-started'
  | 'run-succeeded'
  | 'run-failed'
  | 'run-cancelled'
  | 'node-started'
  | 'node-succeeded'
  | 'node-failed'
  | 'node-timed-out'
  | 'node-skipped'
  | 'node-cancelled'
  | 'node-retried'
  | 'node-reworked'
  | 'node-interrupted'
  | 'node-progress'
  | 'node-provider-switched'
  | 'artifact-produced'
  | 'gate-decided';

export interface WorkflowRunEvent {
  /** `<runId>-<sequence>`; the sequence is the log length at append time. */
  id: string;
  at: string;
  kind: WorkflowRunEventKind;
  nodeId?: string;
  attempt?: number;
  message: string;
}

export interface WorkflowNodeAttempt {
  /** 1-based. */
  attempt: number;
  outcome: WorkflowNodeOutcome;
  startedAt: string;
  endedAt?: string;
  /** The agent session backing this attempt, for agent stages. */
  sessionId?: string;
  /** Process exit code, for check stages. */
  exitCode?: number;
  error?: string;
  /**
   * The attempt stopped for a reason that says nothing about the work (see
   * `WorkflowPauseReason`). Such an attempt pauses the stage (`pauseReasonOf`)
   * and does not spend its retry budget.
   */
  pause?: WorkflowPauseReason;
  /** The AI that ran this attempt (a provider id), for agent stages. */
  provider?: string;
}

export interface WorkflowNodeState {
  nodeId: string;
  outcome: WorkflowNodeOutcome;
  attempts: WorkflowNodeAttempt[];
  artifacts: WorkflowArtifactRef[];
  /**
   * The immutable implementation ref this stage produced — a commit sha or
   * worktree ref. Review, QA, and security inspect *this*, not whatever the
   * worktree happens to hold by the time they run.
   */
  snapshotRef?: string;
  /** Immutable upstream implementation snapshot this stage inspected. */
  assessedSnapshotRef?: string;
  /**
   * A free-form sub-phase of the current attempt, reported via the
   * `node-progress` command — e.g. a deployment stage moving from
   * `'deploying'` to `'verifying'` before it settles. Generic to the engine
   * (it does not interpret the string); cleared the moment a node starts a
   * new attempt or settles, so a stale phase can never outlive the attempt
   * that reported it.
   */
  phase?: string;
  findings?: CheckFindings;
}

export interface WorkflowRun {
  schemaVersion: number;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  projectId: string;
  status: WorkflowRunStatus;
  /** The definition snapshot this run executes; never re-read from the store. */
  definition: WorkflowDefinition;
  nodes: Record<string, WorkflowNodeState>;
  events: WorkflowRunEvent[];
  gateDecisions: WorkflowGateDecision[];
  startedAt: string;
  endedAt?: string;
  /** Set when the run ended for a stated reason (cancellation, blocked gate). */
  endedReason?: string;
  /** Session-store key for the user-facing session that controls this run. */
  controllerSessionKey?: string;
  /** Provider/runtime session id of the controller, when available. */
  controllerSessionId?: string;
  /** Explicit plan artifact handed off from Task Designer into this run. */
  planInput?: WorkflowPlanInput;
  /** How stage sessions handle tool-permission prompts. Absent means `ask`. */
  permissionMode?: WorkflowPermissionMode;
  /**
   * The user's answer when the checkout had uncommitted product changes at start. Absent means the
   * checkout had to be clean.
   */
  uncommittedChanges?: WorkflowUncommittedChanges;
  /** AI provider override for stages in this run. If omitted, uses the active provider. */
  aiProvider?: AiProvider;
  /** Model override for stages in this run. If omitted, uses the provider's default model. */
  aiModel?: string;
  /** What happens when a stage's AI runs out of budget. Absent means `ask`. */
  providerLimitPolicy?: WorkflowProviderLimitPolicy;
  /**
   * AIs stages were switched to during this run (node id → provider), after the
   * AI they were using ran out. Wins over the stage's own choice and the run's.
   */
  stageProviders?: Record<string, string>;
  /**
   * Models stages were switched to during this run (node id → model id).
   * Wins over the stage's own choice, mapped tier, and the run's.
   */
  stageModels?: Record<string, string>;
  /** Number of completed automatic recovery repairs per source node. */
  recoveryAttempts?: Record<string, number>;
  /**
   * The git worktree this run's stages execute in, once acquired. Recorded on
   * the run so a restart re-attaches to the same tree instead of branching a
   * second one beside it.
   */
  worktreePath?: string;
  /**
   * The tracker issue this run was started from, if any. A run has no
   * required ticket — workflows are project-scoped automation, not
   * ticket-triggered — so this is opt-in at start time via `createWorkflowRun`.
   * Read by the desktop host (never by this pure state machine) to write the
   * run's outcome back as a comment once it settles.
   */
  issueKey?: string;
  /** The connection `issueKey` lives on; undefined means the demo/default backend. */
  issueConnectionId?: string;
  /**
   * Set once the terminal outcome has been written back to `issueKey` as a
   * comment. An idempotency marker only — set directly by the host after a
   * successful write-back (via `WorkflowRunPersistence.save`), never through a
   * command, and never read by anything in this file.
   */
  issueWriteBackAt?: string;
  /** Whether this run has been archived by the user to tidy the sidebar. */
  archived?: boolean;
  archivedAt?: string;
}

export interface WorkflowPlanInput {
  source: 'task-designer';
  boardId: string;
  outputPath: string;
  generatedFeaturesPath: string;
  fingerprint: string;
  generatedFeatureCount: number;
  generatedStoryCount: number;
}

// ── Commands ─────────────────────────────────────────────────────────────

export type WorkflowRunCommand =
  | { kind: 'node-started'; nodeId: string; at: string; sessionId?: string }
  | {
      kind: 'node-succeeded';
      nodeId: string;
      at: string;
      artifacts?: Array<Pick<WorkflowArtifactRef, 'contractId' | 'kind'> & { path?: string; artifactId?: string; reference?: WorkflowArtifactRef['reference'] }>;
      exitCode?: number;
      /** Commit or worktree ref this stage froze, for downstream inspection. */
      snapshotRef?: string;
      /** Immutable upstream implementation snapshot this stage assessed. */
      assessedSnapshotRef?: string;
      findings?: CheckFindings;
      /** The AI that ran the attempt. */
      provider?: string;
    }
  | {
      kind: 'node-failed';
      nodeId: string;
      at: string;
      error: string;
      exitCode?: number;
      findings?: CheckFindings;
      /** The attempt stopped without a verdict; see `WorkflowNodeAttempt.pause`. */
      pause?: WorkflowPauseReason;
      /** The AI that ran the attempt. */
      provider?: string;
    }
  /**
   * Moves a stage to another AI after the one it used ran out; a paused stage is
   * queued again on it. `automatic` when the run's policy switched without asking.
   */
  | { kind: 'stage-provider-switched'; nodeId: string; at: string; provider: string; model?: string; automatic?: boolean }
  /** Ends the run because a stage's AI ran out of budget (policy `stop`, or the user chose to stop). */
  | { kind: 'provider-limit-stop'; nodeId: string; at: string; detail?: string }
  /**
   * Closes a stage that was still running when its run ended (a sibling of the
   * stage that failed the run, or one orphaned by an earlier build). The only
   * command besides `gate-decided` that a settled run absorbs, because leaving
   * the stage "running" inside a finished run is simply wrong.
   */
  | { kind: 'node-stopped'; nodeId: string; at: string; reason?: string }
  | { kind: 'node-timed-out'; nodeId: string; at: string }
  | { kind: 'node-skipped'; nodeId: string; at: string; reason: string }
  | { kind: 'node-retry'; nodeId: string; at: string }
  | { kind: 'node-interrupted'; nodeId: string; at: string }
  /** Reports a sub-phase of an in-flight attempt; see `WorkflowNodeState.phase`. */
  | { kind: 'node-progress'; nodeId: string; at: string; phase: string; message?: string }
  | { kind: 'gate-decided'; at: string; decision: WorkflowGateDecision }
  | { kind: 'cancel'; at: string; reason?: string };

/** Creates a run pinned to a definition snapshot, with every node pending. */
export function createWorkflowRun(input: {
  runId: string;
  projectId: string;
  definition: WorkflowDefinition;
  at: string;
  /** The ticket this run was started from, if any — see `WorkflowRun.issueKey`. */
  issueKey?: string;
  issueConnectionId?: string;
  controllerSessionKey?: string;
  controllerSessionId?: string;
  planInput?: WorkflowPlanInput;
  permissionMode?: WorkflowPermissionMode;
  uncommittedChanges?: WorkflowUncommittedChanges;
  aiProvider?: AiProvider;
  aiModel?: string;
  providerLimitPolicy?: WorkflowProviderLimitPolicy;
}): WorkflowRun {
  const nodes: Record<string, WorkflowNodeState> = {};
  for (const node of input.definition.nodes) {
    nodes[node.id] = { nodeId: node.id, outcome: 'pending', attempts: [], artifacts: [] };
  }

  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    runId: input.runId,
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    projectId: input.projectId,
    status: 'running',
    definition: JSON.parse(JSON.stringify(input.definition)) as WorkflowDefinition,
    nodes,
    events: [],
    gateDecisions: [],
    startedAt: input.at,
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    ...(input.issueConnectionId ? { issueConnectionId: input.issueConnectionId } : {}),
    ...(input.controllerSessionKey ? { controllerSessionKey: input.controllerSessionKey } : {}),
    ...(input.controllerSessionId ? { controllerSessionId: input.controllerSessionId } : {}),
    ...(input.planInput ? { planInput: input.planInput } : {}),
    ...(input.permissionMode === 'auto' ? { permissionMode: 'auto' as const } : {}),
    ...(input.uncommittedChanges ? { uncommittedChanges: input.uncommittedChanges } : {}),
    ...(input.aiProvider ? { aiProvider: input.aiProvider } : {}),
    ...(input.aiModel ? { aiModel: input.aiModel } : {}),
    ...(input.providerLimitPolicy && input.providerLimitPolicy !== 'ask' ? { providerLimitPolicy: input.providerLimitPolicy } : {})
  };

  return append(run, {
    at: input.at,
    kind: 'run-started',
    message:
      input.permissionMode === 'auto'
        ? `Run started for ${input.definition.name} (stage tool permissions are auto-approved).`
        : `Run started for ${input.definition.name}.`
  });
}

/**
 * Applies one command. Returns the same run object when the command is a
 * no-op, so callers can cheaply tell whether anything changed — and so a
 * replayed command cannot append a second event.
 */
export function applyWorkflowRunCommand(run: WorkflowRun, command: WorkflowRunCommand): WorkflowRun {
  // A settled run absorbs nothing further. Recovery may replay commands that
  // raced the run ending; they must not resurrect it. The one deliberate
  // exception is a person retrying a stage of a *failed* run: that reopens it.
  // A cancelled run stays cancelled, and a succeeded one has nothing to retry.
  const reopensFailedRun = (command.kind === 'node-retry' || command.kind === 'stage-provider-switched') && run.status === 'failed';
  if (isRunSettled(run) && command.kind !== 'gate-decided' && command.kind !== 'node-stopped' && !reopensFailedRun) {
    return run;
  }

  switch (command.kind) {
    case 'node-started':
      return startNode(run, command);
    case 'node-succeeded':
      return settleNode(run, command.nodeId, 'succeeded', command.at, {
        exitCode: command.exitCode,
        artifacts: command.artifacts,
        snapshotRef: command.snapshotRef,
        assessedSnapshotRef: command.assessedSnapshotRef,
        findings: command.findings,
        provider: command.provider
      });
    case 'node-failed':
      return settleNode(run, command.nodeId, 'failed', command.at, {
        error: command.error,
        exitCode: command.exitCode,
        findings: command.findings,
        pause: command.pause,
        provider: command.provider
      });
    case 'stage-provider-switched':
      return switchStageProvider(run, command.nodeId, command.at, command.provider, command.model, command.automatic === true);
    case 'provider-limit-stop':
      return stopForProviderLimit(run, command.nodeId, command.at, command.detail);
    case 'node-stopped':
      return stopNode(run, command.nodeId, command.at, command.reason);
    case 'node-timed-out':
      return settleNode(run, command.nodeId, 'failed', command.at, {
        error: 'Stage exceeded its timeout.',
        timedOut: true
      });
    case 'node-skipped':
      return skipNode(run, command.nodeId, command.at, command.reason);
    case 'node-retry':
      return retryNode(run, command.nodeId, command.at);
    case 'node-interrupted':
      return interruptNode(run, command.nodeId, command.at);
    case 'node-progress':
      return progressNode(run, command.nodeId, command.at, command.phase, command.message);
    case 'gate-decided':
      return recordGate(run, command.at, command.decision);
    case 'cancel':
      return cancelRun(run, command.at, command.reason);
  }
}

export interface WorkflowReworkResult {
  run: WorkflowRun;
  /** The source plus every downstream stage returned to pending. */
  requeued: string[];
  reason?: string;
}

/**
 * Starts a new delivery revision without adding a cycle to the workflow graph.
 *
 * The selected stage is rerun and its downstream work is cleared for a new
 * attempt. Earlier attempts and timeline events stay intact, while obsolete
 * artifacts, snapshots, findings, and gate decisions are removed from active
 * state so no reviewer can accidentally approve a newer change with old proof.
 */
export function reworkWorkflowRun(
  run: WorkflowRun,
  nodeId: string,
  at: string,
  options: { rerunSource?: boolean; resetNodeIds?: string[] } = {}
): WorkflowReworkResult {
  const source = findNode(run, nodeId);
  if (!source) return { run, requeued: [], reason: `Stage "${nodeId}" was not found.` };

  const affected = downstreamNodeIds(run, nodeId);
  if (options.rerunSource === false) affected.delete(nodeId);
  for (const resetNodeId of options.resetNodeIds ?? []) {
    for (const affectedNodeId of downstreamNodeIds(run, resetNodeId)) affected.add(affectedNodeId);
  }
  if ([...affected].some(id => run.nodes[id]?.outcome === 'running')) {
    return { run, requeued: [], reason: 'Stop the in-progress downstream stage before starting rework.' };
  }

  const nodes = { ...run.nodes };
  for (const id of affected) {
    const state = nodes[id];
    if (!state) continue;
    nodes[id] = {
      nodeId: state.nodeId,
      outcome: 'pending',
      attempts: state.attempts,
      artifacts: []
    };
  }

  const affectedGates = new Set(
    run.definition.nodes
      .filter(node => affected.has(node.id))
      .map(nodeGate)
      .filter((gate): gate is NonNullable<typeof gate> => !!gate)
  );
  const next: WorkflowRun = {
    ...withoutIssueWriteBack(run),
    status: 'running',
    endedAt: undefined,
    endedReason: undefined,
    nodes,
    gateDecisions: run.gateDecisions.filter(decision => !affected.has(decision.nodeId) && !affectedGates.has(decision.gate))
  };
  const requeued = [...affected];
  return {
    run: append(next, {
      at,
      kind: 'node-reworked',
      nodeId,
      message: `${label(run, nodeId)} opened a new delivery revision; requeued ${requeued.map(id => label(run, id)).join(', ')}.`
    }),
    requeued
  };
}

// ── Transitions ──────────────────────────────────────────────────────────

function startNode(
  run: WorkflowRun,
  command: Extract<WorkflowRunCommand, { kind: 'node-started' }>
): WorkflowRun {
  const state = run.nodes[command.nodeId];
  if (!state) return run;
  // Already running, or already settled: replaying must not open an attempt.
  if (state.outcome === 'running' || isTerminalOutcome(state.outcome)) return run;

  const attempt: WorkflowNodeAttempt = {
    attempt: state.attempts.length + 1,
    outcome: 'running',
    startedAt: command.at,
    ...(command.sessionId ? { sessionId: command.sessionId } : {})
  };

  // A fresh attempt starts with no phase — whatever the previous attempt
  // reported (if this is a retry) must not leak into the new one's status.
  const next = withNode(run, { ...clearPhase(state), outcome: 'running', attempts: [...state.attempts, attempt] });
  return append(next, {
    at: command.at,
    kind: 'node-started',
    nodeId: command.nodeId,
    attempt: attempt.attempt,
    message: `${label(run, command.nodeId)} started (attempt ${attempt.attempt}).`
  });
}

function settleNode(
  run: WorkflowRun,
  nodeId: string,
  outcome: 'succeeded' | 'failed',
  at: string,
  detail: {
    error?: string;
    exitCode?: number;
    timedOut?: boolean;
    pause?: WorkflowPauseReason;
    snapshotRef?: string;
    assessedSnapshotRef?: string;
    artifacts?: Extract<WorkflowRunCommand, { kind: 'node-succeeded' }>['artifacts'];
    findings?: CheckFindings;
    provider?: string;
  }
): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || isTerminalOutcome(state.outcome)) return run;
  if (state.attempts.length === 0) return run; // Never started; nothing to settle.

  const node = findNode(run, nodeId);
  let effective: 'succeeded' | 'failed' = outcome;
  let error = detail.error;
  const artifacts = outcome === 'succeeded' ? toArtifactRefs(run, nodeId, at, detail.artifacts ?? []) : [];
  // A verification stage assesses the immutable snapshot that was available
  // when it settled. Persist this even for direct/manual command callers so
  // gate freshness is a property of the run record, not one dispatcher.
  const assessedSnapshotRef =
    effective === 'succeeded' && node && !nodeMutatesWorktree(node)
      ? detail.assessedSnapshotRef ?? findSnapshot(run, nodeId)?.ref
      : undefined;

  // A stage that did not produce what it declared has not succeeded, whatever
  // it reported. This is the check that keeps "review passed" from being prose.
  if (outcome === 'succeeded' && node) {
    const missing = nodeOutputs(node)
      .filter(contract => contract.required)
      .filter(contract => !artifacts.some(artifact => artifact.contractId === contract.id))
      .map(contract => contract.id);
    if (missing.length > 0) {
      effective = 'failed';
      error = `Stage did not produce required artifacts: ${missing.join(', ')}.`;
    }

    const hasRequiredFindings = nodeOutputs(node).some(
      contract => contract.required && contract.kind === 'findings'
    );
    if (hasRequiredFindings && !detail.findings) {
      effective = 'failed';
      error = error ?? 'Stage declared required findings artifact but produced no structured findings.';
    }
  }

  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts[attempts.length - 1],
    outcome: effective,
    endedAt: at,
    ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
    ...(error ? { error } : {}),
    ...(effective === 'failed' && detail.pause ? { pause: detail.pause } : {}),
    ...(detail.provider ? { provider: detail.provider } : {})
  };

  let next = withNode(run, {
    // A settled node reports no phase — its outcome is the whole story now.
    ...clearPhase(state),
    outcome: effective,
    attempts,
    artifacts,
    ...(effective === 'succeeded' && detail.snapshotRef ? { snapshotRef: detail.snapshotRef } : {}),
    ...(assessedSnapshotRef ? { assessedSnapshotRef } : {}),
    ...(detail.findings ? { findings: detail.findings } : {})
  });
  next = append(next, {
    at,
    kind: detail.timedOut ? 'node-timed-out' : effective === 'succeeded' ? 'node-succeeded' : 'node-failed',
    nodeId,
    attempt: attempts.length,
    message:
      effective === 'succeeded'
        ? `${label(run, nodeId)} succeeded.`
        : detail.pause === 'provider-limit'
          ? `${label(run, nodeId)} paused: ${detail.provider ? providerDisplayName(detail.provider) : 'the AI provider'} ran out of credits or hit its usage limit. Switch to another AI, or restore them and retry — this did not use an attempt.`
          : detail.pause === 'environment'
            ? `${label(run, nodeId)} paused: it could not run in this environment (${firstLine(error ?? 'no detail')}). Fix that, then retry — this did not use an attempt.`
            : `${label(run, nodeId)} failed: ${error ?? 'no reason given'}`
  });

  for (const artifact of artifacts) {
    next = append(next, {
      at,
      kind: 'artifact-produced',
      nodeId,
      message: artifact.reference
        ? `${label(run, nodeId)} created ${artifact.kind} ${artifact.reference.key} on the board: ${artifact.reference.title} (${artifact.reference.itemKeys.length} ${artifact.reference.itemKeys.length === 1 ? 'item' : 'items'}).`
        : `${label(run, nodeId)} produced ${artifact.kind} "${artifact.contractId}".`
    });
  }

  return settleRunIfDone(next, at);
}

function skipNode(run: WorkflowRun, nodeId: string, at: string, reason: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || state.outcome !== 'pending') return run;
  const next = withNode(run, { ...state, outcome: 'skipped' });
  return settleRunIfDone(
    append(next, { at, kind: 'node-skipped', nodeId, message: `${label(run, nodeId)} skipped: ${reason}` }),
    at
  );
}

/**
 * Reopens a failed node for another attempt.
 *
 * Bounded by the node's own `maxAttempts`; the policy cap is enforced at
 * validation time, so by the time a run exists the node's number is the
 * authority.
 */
function retryNode(run: WorkflowRun, nodeId: string, at: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || state.outcome !== 'failed') return run;

  // `maxAttempts` bounds how far the run keeps going on its own (see `canRetry`);
  // it does not stop a person deciding to try again. A failed run is reopened.
  const maxAttempts =
    (isAgentTaskNode(findNode(run, nodeId)!) || isCheckNode(findNode(run, nodeId)!) || isDeploymentNode(findNode(run, nodeId)!) || isMergeNode(findNode(run, nodeId)!)
      ? (findNode(run, nodeId) as { maxAttempts?: number }).maxAttempts
      : undefined) ?? 1;
  const spent = attemptsSpent(state);
  let base = run;
  if (isRunSettled(run)) {
    base = withoutIssueWriteBack(run);
    // Siblings stopped because this failure ended the run were interrupted, not
    // judged, so they go back in the queue with it.
    for (const other of Object.values(run.nodes)) {
      if (other.outcome === 'cancelled') base = withNode(base, { ...other, outcome: 'pending' });
    }
  }

  // Returning to pending lets the scheduler pick the node up again under the
  // same readiness rules as the first time — including worktree serialisation.
  const next = withNode(base, { ...base.nodes[nodeId], outcome: 'pending' });
  return append({ ...next, status: 'running', endedAt: undefined, endedReason: undefined }, {
    at,
    kind: 'node-retried',
    nodeId,
    attempt: state.attempts.length,
    message: `${label(run, nodeId)} queued for retry (attempt ${spent + 1}${spent < maxAttempts ? ` of ${maxAttempts}` : ''}).`
  });
}

function withoutIssueWriteBack(run: WorkflowRun): WorkflowRun {
  const { issueWriteBackAt: _issueWriteBackAt, ...withoutMarker } = run;
  return withoutMarker;
}

function switchStageProvider(run: WorkflowRun, nodeId: string, at: string, provider: string, model?: string, automatic?: boolean): WorkflowRun {
  const state = run.nodes[nodeId];
  const node = findNode(run, nodeId);
  if (!state || !node || !isAgentTaskNode(node) || !provider.trim()) return run;
  const from = state.attempts[state.attempts.length - 1]?.provider;
  const stageProviders = { ...(run.stageProviders ?? {}), [nodeId]: provider };
  const stageModels = { ...(run.stageModels ?? {}) };
  if (model?.trim()) {
    stageModels[nodeId] = model.trim();
  } else {
    delete stageModels[nodeId];
  }
  let next = append(
    {
      ...run,
      stageProviders,
      ...(Object.keys(stageModels).length > 0 ? { stageModels } : { stageModels: undefined })
    },
    {
      at,
      kind: 'node-provider-switched',
      nodeId,
      message: `${label(run, nodeId)} switched ${from ? `from ${providerDisplayName(from)} ` : ''}to ${providerDisplayName(provider)}${
        automatic ? ' automatically' : ''
      }${from && pauseReasonOf(state) === 'provider-limit' ? ` after ${providerDisplayName(from)} ran out` : ''}${
        model?.trim() ? ` (${model.trim()})` : ''
      }.`
    }
  );
  // A stage waiting on the AI that ran out goes again, now on the new one.
  if (isPausedNode(state)) next = retryNode(next, nodeId, at);
  return next;
}

function stopForProviderLimit(run: WorkflowRun, nodeId: string, at: string, detail?: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || pauseReasonOf(state) !== 'provider-limit') return run;
  const provider = state.attempts[state.attempts.length - 1]?.provider;
  const reason = `The run could not be completed: ${provider ? providerDisplayName(provider) : 'the AI provider'} ran out of credits or hit its usage limit at ${label(run, nodeId)}${detail ? ` (${detail})` : ''}.`;
  return append(
    { ...run, status: 'failed', endedAt: at, endedReason: reason },
    { at, kind: 'run-failed', nodeId, message: reason }
  );
}

/** The AIs that ran out of budget during this run, from its paused attempts. */
export function exhaustedProviders(run: WorkflowRun): string[] {
  const found = new Set<string>();
  for (const state of Object.values(run.nodes)) {
    for (const attempt of state.attempts) {
      if (attempt.pause === 'provider-limit' && attempt.provider) found.add(attempt.provider);
    }
  }
  return [...found];
}

/**
 * The AI a stage runs on: an AI it was switched to during the run, else the
 * stage's own choice, else the run's, else `fallback` (the selected AI).
 */
export function stageProvider(run: WorkflowRun, nodeId: string, fallback: string): string {
  const node = findNode(run, nodeId);
  const own = node && isAgentTaskNode(node) ? node.agent.providerId?.trim() : undefined;
  return run.stageProviders?.[nodeId] ?? (own || undefined) ?? run.aiProvider ?? fallback;
}

/**
 * The model a stage was switched to during this run, if any.
 */
export function stageModel(run: WorkflowRun, nodeId: string): string | undefined {
  return run.stageModels?.[nodeId];
}

/**
 * Marks an attempt that was in flight when the process died.
 *
 * The attempt is closed as failed rather than resumed: the app cannot know
 * whether an agent session half-wrote the worktree, so it records what it
 * saw and lets recovery offer an explicit retry.
 */
function interruptNode(run: WorkflowRun, nodeId: string, at: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || state.outcome !== 'running') return run;

  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts[attempts.length - 1],
    outcome: 'failed',
    endedAt: at,
    error: 'Interrupted — the app stopped while this stage was running.'
  };

  const next = withNode(run, { ...clearPhase(state), outcome: 'failed', attempts });
  return settleRunIfDone(
    append(next, {
      at,
      kind: 'node-interrupted',
      nodeId,
      attempt: attempts.length,
      message: `${label(run, nodeId)} was interrupted by an app restart.`
    }),
    at
  );
}

/**
 * Records a sub-phase of the attempt currently running — e.g. a deployment
 * stage moving from `'deploying'` to `'verifying'`.
 *
 * Only valid while the node is actually running: a phase reported for a node
 * that has not started, or has already settled, is silently dropped rather
 * than resurrecting or pre-empting a state the node itself has not reached.
 * Idempotent for the same phase, so a caller that re-reports the phase it
 * already announced (recovery replay, a retried notification) does not
 * double-log an event.
 */
function progressNode(run: WorkflowRun, nodeId: string, at: string, phase: string, message?: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || state.outcome !== 'running') return run;
  const eventMessage = message?.trim() || `${label(run, nodeId)} entered phase "${phase}".`;
  const previous = run.events[run.events.length - 1];
  if (state.phase === phase && previous?.kind === 'node-progress' && previous.message === eventMessage) return run;

  const next = withNode(run, { ...state, phase });
  return append(next, {
    at,
    kind: 'node-progress',
    nodeId,
    attempt: state.attempts.length,
    message: eventMessage
  });
}

function recordGate(run: WorkflowRun, at: string, decision: WorkflowGateDecision): WorkflowRun {
  // One decision per gate per node; a replay must not double-log an approval.
  const exists = run.gateDecisions.some(
    candidate => candidate.gate === decision.gate && candidate.nodeId === decision.nodeId
  );
  if (exists) return run;

  const next = { ...run, gateDecisions: [...run.gateDecisions, decision] };
  return append(next, {
    at,
    kind: 'gate-decided',
    nodeId: decision.nodeId,
    message: decision.bypassed
      ? `Gate "${decision.gate}" bypassed by ${decision.bypassedBy ?? 'unknown'}: ${decision.reason ?? 'no reason given'}${decision.assessedSnapshotRef ? ` (snapshot ${decision.assessedSnapshotRef}).` : ''}`
      : `Gate "${decision.gate}" ${decision.passed ? 'passed' : 'failed'}${decision.assessedSnapshotRef ? ` (snapshot ${decision.assessedSnapshotRef})` : ''}.`
  });
}

function cancelRun(run: WorkflowRun, at: string, reason?: string): WorkflowRun {
  let next = run;
  for (const [nodeId, state] of Object.entries(run.nodes)) {
    if (isTerminalOutcome(state.outcome)) continue;
    const attempts = [...state.attempts];
    if (state.outcome === 'running' && attempts.length > 0) {
      attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], outcome: 'cancelled', endedAt: at };
    }
    next = withNode(next, { ...clearPhase(state), outcome: 'cancelled', attempts });
    next = append(next, { at, kind: 'node-cancelled', nodeId, message: `${label(run, nodeId)} cancelled.` });
  }

  return append(
    { ...next, status: 'cancelled', endedAt: at, ...(reason ? { endedReason: reason } : {}) },
    { at, kind: 'run-cancelled', message: `Run cancelled${reason ? `: ${reason}` : '.'}` }
  );
}

// ── Derivation ───────────────────────────────────────────────────────────

export function isRunSettled(run: WorkflowRun): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
}

/**
 * Closes the run when nothing can still move.
 *
 * A run fails when a *required* node has failed — an advisory branch failing
 * leaves delivery alive but is still visible in the log.
 */
function settleRunIfDone(run: WorkflowRun, at: string): WorkflowRun {
  const states = Object.values(run.nodes);

  // A paused stage is waiting on the user, not finished: settling here would
  // fail the run, release its worktree and write a "failed" comment to the
  // ticket for something a top-up or a registry fix resolves.
  if (states.some(state => isPausedNode(state))) return run;

  const requiredFailure = states.find(state => {
    if (state.outcome !== 'failed') return false;
    if (!isRequiredNode(run, state.nodeId)) return false;
    if (canRetry(run, state.nodeId)) return false;

    const hasOutboundFailurePath = run.definition.edges.some(
      edge => edge.from === state.nodeId && (edge.on === 'failure' || edge.on === 'always')
    );
    if (hasOutboundFailurePath) {
      const targets = run.definition.edges
        .filter(edge => edge.from === state.nodeId && (edge.on === 'failure' || edge.on === 'always'))
        .map(edge => edge.to);
      const targetsSettled = targets.every(tid => {
        const st = run.nodes[tid];
        return st && isTerminalOutcome(st.outcome);
      });
      if (!targetsSettled) return false;
    }
    return true;
  });
  if (requiredFailure) {
    return append(
      { ...run, status: 'failed', endedAt: at, endedReason: `Required stage "${requiredFailure.nodeId}" failed.` },
      { at, kind: 'run-failed', nodeId: requiredFailure.nodeId, message: `Run failed at ${label(run, requiredFailure.nodeId)}.` }
    );
  }

  if (states.every(state => isTerminalOutcome(state.outcome))) {
    const succeeded = states.some(state => state.outcome === 'succeeded');
    return append(
      { ...run, status: succeeded ? 'succeeded' : 'failed', endedAt: at },
      { at, kind: succeeded ? 'run-succeeded' : 'run-failed', message: succeeded ? 'Run completed.' : 'Run ended without a successful stage.' }
    );
  }

  return run;
}

/** Whether a failed node may still be retried under its own attempt budget. */
export function canRetry(run: WorkflowRun, nodeId: string): boolean {
  const state = run.nodes[nodeId];
  const node = findNode(run, nodeId);
  if (!state || !node || state.outcome !== 'failed') return false;
  const maxAttempts =
    (isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) || isMergeNode(node) ? node.maxAttempts : undefined) ?? 1;
  return attemptsSpent(state) < maxAttempts;
}

/**
 * Attempts counted against a node's `maxAttempts`. An attempt cut short by the
 * AI provider's limit is the environment's failure, not the stage's, so it is
 * free — otherwise one empty account would leave a `maxAttempts: 1` stage with
 * no retry and no way to continue the run.
 */
export function attemptsSpent(state: Pick<WorkflowNodeState, 'attempts'>): number {
  return state.attempts.filter(attempt => !attempt.pause).length;
}

/** Why a failed node is waiting on the user rather than failed, if it is. */
export function pauseReasonOf(state: Pick<WorkflowNodeState, 'outcome' | 'attempts'>): WorkflowPauseReason | undefined {
  return state.outcome === 'failed' ? state.attempts[state.attempts.length - 1]?.pause : undefined;
}

/** A failed node whose latest attempt stopped without a verdict (provider limit or environment). */
export function isPausedNode(state: Pick<WorkflowNodeState, 'outcome' | 'attempts'>): boolean {
  return pauseReasonOf(state) !== undefined;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/** Closes a stage left "running" inside a run that has already ended. */
function stopNode(run: WorkflowRun, nodeId: string, at: string, reason?: string): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || state.outcome !== 'running') return run;
  const attempts = [...state.attempts];
  if (attempts.length > 0) {
    attempts[attempts.length - 1] = {
      ...attempts[attempts.length - 1],
      outcome: 'cancelled',
      endedAt: at,
      error: reason ?? 'Stopped: the run ended before this stage finished.'
    };
  }
  return append(withNode(run, { ...clearPhase(state), outcome: 'cancelled', attempts }), {
    at,
    kind: 'node-cancelled',
    nodeId,
    message: `${label(run, nodeId)} stopped: ${reason ?? 'the run ended before it finished.'}`
  });
}

/**
 * Whether the run depends on this node. A node reached only by non-required
 * edges is advisory: its failure is recorded but does not sink the run.
 */
function isRequiredNode(run: WorkflowRun, nodeId: string): boolean {
  if (nodeId === run.definition.entryNodeId) return true;
  const inbound = run.definition.edges.filter(edge => edge.to === nodeId);
  return inbound.length === 0 || inbound.some(edge => edge.required);
}

// ── Normalization ────────────────────────────────────────────────────────

/**
 * Repairs a run record read back from disk.
 *
 * History is preserved, never rebuilt: a run whose node set no longer matches
 * its definition keeps both, because the definition snapshot is the authority
 * for what should exist and the recorded attempts are the authority for what
 * happened.
 */
export function normalizeWorkflowRun(value: unknown): WorkflowRun | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || !raw.runId) return undefined;
  if (!raw.definition || typeof raw.definition !== 'object') return undefined;

  const definition = raw.definition as WorkflowDefinition;
  const nodes: Record<string, WorkflowNodeState> = {};
  const storedNodes = (raw.nodes ?? {}) as Record<string, unknown>;

  for (const node of Array.isArray(definition.nodes) ? definition.nodes : []) {
    const stored = storedNodes[node.id] as Partial<WorkflowNodeState> | undefined;
    nodes[node.id] = {
      nodeId: node.id,
      outcome: isOutcome(stored?.outcome) ? stored.outcome : 'pending',
      attempts: Array.isArray(stored?.attempts) ? stored.attempts : [],
      artifacts: Array.isArray(stored?.artifacts) ? stored.artifacts : [],
      ...(typeof stored?.snapshotRef === 'string' ? { snapshotRef: stored.snapshotRef } : {}),
      ...(typeof stored?.assessedSnapshotRef === 'string' ? { assessedSnapshotRef: stored.assessedSnapshotRef } : {}),
      // A stage's findings are what its gate thresholds are judged on: dropping them on reload
      // would make every severity threshold pass on a run read back from disk.
      ...(isStoredFindings(stored?.findings) ? { findings: stored.findings } : {}),
      // Only meaningful while running; a normalized non-running node simply
      // omits it rather than trusting a stale value from disk.
      ...(typeof stored?.phase === 'string' && isOutcome(stored?.outcome) && stored.outcome === 'running'
        ? { phase: stored.phase }
        : {})
    };
  }

  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : WORKFLOW_SCHEMA_VERSION,
    runId: raw.runId,
    workflowId: typeof raw.workflowId === 'string' ? raw.workflowId : definition.id,
    workflowVersion: typeof raw.workflowVersion === 'number' ? raw.workflowVersion : definition.version,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    status: isStatus(raw.status) ? raw.status : 'running',
    definition,
    nodes,
    events: Array.isArray(raw.events) ? (raw.events as WorkflowRunEvent[]) : [],
    gateDecisions: Array.isArray(raw.gateDecisions) ? (raw.gateDecisions as WorkflowGateDecision[]) : [],
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.endedReason === 'string' ? { endedReason: raw.endedReason } : {}),
    ...(typeof raw.controllerSessionKey === 'string' ? { controllerSessionKey: raw.controllerSessionKey } : {}),
    ...(typeof raw.controllerSessionId === 'string' ? { controllerSessionId: raw.controllerSessionId } : {}),
    ...(raw.planInput && typeof raw.planInput === 'object' ? { planInput: raw.planInput as WorkflowPlanInput } : {}),
    ...(raw.permissionMode === 'auto' ? { permissionMode: 'auto' as const } : {}),
    ...(raw.uncommittedChanges === 'include' || raw.uncommittedChanges === 'omit'
      ? { uncommittedChanges: raw.uncommittedChanges }
      : {}),
    ...(typeof raw.aiProvider === 'string' ? { aiProvider: raw.aiProvider as AiProvider } : {}),
    ...(typeof raw.aiModel === 'string' ? { aiModel: raw.aiModel } : {}),
    ...(raw.providerLimitPolicy === 'switch' || raw.providerLimitPolicy === 'stop' ? { providerLimitPolicy: raw.providerLimitPolicy } : {}),
    ...(raw.stageProviders && typeof raw.stageProviders === 'object' && !Array.isArray(raw.stageProviders)
      ? {
          stageProviders: Object.fromEntries(
            Object.entries(raw.stageProviders as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
          )
        }
      : {}),
    ...(raw.stageModels && typeof raw.stageModels === 'object' && !Array.isArray(raw.stageModels)
      ? {
          stageModels: Object.fromEntries(
            Object.entries(raw.stageModels as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
          )
        }
      : {}),
    ...(raw.recoveryAttempts && typeof raw.recoveryAttempts === 'object' && !Array.isArray(raw.recoveryAttempts)
      ? {
          recoveryAttempts: Object.fromEntries(
            Object.entries(raw.recoveryAttempts as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0)
          )
        }
      : {}),
    ...(typeof raw.worktreePath === 'string' ? { worktreePath: raw.worktreePath } : {}),
    ...(typeof raw.issueKey === 'string' ? { issueKey: raw.issueKey } : {}),
    ...(typeof raw.issueConnectionId === 'string' ? { issueConnectionId: raw.issueConnectionId } : {}),
    ...(typeof raw.issueWriteBackAt === 'string' ? { issueWriteBackAt: raw.issueWriteBackAt } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
    ...(typeof raw.archivedAt === 'string' ? { archivedAt: raw.archivedAt } : {})
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function append(run: WorkflowRun, event: Omit<WorkflowRunEvent, 'id'>): WorkflowRun {
  return { ...run, events: [...run.events, { id: `${run.runId}-${run.events.length}`, ...event }] };
}

function withNode(run: WorkflowRun, state: WorkflowNodeState): WorkflowRun {
  return { ...run, nodes: { ...run.nodes, [state.nodeId]: state } };
}

/**
 * Strips `phase` entirely rather than setting it to `undefined` — an
 * own-property set to `undefined` is not the same value as an absent
 * property to a strict deep-equal, and would make an in-memory run diverge
 * from the exact same run read back from a JSON store (which drops
 * `undefined` values), even though nothing meaningful changed.
 */
function clearPhase(state: WorkflowNodeState): WorkflowNodeState {
  const { phase: _phase, ...rest } = state;
  return rest;
}

function findNode(run: WorkflowRun, nodeId: string): WorkflowNode | undefined {
  return run.definition.nodes.find(node => node.id === nodeId);
}

function label(run: WorkflowRun, nodeId: string): string {
  return findNode(run, nodeId)?.name ?? nodeId;
}

export function downstreamNodeIds(run: WorkflowRun, nodeId: string): Set<string> {
  const outbound = new Map<string, string[]>();
  for (const edge of run.definition.edges) {
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge.to]);
  }
  const affected = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (affected.has(current)) continue;
    affected.add(current);
    pending.push(...(outbound.get(current) ?? []));
  }
  return affected;
}

function toArtifactRefs(
  run: WorkflowRun,
  nodeId: string,
  at: string,
  declared: NonNullable<Extract<WorkflowRunCommand, { kind: 'node-succeeded' }>['artifacts']>
): WorkflowArtifactRef[] {
  const node = findNode(run, nodeId);
  if (!node) return [];
  const contracts = new Set(nodeOutputs(node).map(contract => contract.id));
  return declared
    // An artifact the node never declared is dropped: a stage cannot invent an
    // output slot at run time that downstream inputs were not validated against.
    .filter(artifact => contracts.has(artifact.contractId))
    .map((artifact, index) => ({
      artifactId: artifact.artifactId ?? `${run.runId}-${nodeId}-${index}`,
      contractId: artifact.contractId,
      nodeId,
      runId: run.runId,
      kind: artifact.kind,
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(artifact.reference ? { reference: artifact.reference } : {}),
      createdAt: at
    }));
}

const OUTCOMES = new Set<WorkflowNodeOutcome>(['pending', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const STATUSES = new Set<WorkflowRunStatus>(['running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled']);

function isStoredFindings(value: unknown): value is CheckFindings {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as CheckFindings).findings) &&
    typeof (value as CheckFindings).metrics === 'object' &&
    (value as CheckFindings).metrics !== null
  );
}

function isOutcome(value: unknown): value is WorkflowNodeOutcome {
  return OUTCOMES.has(value as WorkflowNodeOutcome);
}

function isStatus(value: unknown): value is WorkflowRunStatus {
  return STATUSES.has(value as WorkflowRunStatus);
}
