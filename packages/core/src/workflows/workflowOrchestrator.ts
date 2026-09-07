/**
 * Workflow orchestration loop (FX-BE-024 / TASK-111).
 *
 * The impure counterpart to the pure scheduler: on every run transition, work
 * out what may start, start it, apply the outcome, and go round again. The
 * decision logic lives here in core behind injected ports so the properties
 * that actually matter — no double dispatch, no lost work across a crash, no
 * two writers in one worktree — are unit-testable without spawning anything.
 *
 * Three invariants hold the design together:
 *
 * - **The run record is the only state.** The orchestrator keeps an in-flight
 *   set purely to stop a *second launch* racing the first persist; it never
 *   holds knowledge the run does not. Restart therefore needs no orchestrator
 *   state to rebuild.
 * - **Persist before launch.** A stage is marked `running` and saved *before*
 *   its process or session starts. Crash after the save and recovery sees an
 *   interrupted attempt and offers a retry; crash the other way round and a
 *   stage would have run with the record still saying `pending`.
 * - **One step at a time per run.** Steps are serialised on a per-run promise
 *   chain, so two triggers (a stage finishing while recovery re-enters, say)
 *   cannot both read the same run and both dispatch the same ready node.
 */

import {
  isAgentTaskNode,
  isCheckNode,
  type WorkflowAgentTaskNode,
  type WorkflowArtifactKind,
  type WorkflowCheckNode
} from './workflowTypes';
import {
  applyWorkflowRunCommand,
  isRunSettled,
  type WorkflowRun
} from './workflowRun';
import { advanceJoins, scheduleWorkflowRun } from './workflowScheduler';
import { findTimedOutNodes } from './workflowRecovery';

/** What a dispatched stage reports back. */
export interface StageOutcome {
  status: 'succeeded' | 'failed';
  error?: string;
  exitCode?: number;
  /** Commit or worktree ref a mutating stage froze. */
  snapshotRef?: string;
  artifacts?: Array<{ contractId: string; kind: WorkflowArtifactKind; path?: string }>;
}

export interface StageDispatchContext {
  run: WorkflowRun;
  /** Aborted before cancellation waits for stage execution to stop. */
  signal?: AbortSignal;
  /** The run's worktree, when one was acquired. */
  worktreePath?: string;
}

/**
 * How stages actually execute. The desktop app supplies process spawning for
 * checks (TASK-112) and the agent session port for agent stages (FX-BE-025);
 * tests supply fakes.
 */
export interface StageDispatcher {
  /**
   * Whether this dispatcher will actually run the stage. A stage it declines is
   * left `ready` for a person to advance rather than being claimed and failed —
   * which is how agent stages behave until FX-BE-025 lands, and how any stage
   * behaves in a project with no working directory.
   *
   * Consulted *before* the stage is marked running, so declining costs nothing.
   */
  canDispatch?(node: WorkflowCheckNode | WorkflowAgentTaskNode, run: WorkflowRun): boolean;
  runCheck(node: WorkflowCheckNode, context: StageDispatchContext): Promise<StageOutcome>;
  /**
   * Starts an agent stage and resolves when its session ends. `sessionId` is
   * reported synchronously through `onSession` so the run can record it on the
   * attempt before the work begins.
   */
  runAgentStage(
    node: WorkflowAgentTaskNode,
    context: StageDispatchContext,
    onSession: (sessionId: string) => void
  ): Promise<StageOutcome>;
  /** Stops a stage that has outrun its timeout or whose run was cancelled. */
  cancelStage?(nodeId: string, context: StageDispatchContext): Promise<void>;
}

export interface WorkflowRunPersistence {
  get(runId: string): WorkflowRun | undefined;
  save(run: WorkflowRun): Promise<WorkflowRun>;
}

/** Prepares and tears down the single worktree a run's stages share. */
export interface WorkflowWorkspaceProvider {
  acquire(run: WorkflowRun): Promise<string>;
  release(run: WorkflowRun): Promise<void>;
}

export interface WorkflowOrchestratorOptions {
  runs: WorkflowRunPersistence;
  dispatcher: StageDispatcher;
  /** Omit for workflows that need no worktree (checks against the project root). */
  workspace?: WorkflowWorkspaceProvider;
  /** Notified after every persisted transition — the run-changed push channel. */
  onRunChanged?: (run: WorkflowRun) => void;
  /** Injectable for tests. */
  now?: () => string;
}

export class WorkflowOrchestrator {
  /** `${runId}:${nodeId}` for stages launched but not yet settled. */
  private readonly inFlight = new Set<string>();
  private readonly executions = new Map<string, { controller: AbortController; completion: Promise<StageOutcome> }>();
  /** Per-run promise chain; see the "one step at a time" invariant. */
  private readonly chains = new Map<string, Promise<void>>();

  public constructor(private readonly options: WorkflowOrchestratorOptions) {}

