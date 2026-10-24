/**
 * The scheduled-run runner (FX-BF-047 / FX-BE-148 / TASK-385, TASK-386).
 *
 * Orchestration only: every decision about *what happens to a run* is a pure
 * transition in `scheduledRunExecution.ts` / `scheduledBudget.ts`, and every
 * side effect (storage, the workflow engine, provider usage, the clock) is a
 * port. That is what lets restart recovery, ordering and the allowance hand-over be
 * unit-tested with fakes.
 *
 * Three guarantees the design is built around:
 *
 * - **Never launch a ticket twice.** The entry is saved as `running` with a
 *   `launchToken` *before* the workflow is launched, and the token travels on
 *   the workflow run. After a crash the entry is found again by token; if there
 *   is no run for it, the schedule pauses (`launch-interrupted`) and asks.
 * - **Never drop a change.** All work for one schedule goes through one promise
 *   chain, so a workflow-change event that arrives mid-step queues behind it
 *   instead of being ignored.
 * - **Never move past a failure by itself.** A failed ticket pauses the run;
 *   the user retries, skips or stops.
 */

import type { WorkflowRunSummary } from '../workflows/workflowRunSummary';
import type { ScheduledPauseReason, ScheduledQueueEntry, ScheduledRun, ScheduledTicketRef } from './scheduledRun';
import { dueScheduledRuns, startScheduledRunNow } from './scheduledRun';
import { decideProviderForEntry, DEFAULT_HANDOVER_THRESHOLD } from './scheduledBudget';
import {
  activeScheduledEntry,
  applyEntryProgress,
  bindEntryWorkflow,
  cancelScheduledRun,
  completeIfDrained,
  markEntryLaunching,
  nextLaunchableEntry,
  pauseScheduledRun,
  recordBudgetCheck,
  recordProviderHandover,
  resumeScheduledRun,
  retryScheduledEntry,
  skipScheduledEntry,
  startScheduledRunAttempt,
  type EntryProgress
} from './scheduledRunExecution';

/** Every provider that ran out on an earlier ticket of this run: the next ticket should not start on one. */
function exhaustedInRun(run: ScheduledRun): string[] {
  return [...new Set(run.entries.flatMap(entry => entry.outcome?.exhausted ?? []))];
}

/** Thrown by the `launch` port when a ticket cannot be started, with the reason the run should pause for. */
export class ScheduledLaunchError extends Error {
  public constructor(message: string, public readonly reason: ScheduledPauseReason = 'policy') {
    super(message);
    this.name = 'ScheduledLaunchError';
  }
}

/** A workflow run as the runner sees it. */
export interface WorkflowObservation {
  progress: EntryProgress;
  /** Informational: false while an agent turn is in flight. The handover port owns safe interruption. */
  idle?: boolean;
}

/** A failure awaiting manual recovery is not active work, even while the run stays open. */
export function scheduledWorkflowBlocker(summary: WorkflowRunSummary) {
  const active = summary.stages.some(stage => stage.lane === 'running' || stage.lane === 'ready');
  const looping = summary.loops.some(loop => loop.firing && !loop.needsDecision);
  if (summary.status !== 'running' || summary.needsDecision || active || looping) return undefined;
  return summary.stages.find(stage => stage.lane === 'failed');
}

export interface ProviderUsageReading {
  usable: string[];
  /** The provider new work starts on by default. */
  active?: string;
  /** Allowance used per provider as 0-1; undefined when the provider does not report. */
  used: Record<string, number | undefined>;
}

export interface ScheduledRunnerPorts {
  store: {
    list(): ScheduledRun[];
    get(id: string): ScheduledRun | undefined;
    save(run: ScheduledRun): Promise<ScheduledRun>;
  };
  now(): string;
  /** False while the preview flag is off: the runner starts and observes nothing. */
  isEnabled(): boolean;
  newToken(): string;
  /** `undefined` means the workflow run no longer exists. */
  observe(workflowRunId: string): WorkflowObservation | undefined;
  /** The workflow run launched with this token, if one exists. */
  findByLaunchToken(token: string): string | undefined;
  /** A readable reason the ticket cannot be run any more (deleted, moved, closed), or `undefined` when it can. */
  checkTicket(ticket: ScheduledTicketRef): Promise<string | undefined>;
  /** Starts the ticket's workflow run and returns its id. Throws `ScheduledLaunchError` when it cannot. */
  launch(request: { run: ScheduledRun; entry: ScheduledQueueEntry; workflowId: string; token: string; provider?: string }): Promise<string>;
  cancelWorkflow(workflowRunId: string, reason: string): Promise<void>;
  usage(): Promise<ProviderUsageReading>;
  /**
   * Preserves work in progress and moves the run to another provider. Returns `provider` when the
   * host handed to a different AI than `to` because `to` could not run the active stage.
   */
  handOver(request: { run: ScheduledRun; entry: ScheduledQueueEntry; workflowRunId: string; from: string; to: string; usedFraction: number }): Promise<{ checkpointRef?: string; provider?: string }>;
  /** Approves the gate the entry is waiting at. */
  approveGate?(workflowRunId: string, nodeId: string): Promise<void>;
  /** A run was saved. */
  onChanged?(run: ScheduledRun): void;
  /** Share of an allowance (0–1) at which a provider is handed over. Read at every decision so a settings change applies at once. */
  threshold?(): number;
}

