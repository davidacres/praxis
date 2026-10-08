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
  isMergeNode,
  nodeMutatesWorktree,
  type CheckFindings,
  type WorkflowAgentTaskNode,
  type WorkflowArtifactKind,
  type WorkflowBoardReference,
  type WorkflowCheckNode,
  type WorkflowMergeNode
} from './workflowTypes';
import {
  applyWorkflowRunCommand,
  downstreamNodeIds,
  isRunSettled,
  reworkWorkflowRun,
  type WorkflowPauseReason,
  type WorkflowRun
} from './workflowRun';
import { advanceJoins, scheduleWorkflowRun } from './workflowScheduler';
import { pendingLoop } from './workflowEdges';
import { findTimedOutNodes } from './workflowRecovery';

/** What a dispatched stage reports back. */
export interface StageOutcome {
  status: 'succeeded' | 'failed';
  error?: string;
  exitCode?: number;
  /** Commit or worktree ref a mutating stage froze. */
  snapshotRef?: string;
  /** Immutable upstream implementation snapshot this stage assessed. */
  assessedSnapshotRef?: string;
  artifacts?: Array<{ contractId: string; kind: WorkflowArtifactKind; path?: string; reference?: WorkflowBoardReference }>;
  findings?: CheckFindings;
  /**
   * A `failed` outcome that says nothing about the work — the AI provider's
   * credit/quota/rate limit, or the stage's tooling being unable to run. The run
   * pauses on it instead of failing. See `WorkflowPauseReason`.
   */
  pause?: WorkflowPauseReason;
  /** The AI that ran an agent stage's attempt. */
  provider?: string;
}

export interface StageDispatchContext {
  run: WorkflowRun;
  /** Aborted before cancellation waits for stage execution to stop. */
  signal?: AbortSignal;
  /** The run's worktree, when one was acquired. */
  worktreePath?: string;
  /** Reports a bounded human-readable milestone while the stage is running. */
  reportProgress?: (message: string) => void;
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
  canDispatch?(node: WorkflowCheckNode | WorkflowAgentTaskNode | WorkflowMergeNode, run: WorkflowRun): boolean;
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
  /** Merges changes from the delivery worktree/branch into the base branch. */
  runMerge?(node: WorkflowMergeNode, context: StageDispatchContext): Promise<StageOutcome>;
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
  /**
   * Puts the run's worktree back to `ref`'s content as a new commit on the run's
   * branch (keep-best loops, FX-BE-166). History is added to, never rewritten, so
   * the iteration that was undone stays inspectable.
   */
  restore?(run: WorkflowRun, ref: string): Promise<void>;
}

export interface WorkflowOrchestratorOptions {
  runs: WorkflowRunPersistence;
  dispatcher: StageDispatcher;
  /** Omit for workflows that need no worktree (checks against the project root). */
  workspace?: WorkflowWorkspaceProvider;
  /** Notified after every persisted transition — the run-changed push channel. */
  onRunChanged?: (run: WorkflowRun) => void;
  /**
   * The next AI for a stage whose AI ran out of budget, under the `switch`
   * policy; undefined when no other AI is set up (the run then stops).
   */
  chooseFallbackProvider?: (run: WorkflowRun, nodeId: string) => Promise<string | undefined> | string | undefined;
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

    // A keep-best loop asked for earlier code back. That has to land before any
    // stage builds on the worktree — and before a settled run lets it go.
    if (run.pendingRestore) run = await this.applyRestore(run);

    if (isRunSettled(run)) {
      await this.releaseWorkspace(run);
      return;
    }