  private get now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  /**
   * Advances a run as far as it can go right now. Safe to call from anywhere
   * and at any time — extra calls are cheap no-ops once nothing is ready.
   */
  public step(runId: string): Promise<void> {
    return this.enqueue(runId, () => this.stepOnce(runId), 'step');
  }

  /**
   * Serialises work on a run's chain.
   *
   * Every mutation of a run goes through here, which is what makes the loop's
   * local `run` snapshot safe: a stage settling mid-loop cannot interleave with
   * the dispatch pass, because the pass *is* the currently executing link.
   */
  private enqueue(runId: string, work: () => Promise<void>, label: string): Promise<void> {
    const chained = (this.chains.get(runId) ?? Promise.resolve())
      .then(work)
      .catch(error => {
        // A failure must never poison the chain; the run stays where it is and
        // the next trigger retries.
        console.error(`[workflow] ${label} failed for run ${runId}:`, error);
      });
    this.chains.set(runId, chained);
    return chained;
  }

  /** Stages this orchestrator currently has launched, for diagnostics/tests. */
  public inFlightStages(): string[] {
    return [...this.inFlight].sort();
  }

  /**
   * Applies timeouts for one run. Called by the periodic tick (TASK-118); kept
   * here so the cancel-then-record ordering lives with the rest of the loop.
   */
  public async enforceTimeouts(runId: string): Promise<void> {
    await this.enqueue(runId, async () => {
      const run = this.options.runs.get(runId);
      if (!run || isRunSettled(run)) return;
      for (const nodeId of findTimedOutNodes(run, this.now)) {
        await this.stopStage(run, nodeId);
        const current = this.options.runs.get(runId)!;
        await this.persist(applyWorkflowRunCommand(current, { kind: 'node-timed-out', nodeId, at: this.now }));
      }
    }, 'timeouts');
    await this.step(runId);
  }

  /** Stop execution before recording cancellation or releasing its worktree. */
  public async cancel(runId: string, reason?: string): Promise<void> {
    let failure: unknown;
    await this.enqueue(runId, async () => {
      try {
        const run = this.options.runs.get(runId);
        if (!run) throw new Error(`Run ${runId} was not found.`);
        const stopped = await Promise.allSettled(Object.keys(run.nodes)
          .filter(nodeId => this.executions.has(this.key(runId, nodeId)))
          .map(nodeId => this.stopStage(run, nodeId)));
        const failed = stopped.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        const current = this.options.runs.get(runId)!;
        await this.persist(applyWorkflowRunCommand(current, { kind: 'cancel', at: this.now, reason }));
      } catch (error) {
        failure = error;
      }
    }, 'cancel');
    if (failure) throw failure;
    await this.step(runId);
  }

  /** Merge host metadata into the latest record on the same chain as cleanup. */
  public async updateRun(runId: string, update: (run: WorkflowRun) => WorkflowRun): Promise<void> {
    let failure: unknown;
    await this.enqueue(runId, async () => {
      try {
        const run = this.options.runs.get(runId);
        if (!run) throw new Error(`Run ${runId} was not found.`);
        await this.persist(update(run));
      } catch (error) {
        failure = error;
      }
    }, 'update');
    if (failure) throw failure;
  }

  private async stopStage(run: WorkflowRun, nodeId: string): Promise<void> {
    const execution = this.executions.get(this.key(run.runId, nodeId));
    execution?.controller.abort();
    await this.options.dispatcher.cancelStage?.(nodeId, { run, worktreePath: run.worktreePath });
    // Wait for the execution, not dispatch(): its settlement is queued behind us.
    await execution?.completion.catch(() => undefined);
  }

  // ── The loop ───────────────────────────────────────────────────────────

  private async stepOnce(runId: string): Promise<void> {
    let run = this.options.runs.get(runId);
    if (!run) return;

    if (isRunSettled(run)) {
      await this.releaseWorkspace(run);
      return;
    }

    // Joins carry no work, so settling them is synchronous progress: keep
    // looping until the graph stops moving on its own.
    const joined = advanceJoins(run, this.now);
    if (joined !== run) {
      run = await this.persist(joined);
      if (isRunSettled(run)) {
        await this.releaseWorkspace(run);
        return;
      }
    }

    const schedule = scheduleWorkflowRun(run);
    const current = run;
    const launchable = schedule.ready
      .filter(nodeId => !this.inFlight.has(this.key(runId, nodeId)))
      .filter(nodeId => {
        const node = current.definition.nodes.find(candidate => candidate.id === nodeId);
        if (!node || (!isCheckNode(node) && !isAgentTaskNode(node))) return false;
        return this.options.dispatcher.canDispatch?.(node, current) ?? true;
      });
    if (launchable.length === 0) return;

    // The worktree is acquired lazily, on the first stage that needs one, so a
    // run that never dispatches anything never branches a tree.
    run = await this.ensureWorkspace(run);

    for (const nodeId of launchable) {
      const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
      if (!node || (!isCheckNode(node) && !isAgentTaskNode(node))) continue;

      // Claim before persisting: two interleaved steps must not both launch,
      // and the claim is released only when the stage settles.
      this.inFlight.add(this.key(runId, nodeId));

      try {
        run = await this.persist(applyWorkflowRunCommand(run, { kind: 'node-started', nodeId, at: this.now }));
      } catch (error) {
        this.inFlight.delete(this.key(runId, nodeId));
        throw error;
      }

      // Fire and forget: the completion handler re-enters the loop.
      void this.dispatch(runId, node, run);
    }
  }