export class ScheduledRunRunner {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly launching = new Set<string>();

  public constructor(private readonly ports: ScheduledRunnerPorts) {}

  /** Look at every schedule once: start the due ones and advance the live ones. */
  public async tick(): Promise<void> {
    if (!this.ports.isEnabled()) return;
    const now = this.ports.now();
    const runs = this.ports.store.list();
    const ids = new Set<string>([
      ...dueScheduledRuns(runs, now).map(run => run.id),
      ...runs.filter(run => run.status === 'running' || run.status === 'paused').map(run => run.id)
    ]);
    await Promise.all([...ids].map(id => this.enqueue(id, () => this.advance(id))));
  }

  /** A workflow run changed: advance the schedule that owns it, if any. */
  public async handleWorkflowChanged(workflowRunId: string): Promise<void> {
    if (!this.ports.isEnabled()) return;
    const owner = this.ports.store.list().find(run => run.entries.some(entry => entry.outcome?.workflowRunId === workflowRunId));
    if (owner) await this.enqueue(owner.id, () => this.advance(owner.id));
  }

  /**
   * Call once at startup, after missed runs were reconciled. Finds entries that
   * were mid-launch when Praxis stopped: binds them if their workflow run exists,
   * otherwise pauses and asks. Never relaunches by itself.
   */
  public async recover(): Promise<void> {
    if (!this.ports.isEnabled()) return;
    for (const run of this.ports.store.list()) {
      if (run.status !== 'running' && run.status !== 'paused') continue;
      await this.enqueue(run.id, async () => {
        const current = this.ports.store.get(run.id);
        if (current) await this.settleInterruptedLaunch(current);
      });
    }
  }

  // ── user commands ──────────────────────────────────────────────────────

  public startNow(runId: string): Promise<ScheduledRun> {
    return this.command(runId, run => {
      if (!this.ports.isEnabled()) throw new Error('Enable scheduled runs before starting this run.');
      return startScheduledRunNow(run, this.ports.now());
    }, true);
  }

  public pause(runId: string): Promise<ScheduledRun> {
    return this.command(runId, run => pauseScheduledRun(run, 'user', 'Paused by the user.', this.ports.now()));
  }

  public resume(runId: string): Promise<ScheduledRun> {
    return this.command(runId, run => resumeScheduledRun(run, this.ports.now()), true);
  }

  public retryEntry(runId: string, entryId: string): Promise<ScheduledRun> {
    return this.command(runId, run => retryScheduledEntry(run, entryId, this.ports.now()), true);
  }

  public skipEntry(runId: string, entryId: string): Promise<ScheduledRun> {
    return this.command(runId, async run => {
      const workflowRunId = run.entries.find(entry => entry.id === entryId)?.outcome?.workflowRunId;
      const live = run.entries.find(entry => entry.id === entryId)?.outcome?.status;
      if (workflowRunId && (live === 'running' || live === 'paused')) {
        await this.ports.cancelWorkflow(workflowRunId, 'Skipped from the schedule.');
      }
      return skipScheduledEntry(run, entryId, this.ports.now());
    }, true);
  }

  public cancel(runId: string): Promise<ScheduledRun> {
    return this.command(runId, async run => {
      const active = activeScheduledEntry(run)?.outcome?.workflowRunId;
      if (active) await this.ports.cancelWorkflow(active, 'The scheduled run was stopped.');
      return cancelScheduledRun(run, this.ports.now());
    });
  }

