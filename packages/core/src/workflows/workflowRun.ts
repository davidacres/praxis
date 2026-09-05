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
  isTerminalOutcome,
  nodeOutputs,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowArtifactRef,
  type WorkflowDefinition,
  type WorkflowGateDecision,
  type WorkflowNode,
  type WorkflowNodeOutcome
} from './workflowTypes';

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
  | 'node-interrupted'
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
}

// ── Commands ─────────────────────────────────────────────────────────────

export type WorkflowRunCommand =
  | { kind: 'node-started'; nodeId: string; at: string; sessionId?: string }
  | {
      kind: 'node-succeeded';
      nodeId: string;
      at: string;
      artifacts?: Array<Pick<WorkflowArtifactRef, 'contractId' | 'kind'> & { path?: string; artifactId?: string }>;
      exitCode?: number;
      /** Commit or worktree ref this stage froze, for downstream inspection. */
      snapshotRef?: string;
    }
  | { kind: 'node-failed'; nodeId: string; at: string; error: string; exitCode?: number }
  | { kind: 'node-timed-out'; nodeId: string; at: string }
  | { kind: 'node-skipped'; nodeId: string; at: string; reason: string }
  | { kind: 'node-retry'; nodeId: string; at: string }
  | { kind: 'node-interrupted'; nodeId: string; at: string }
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
    ...(input.issueConnectionId ? { issueConnectionId: input.issueConnectionId } : {})
  };

  return append(run, { at: input.at, kind: 'run-started', message: `Run started for ${input.definition.name}.` });
}

/**
 * Applies one command. Returns the same run object when the command is a
 * no-op, so callers can cheaply tell whether anything changed — and so a
 * replayed command cannot append a second event.
 */
export function applyWorkflowRunCommand(run: WorkflowRun, command: WorkflowRunCommand): WorkflowRun {
  // A settled run absorbs nothing further. Recovery may replay commands that
  // raced the run ending; they must not resurrect it.
  if (isRunSettled(run) && command.kind !== 'gate-decided') return run;

  switch (command.kind) {
    case 'node-started':
      return startNode(run, command);
    case 'node-succeeded':
      return settleNode(run, command.nodeId, 'succeeded', command.at, {
        exitCode: command.exitCode,
        artifacts: command.artifacts,
        snapshotRef: command.snapshotRef
      });
    case 'node-failed':
      return settleNode(run, command.nodeId, 'failed', command.at, {
        error: command.error,
        exitCode: command.exitCode
      });
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
    case 'gate-decided':
      return recordGate(run, command.at, command.decision);
    case 'cancel':
      return cancelRun(run, command.at, command.reason);
  }
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

  const next = withNode(run, { ...state, outcome: 'running', attempts: [...state.attempts, attempt] });
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
    snapshotRef?: string;
    artifacts?: Extract<WorkflowRunCommand, { kind: 'node-succeeded' }>['artifacts'];
  }
): WorkflowRun {
  const state = run.nodes[nodeId];
  if (!state || isTerminalOutcome(state.outcome)) return run;
  if (state.attempts.length === 0) return run; // Never started; nothing to settle.

  const node = findNode(run, nodeId);
  let effective: 'succeeded' | 'failed' = outcome;
  let error = detail.error;
  const artifacts = outcome === 'succeeded' ? toArtifactRefs(run, nodeId, at, detail.artifacts ?? []) : [];

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
  }

  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts[attempts.length - 1],
    outcome: effective,
    endedAt: at,
    ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
    ...(error ? { error } : {})
  };

  let next = withNode(run, {
    ...state,
    outcome: effective,
    attempts,
    artifacts,
    ...(effective === 'succeeded' && detail.snapshotRef ? { snapshotRef: detail.snapshotRef } : {})
  });
  next = append(next, {
    at,
    kind: detail.timedOut ? 'node-timed-out' : effective === 'succeeded' ? 'node-succeeded' : 'node-failed',
    nodeId,
    attempt: attempts.length,
    message:
      effective === 'succeeded'
        ? `${label(run, nodeId)} succeeded.`
        : `${label(run, nodeId)} failed: ${error ?? 'no reason given'}`
  });

  for (const artifact of artifacts) {
    next = append(next, {
      at,
      kind: 'artifact-produced',
      nodeId,
      message: `${label(run, nodeId)} produced ${artifact.kind} "${artifact.contractId}".`
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

  const node = findNode(run, nodeId);
  const maxAttempts = (isAgentTaskNode(node!) || isCheckNode(node!) ? node!.maxAttempts : undefined) ?? 1;
  if (state.attempts.length >= maxAttempts) return run;

  // Returning to pending lets the scheduler pick the node up again under the
  // same readiness rules as the first time — including worktree serialisation.
  const next = withNode(run, { ...state, outcome: 'pending' });
  return append({ ...next, status: 'running', endedAt: undefined, endedReason: undefined }, {
    at,
    kind: 'node-retried',
    nodeId,
    attempt: state.attempts.length,
    message: `${label(run, nodeId)} queued for retry (attempt ${state.attempts.length + 1} of ${maxAttempts}).`
  });
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

  const next = withNode(run, { ...state, outcome: 'failed', attempts });
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
      ? `Gate "${decision.gate}" bypassed by ${decision.bypassedBy ?? 'unknown'}: ${decision.reason ?? 'no reason given'}`
      : `Gate "${decision.gate}" ${decision.passed ? 'passed' : 'failed'}.`
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
    next = withNode(next, { ...state, outcome: 'cancelled', attempts });
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

  const requiredFailure = states.find(
    state => state.outcome === 'failed' && isRequiredNode(run, state.nodeId) && !canRetry(run, state.nodeId)
  );
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
  const maxAttempts = (isAgentTaskNode(node) || isCheckNode(node) ? node.maxAttempts : undefined) ?? 1;
  return state.attempts.length < maxAttempts;
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
      ...(typeof stored?.snapshotRef === 'string' ? { snapshotRef: stored.snapshotRef } : {})
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
    ...(typeof raw.worktreePath === 'string' ? { worktreePath: raw.worktreePath } : {}),
    ...(typeof raw.issueKey === 'string' ? { issueKey: raw.issueKey } : {}),
    ...(typeof raw.issueConnectionId === 'string' ? { issueConnectionId: raw.issueConnectionId } : {}),
    ...(typeof raw.issueWriteBackAt === 'string' ? { issueWriteBackAt: raw.issueWriteBackAt } : {})
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function append(run: WorkflowRun, event: Omit<WorkflowRunEvent, 'id'>): WorkflowRun {
  return { ...run, events: [...run.events, { id: `${run.runId}-${run.events.length}`, ...event }] };
}

function withNode(run: WorkflowRun, state: WorkflowNodeState): WorkflowRun {
  return { ...run, nodes: { ...run.nodes, [state.nodeId]: state } };
}

function findNode(run: WorkflowRun, nodeId: string): WorkflowNode | undefined {
  return run.definition.nodes.find(node => node.id === nodeId);
}

function label(run: WorkflowRun, nodeId: string): string {
  return findNode(run, nodeId)?.name ?? nodeId;
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
      createdAt: at
    }));
}

const OUTCOMES = new Set<WorkflowNodeOutcome>(['pending', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const STATUSES = new Set<WorkflowRunStatus>(['running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled']);

function isOutcome(value: unknown): value is WorkflowNodeOutcome {
  return OUTCOMES.has(value as WorkflowNodeOutcome);
}

function isStatus(value: unknown): value is WorkflowRunStatus {
  return STATUSES.has(value as WorkflowRunStatus);
}