    // A firing loop edge is taken once nothing in the run is still running, so a
    // revision never reopens a stage out from under a session still working in it.
    // Budget spent means a person decides; the scheduler holds the run meanwhile.
    const loop = pendingLoop(run);
    if (loop) {
      const busy =
        Object.values(run.nodes).some(state => state.outcome === 'running') ||
        [...this.executions.keys()].some(key => key.startsWith(`${runId}:`));
      if (loop.kind !== 'take' || busy) return;
      const looped = applyWorkflowRunCommand(run, { kind: 'loop-taken', edgeId: loop.status.edge.id, at: this.now });
      if (looped === run) return;
      run = await this.persist(looped);
      if (run.pendingRestore) run = await this.applyRestore(run);
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
        if (!node || (!isCheckNode(node) && !isAgentTaskNode(node) && !isMergeNode(node))) return false;
        return this.options.dispatcher.canDispatch?.(node, current) ?? true;
      });
    if (launchable.length === 0) return;

    // The worktree is acquired lazily, on the first stage that needs one, so a
    // run that never dispatches anything never branches a tree.
    run = await this.ensureWorkspace(run);

    for (const nodeId of launchable) {
      const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
      if (!node || (!isCheckNode(node) && !isAgentTaskNode(node) && !isMergeNode(node))) continue;

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
    node: WorkflowCheckNode | WorkflowAgentTaskNode | WorkflowMergeNode,
    run: WorkflowRun
  ): Promise<void> {
    const controller = new AbortController();
    const context: StageDispatchContext = {
      run,
      signal: controller.signal,
      ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
      reportProgress: message => {
        void this.recordProgress(runId, node.id, message);
      }
    };

    const completion = Promise.resolve().then(() => {
      if (isCheckNode(node)) {
        return this.options.dispatcher.runCheck(node, context);
      }
      if (isMergeNode(node)) {
        if (!this.options.dispatcher.runMerge) {
          throw new Error('Merge stage dispatcher is not configured.');
        }
        return this.options.dispatcher.runMerge(node, context);
      }
      return this.options.dispatcher.runAgentStage(node, context, sessionId => {
        void this.recordSession(runId, node.id, sessionId);
      });
    });
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

  /** Persists live check milestones in the same durable event stream as stage outcomes. */
  private recordProgress(runId: string, nodeId: string, message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return Promise.resolve();
    return this.enqueue(
      runId,
      async () => {
        const run = this.options.runs.get(runId);
        if (!run) return;
        await this.persist(applyWorkflowRunCommand(run, {
          kind: 'node-progress',
          nodeId,
          at: this.now,
          phase: 'testing',
          message: trimmed
        }));
      },
      'stage progress'
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
                  ...(result.outcome.snapshotRef ? { snapshotRef: result.outcome.snapshotRef } : {}),
                  ...(result.outcome.assessedSnapshotRef ? { assessedSnapshotRef: result.outcome.assessedSnapshotRef } : {}),
                  ...(result.outcome.findings ? { findings: result.outcome.findings } : {}),
                  ...(result.outcome.provider ? { provider: result.outcome.provider } : {})
                })
              : applyWorkflowRunCommand(run, {
                  kind: 'node-failed',
                  nodeId,
                  at,
                  error: result.outcome.error ?? 'Stage failed.',
                  ...(result.outcome.exitCode !== undefined ? { exitCode: result.outcome.exitCode } : {}),
                  ...(result.outcome.findings ? { findings: result.outcome.findings } : {}),
                  ...(result.outcome.pause ? { pause: result.outcome.pause } : {}),
                  ...(result.outcome.provider ? { provider: result.outcome.provider } : {})
                });
        if (next !== run) {
          const recoverySource = next.definition.nodes.find(candidate =>
            candidate.type === 'check'
            && candidate.failureRecovery?.repairNodeId === nodeId
          );
          if (recoverySource && result.kind === 'outcome' && result.outcome.status === 'succeeded') {
            const completed = next.recoveryAttempts?.[recoverySource.id] ?? 0;
            const recoveryAttempts = { ...(next.recoveryAttempts ?? {}), [recoverySource.id]: completed + 1 };
            const counted = { ...next, recoveryAttempts };
            const revalidate = counted.definition.nodes
              .filter(candidate => candidate.id !== nodeId && (candidate.type === 'check' || candidate.type === 'approval'))
              .map(candidate => candidate.id);
            const refreshed = reworkWorkflowRun(counted, recoverySource.id, at, { resetNodeIds: revalidate });
            if (!refreshed.reason) {
              await this.persist(refreshed.run);
              return;
            }
          }
          const stage = next.definition.nodes.find(candidate => candidate.id === nodeId);
          const downstreamHasPriorEvidence = Boolean(
            stage && nodeMutatesWorktree(stage) && result.kind === 'outcome'
              && result.outcome.status === 'succeeded' && result.outcome.snapshotRef
              && next.definition.edges.some(edge => edge.from === nodeId)
              && (() => {
                const downstream = downstreamNodeIds(next, nodeId);
                downstream.delete(nodeId);
                // Only this revision's attempts count: a loop already reopened what came before.
                return Object.values(next.nodes).some(state => downstream.has(state.nodeId) && state.attempts.length > (state.revisionBase ?? 0))
                  || next.gateDecisions.some(decision => downstream.has(decision.nodeId));
              })()
          );
          if (downstreamHasPriorEvidence) {
            const refreshed = reworkWorkflowRun(next, nodeId, at, { rerunSource: false });
            if (!refreshed.reason) {
              await this.persist(refreshed.run);
              return;
            }
          }
          let saved = await this.persist(next);
          if (result.kind === 'outcome' && result.outcome.status === 'failed') {
            const failedNode = next.definition.nodes.find(candidate => candidate.id === nodeId);
            const recovery = failedNode?.type === 'check' ? failedNode.failureRecovery : undefined;
            const completed = recovery ? next.recoveryAttempts?.[nodeId] ?? 0 : 0;
            if (recovery && completed >= recovery.maxAttempts) {
              saved = await this.persist(applyWorkflowRunCommand(saved, {
                kind: 'node-skipped',
                nodeId: recovery.repairNodeId,
                at,
                reason: 'Automatic QA recovery budget exhausted.'
              }));
            }
          }
          if (result.kind === 'outcome' && result.outcome.pause === 'provider-limit' && !isRunSettled(saved)) {
            saved = await this.applyProviderLimitPolicy(saved, nodeId);
          }
          // A run that just ended (a required stage failed) has no use for
          // siblings still working: stop them and record how they ended rather
          // than letting their results fall on a finished run and vanish.
          if (isRunSettled(saved)) await this.stopInFlight(saved);
        }
      },
      `settling ${nodeId}`
    );
  }

  /**
   * A stage's AI ran out: under `ask` the stage stays paused for the user;
   * `switch` moves it to the next AI that is set up (stopping when there is
   * none); `stop` ends the run saying why.
   */
  private async applyProviderLimitPolicy(run: WorkflowRun, nodeId: string): Promise<WorkflowRun> {
    const policy = run.providerLimitPolicy ?? 'ask';
    if (policy === 'ask') return run;
    if (policy === 'switch') {
      const provider = await this.options.chooseFallbackProvider?.(run, nodeId);
      if (provider) {
        return this.persist(applyWorkflowRunCommand(run, { kind: 'stage-provider-switched', nodeId, at: this.now, provider, automatic: true }));
      }
      return this.persist(applyWorkflowRunCommand(run, { kind: 'provider-limit-stop', nodeId, at: this.now, detail: 'no other AI is set up to switch to' }));
    }
    return this.persist(applyWorkflowRunCommand(run, { kind: 'provider-limit-stop', nodeId, at: this.now }));
  }

  /**
   * Stops every stage still running in a run that has ended, then closes each as
   * `cancelled`. Runs on the run's chain, so it sees the record the settle wrote.
   */
  private async stopInFlight(run: WorkflowRun): Promise<void> {
    const running = Object.values(run.nodes)
      .filter(state => state.outcome === 'running')
      .map(state => state.nodeId);
    if (running.length === 0) return;
    await Promise.allSettled(
      running.filter(nodeId => this.executions.has(this.key(run.runId, nodeId))).map(nodeId => this.stopStage(run, nodeId))
    );
    let current = this.options.runs.get(run.runId) ?? run;
    const reason = `the run ended (${run.endedReason ?? run.status}).`;
    for (const nodeId of running) {
      current = applyWorkflowRunCommand(current, { kind: 'node-stopped', nodeId, at: this.now, reason });
    }
    if (current !== run) await this.persist(current);
  }

  // ── Workspace ──────────────────────────────────────────────────────────

  private async applyRestore(run: WorkflowRun): Promise<WorkflowRun> {
    const restore = run.pendingRestore;
    if (!restore) return run;
    let ok = false;
    let detail: string | undefined;
    if (!this.options.workspace?.restore) {
      detail = 'this host cannot restore a worktree';
    } else if (!run.worktreePath) {
      detail = 'the run has no worktree';
    } else {
      try {
        await this.options.workspace.restore(run, restore.ref);
        ok = true;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    return this.persist(applyWorkflowRunCommand(run, { kind: 'loop-restored', at: this.now, ok, ...(detail ? { detail } : {}) }));
  }

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