  public approveGate(runId: string, entryId: string): Promise<ScheduledRun> {
    return this.command(runId, async run => {
      const outcome = run.entries.find(entry => entry.id === entryId)?.outcome;
      if (!outcome?.workflowRunId || !outcome.gate) throw new Error('That ticket is not waiting at an approval gate.');
      if (!this.ports.approveGate) throw new Error('Approving from the schedule is not available here.');
      await this.ports.approveGate(outcome.workflowRunId, outcome.gate.nodeId);
      return run;
    }, true);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private enqueue<T>(runId: string, step: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(step, step);
    this.chains.set(runId, next.catch(() => undefined));
    return next;
  }

  /** Applies a user command, saves the result, then lets the run act on it straight away. */
  private command(runId: string, apply: (run: ScheduledRun) => ScheduledRun | Promise<ScheduledRun>, advanceAfter = false): Promise<ScheduledRun> {
    return this.enqueue(runId, async () => {
      const run = this.ports.store.get(runId);
      if (!run) throw new Error('That scheduled run no longer exists.');
      const next = await apply(run);
      const saved = next === run ? run : await this.save(next);
      if (advanceAfter && this.ports.isEnabled()) await this.advance(runId);
      return this.ports.store.get(runId) ?? saved;
    });
  }

  private async save(run: ScheduledRun): Promise<ScheduledRun> {
    const saved = await this.ports.store.save(run);
    this.ports.onChanged?.(saved);
    return saved;
  }

  private async advance(runId: string): Promise<void> {
    let run = this.ports.store.get(runId);
    if (!run) return;

    if (run.status === 'scheduled') {
      if (!dueScheduledRuns([run], this.ports.now()).length) return;
      run = await this.save(startScheduledRunAttempt(run, this.ports.now()));
    }
    if (run.status !== 'running' && run.status !== 'paused') return;

    run = await this.settleInterruptedLaunch(run);
    run = await this.observeActive(run);
    if (run.status === 'running') await this.launchNext(run);
  }

  /** An entry that is running with a token but no workflow run was caught mid-launch. */
  private async settleInterruptedLaunch(run: ScheduledRun): Promise<ScheduledRun> {
    if (run.status !== 'running' && run.status !== 'paused') return run;
    let current = run;
    for (const entry of run.entries) {
      const outcome = entry.outcome;
      if (outcome?.status !== 'running' || outcome.workflowRunId || !outcome.launchToken) continue;
      if (this.launching.has(entry.id)) continue;
      const found = this.ports.findByLaunchToken(outcome.launchToken);
      const at = this.ports.now();
      if (found) {
        current = await this.save(bindEntryWorkflow(current, entry.id, found, at));
      } else if (current.status === 'running') {
        const message = `Praxis stopped while starting ${entry.ticket.issueKey}. Retry it to start it again, or skip it.`;
        current = await this.save(pauseScheduledRun(current, 'launch-interrupted', message, at, entry.id));
      }
    }
    return current;
  }

  /**
   * Brings the running entry up to date with its workflow run, and hands over if
   * its provider is nearly out. A stall on a provider's limit is recorded rather
   * than handed over: by the time the schedule sees it the workflow's own `switch`
   * policy has already tried every provider it could, so what is left is a note
   * for the user and a provider the next ticket must not start on.
   */
  private async observeActive(run: ScheduledRun): Promise<ScheduledRun> {
    const entry = activeScheduledEntry(run);
    const workflowRunId = entry?.outcome?.workflowRunId;
    if (!entry || !workflowRunId) return run;

    const observation = this.ports.observe(workflowRunId);
    const at = this.ports.now();
    const progress: EntryProgress = observation?.progress ?? { kind: 'failed', reason: 'Its workflow run could not be found.' };
    let next = applyEntryProgress(run, entry.id, progress, at);
    if (next !== run) next = await this.save(next);

    if (observation?.progress.kind === 'stalled' && observation.progress.pauseReason === 'budget') {
      // The workflow's own limit policy owns the switch; the schedule only records what it learned.
      const exhausted = next.entries.find(candidate => candidate.id === entry.id)?.outcome?.exhausted ?? entry.outcome?.exhausted;
      if (exhausted?.length) {
        const message = `${exhausted.join(', ')} ran out while working on ${entry.ticket.issueKey}; they will not be started on again.`;
        const last = [...next.events].reverse().find(event => event.kind === 'budget-checked' && event.entryId === entry.id);
        if (!last || last.message !== message) next = await this.save(recordBudgetCheck(next, message, at, entry.id));
      }
      return next;
    }
    if (observation?.progress.kind === 'running' && next.status === 'running') {
      next = await this.checkHandover(next, entry.id, workflowRunId, observation.progress.provider ?? entry.outcome?.provider);
    }
    return next;
  }

  private async checkHandover(run: ScheduledRun, entryId: string, workflowRunId: string, provider: string | undefined): Promise<ScheduledRun> {
    const entry = run.entries.find(candidate => candidate.id === entryId);
    if (!entry || !provider) return run;
    const usage = await this.ports.usage();
    const decision = decideProviderForEntry({
      active: provider,
      usable: usage.usable,
      used: usage.used,
      exclude: entry.outcome?.exhausted,
      threshold: this.ports.threshold?.()
    });
    if (decision.kind === 'handover' && decision.from) {
      const usedFraction = decision.usedFraction ?? this.ports.threshold?.() ?? DEFAULT_HANDOVER_THRESHOLD;
      let checkpointRef: string | undefined;
      let to = decision.provider;
      try {
        let provider: string | undefined;
        ({ checkpointRef, provider } = await this.ports.handOver({ run, entry, workflowRunId, from: decision.from, to: decision.provider, usedFraction }));
        if (provider) to = provider;
      } catch (error) {
        return this.save(pauseScheduledRun(run, 'budget', `Provider handover failed: ${error instanceof Error ? error.message : String(error)}`, this.ports.now(), entryId));
      }
      const at = this.ports.now();
      return this.save(
        recordProviderHandover(run, entryId, { at, from: decision.from, to, usedPercent: usedFraction * 100, ...(checkpointRef ? { checkpointRef } : {}) }, at)
      );
    }
    if (decision.kind === 'pause') {
      return this.save(pauseScheduledRun(run, 'budget', decision.reason, this.ports.now(), entryId));
    }
    return run;
  }

  /** Launches the next queued ticket, skipping any that can no longer run, until one starts or the queue ends. */
  private async launchNext(start: ScheduledRun): Promise<void> {
    let run = start;
    for (let guard = 0; guard <= run.entries.length; guard += 1) {
      if (run.status !== 'running') return;
      const entry = nextLaunchableEntry(run);
      if (!entry) {
        const completed = completeIfDrained(run, this.ports.now());
        if (completed !== run) await this.save(completed);
        return;
      }

      const unavailable = await this.ports.checkTicket(entry.ticket);
      if (unavailable) {
        run = await this.save(skipScheduledEntry(run, entry.id, this.ports.now(), unavailable));
        continue;
      }

      const workflowId = run.policy.workflowId;
      if (!workflowId) {
        await this.save(pauseScheduledRun(run, 'policy', 'No workflow is chosen for this schedule, so no ticket can be started.', this.ports.now(), entry.id));
        return;
      }

      const usage = await this.ports.usage();
      const decision = decideProviderForEntry({
        active: usage.active,
        usable: usage.usable,
        used: usage.used,
        // A retry never lands back on a provider that ran out on this ticket, whatever its quota says now,
        // and the next ticket does not start on one that ran out on an earlier one.
        exclude: [...new Set([...(entry.outcome?.exhausted ?? []), ...exhaustedInRun(run)])],
        // Starting work is different from moving it mid-ticket: an old limit may have cleared, and refusing
        // to start anything at all is worse than trying the only provider there is.
        excludedAsLastResort: true,
        threshold: this.ports.threshold?.()
      });
      if (decision.kind === 'pause') {
        await this.save(pauseScheduledRun(run, decision.why === 'no-provider' ? 'no-provider' : 'budget', decision.reason, this.ports.now(), entry.id));
        return;
      }
      run = await this.save(recordBudgetCheck(run, decision.reason, this.ports.now(), entry.id));

      const token = this.ports.newToken();
      run = await this.save(markEntryLaunching(run, entry.id, token, decision.provider, this.ports.now()));
      this.launching.add(entry.id);
      try {
        const workflowRunId = await this.ports.launch({ run, entry, workflowId, token, provider: decision.provider });
        run = await this.save(bindEntryWorkflow(run, entry.id, workflowRunId, this.ports.now()));
      } catch (error) {
        // The launch threw, but it may have got as far as creating the run: only a missing run is safe to retry.
        const found = this.ports.findByLaunchToken(token);
        const at = this.ports.now();
        if (found) {
          run = await this.save(bindEntryWorkflow(run, entry.id, found, at));
        } else {
          const reason: ScheduledPauseReason = error instanceof ScheduledLaunchError ? error.reason : 'policy';
          const message = error instanceof Error ? error.message : String(error);
          const requeued = this.requeue(run, entry.id);
          await this.save(pauseScheduledRun(requeued, reason, `${entry.ticket.issueKey} could not be started: ${message}`, at, entry.id));
        }
        return;
      } finally {
        this.launching.delete(entry.id);
      }
      return;
    }
  }

  /** Puts an entry whose launch never happened back to queued without counting it as a retry. */
  private requeue(run: ScheduledRun, entryId: string): ScheduledRun {
    return { ...run, entries: run.entries.map(entry => (entry.id === entryId ? { ...entry, outcome: { status: 'queued' as const } } : entry)) };
  }
}