  private async dispatch(
    runId: string,
    node: WorkflowCheckNode | WorkflowAgentTaskNode,
    run: WorkflowRun
  ): Promise<void> {
    const controller = new AbortController();
    const context: StageDispatchContext = {
      run,
      signal: controller.signal,
      ...(run.worktreePath ? { worktreePath: run.worktreePath } : {})
    };

    const completion = Promise.resolve().then(() => isCheckNode(node)
      ? this.options.dispatcher.runCheck(node, context)
      : this.options.dispatcher.runAgentStage(node, context, sessionId => {
          void this.recordSession(runId, node.id, sessionId);
        }));
    const key = this.key(runId, node.id);
    this.executions.set(key, { controller, completion });
    try {
      const outcome = await completion;
      this.executions.delete(key);
      await this.settle(runId, node.id, { kind: 'outcome', outcome });
    } catch (error) {
      this.executions.delete(key);
      await this.settle(runId, node.id, {
        kind: 'outcome',
        outcome: { status: 'failed', error: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      this.inFlight.delete(this.key(runId, node.id));
    }

    await this.step(runId);
  }

  /**
   * Records the attempt's session id as soon as the dispatcher reports it, so a
   * crash mid-stage still leaves the session traceable from the run.
   */
  private recordSession(runId: string, nodeId: string, sessionId: string): Promise<void> {
    return this.enqueue(
      runId,
      async () => {
        const run = this.options.runs.get(runId);
        const state = run?.nodes[nodeId];
        if (!run || !state || state.attempts.length === 0) return;
        const attempts = [...state.attempts];
        const last = attempts[attempts.length - 1];
        if (last.sessionId === sessionId) return;
        attempts[attempts.length - 1] = { ...last, sessionId };
        await this.persist({ ...run, nodes: { ...run.nodes, [nodeId]: { ...state, attempts } } });
      },
      'session attribution'
    );
  }

  /** Applies a stage result. Serialised on the run's chain like a step. */
  private settle(
    runId: string,
    nodeId: string,
    result: { kind: 'timeout' } | { kind: 'outcome'; outcome: StageOutcome }
  ): Promise<void> {
    return this.enqueue(
      runId,
      async () => {
        const run = this.options.runs.get(runId);
        if (!run) return;
        const at = this.now;
        const next =
          result.kind === 'timeout'
            ? applyWorkflowRunCommand(run, { kind: 'node-timed-out', nodeId, at })
            : result.outcome.status === 'succeeded'
              ? applyWorkflowRunCommand(run, {
                  kind: 'node-succeeded',
                  nodeId,
                  at,
                  ...(result.outcome.artifacts ? { artifacts: result.outcome.artifacts } : {}),
                  ...(result.outcome.exitCode !== undefined ? { exitCode: result.outcome.exitCode } : {}),
                  ...(result.outcome.snapshotRef ? { snapshotRef: result.outcome.snapshotRef } : {})
                })
              : applyWorkflowRunCommand(run, {
                  kind: 'node-failed',
                  nodeId,
                  at,
                  error: result.outcome.error ?? 'Stage failed.',
                  ...(result.outcome.exitCode !== undefined ? { exitCode: result.outcome.exitCode } : {})
                });
        if (next !== run) await this.persist(next);
      },
      `settling ${nodeId}`
    );
  }

  // ── Workspace ──────────────────────────────────────────────────────────

  private async ensureWorkspace(run: WorkflowRun): Promise<WorkflowRun> {
    if (!this.options.workspace || run.worktreePath) return run;
    const worktreePath = await this.options.workspace.acquire(run);
    return this.persist({ ...run, worktreePath });
  }

  private async releaseWorkspace(run: WorkflowRun): Promise<void> {
    if (!this.options.workspace || !run.worktreePath) return;
    if ([...this.executions.keys()].some(key => key.startsWith(`${run.runId}:`))) return;
    try {
      await this.options.workspace.release(run);
    } catch (error) {
      console.error(`[workflow] could not release the worktree for run ${run.runId}:`, error);
      return; // Keep the path so cleanup can be retried, including after restart.
    }
    await this.persist({ ...run, worktreePath: undefined });
  }

  // ── Plumbing ───────────────────────────────────────────────────────────

  private async persist(run: WorkflowRun): Promise<WorkflowRun> {
    const saved = await this.options.runs.save(run);
    this.options.onRunChanged?.(saved);
    return saved;
  }

  private key(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
  }
}
