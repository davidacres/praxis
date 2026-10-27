/**
 * What happens to a scheduled run once it starts: the pure transitions the
 * runner applies (FX-BF-047 / FX-BE-148 / TASK-385).
 *
 * Same rules as the definition operations — no clock reads, no I/O, each takes
 * the time it happened at — so restart recovery, ordering and "never launch the
 * same ticket twice" are tested here without a workflow engine. An operation
 * that changes nothing returns the very same object, which is how the runner
 * knows not to save.
 *
 * Order is strict. A sequential run launches only the first queued entry, and
 * only while no other entry is running, paused or failed. A parallel run
 * (FX-BE-149) may overlap the entries of one step, up to its cap, and a step
 * still waits for every entry before it. Either way a failure never lets the
 * run move past it by itself.
 */

import {
  touch,
  type ScheduledEntryOutcome,
  type ScheduledEntrySpend,
  type ScheduledHandover,
  type ScheduledPauseReason,
  type ScheduledQueueEntry,
  type ScheduledRun,
  type ScheduledRunEvent,
  type ScheduledRunTrigger
} from './scheduledRun';
import { newScheduledId, scheduledConcurrency, scheduledSteps } from './scheduledRun';

/** What the workflow engine says about an entry's workflow run, reduced to what the schedule cares about. */
/**
 * What the workflow engine says about an entry's workflow run, reduced to what
 * the schedule acts on. `exhausted` lists the providers that ran out during the
 * run, so a retry or a hand-over never goes back to one of them.
 */
export type EntryProgress = Pick<ScheduledEntryOutcome, 'estimate' | 'artifacts'> & (
  | { kind: 'running'; provider?: string; sessionId?: string; spend?: ScheduledEntrySpend; exhausted?: readonly string[] }
  | { kind: 'gate'; nodeId: string; label: string; spend?: ScheduledEntrySpend; exhausted?: readonly string[] }
  /** Stopped on the provider's limit or a stage's tooling; waiting for the user. */
  | { kind: 'stalled'; reason: string; pauseReason: ScheduledPauseReason; spend?: ScheduledEntrySpend; exhausted?: readonly string[] }
  | { kind: 'succeeded'; spend?: ScheduledEntrySpend; exhausted?: readonly string[] }
  | { kind: 'failed'; reason: string; spend?: ScheduledEntrySpend; exhausted?: readonly string[] }
  | { kind: 'cancelled'; reason: string; spend?: ScheduledEntrySpend; exhausted?: readonly string[] });

function findEntry(run: ScheduledRun, entryId: string): ScheduledQueueEntry {
  const entry = run.entries.find(candidate => candidate.id === entryId);
  if (!entry) throw new Error('That ticket is not in this schedule.');
  return entry;
}

function withOutcome(run: ScheduledRun, entryId: string, outcome: ScheduledEntryOutcome | undefined): ScheduledRun {
  return { ...run, entries: run.entries.map(entry => (entry.id === entryId ? { ...entry, outcome } : entry)) };
}

function outcomeOf(entry: ScheduledQueueEntry): ScheduledEntryOutcome {
  return entry.outcome ?? { status: 'queued' };
}

const isActive = (entry: ScheduledQueueEntry) => {
  const status = entry.outcome?.status;
  return status === 'running' || status === 'paused';
};

/** The entry currently occupying the run: running or paused (a failed entry blocks, but is not "active"). */
export function activeScheduledEntry(run: ScheduledRun): ScheduledQueueEntry | undefined {
  return run.entries.find(isActive);
}

export function failedScheduledEntry(run: ScheduledRun): ScheduledQueueEntry | undefined {
  return run.entries.find(entry => entry.outcome?.status === 'failed');
}

/** Every entry occupying a lane: running, or paused at a gate or a stall. */
export function activeScheduledEntries(run: ScheduledRun): ScheduledQueueEntry[] {
  return run.entries.filter(isActive);
}

const finished = (entry: ScheduledQueueEntry) => ['done', 'skipped'].includes(outcomeOf(entry).status);

/**
 * The entries that may launch now, in order, with no more than there are free
 * lanes. Nothing launches unless the run is running and no entry has failed.
 *
 * Sequential: the first queued entry, and only when nothing else is active.
 * Parallel: queued entries of the *current step* — the first step with anything
 * unfinished — so a step waits for every entry before it (the join bar), and
 * entries of one step overlap only up to `maxConcurrency`.
 */
export function launchableEntries(run: ScheduledRun): ScheduledQueueEntry[] {
  if (run.status !== 'running') return [];
  if (run.entries.some(entry => entry.outcome?.status === 'failed')) return [];
  const active = activeScheduledEntries(run).length;
  const cap = scheduledConcurrency(run.policy);
  if (cap === 1) {
    const first = active ? undefined : run.entries.find(entry => outcomeOf(entry).status === 'queued');
    return first ? [first] : [];
  }
  const current = scheduledSteps(run.entries).find(step => step.some(entry => !finished(entry)));
  if (!current) return [];
  return current.filter(entry => outcomeOf(entry).status === 'queued').slice(0, Math.max(0, cap - active));
}

/** The next entry to launch, or undefined when none may (see `launchableEntries`). */
export function nextLaunchableEntry(run: ScheduledRun): ScheduledQueueEntry | undefined {
  return launchableEntries(run)[0];
}

/** The lowest lane number no active entry holds. */
export function freeScheduledLane(run: ScheduledRun): number {
  const taken = new Set(activeScheduledEntries(run).map(entry => entry.outcome?.lane).filter((lane): lane is number => typeof lane === 'number'));
  let lane = 1;
  while (taken.has(lane)) lane += 1;
  return lane;
}

/**
 * The entry that still needs a person, if any, and why: a failure first, then a
 * gate, then a stall. With several lanes more than one entry can be waiting, but
 * a run holds one pause, so when one is settled the pause moves to the next.
 */
function waitingEntry(run: ScheduledRun): { entryId: string; reason: ScheduledPauseReason; message: string } | undefined {
  const failed = run.entries.find(entry => entry.outcome?.status === 'failed');
  if (failed) return { entryId: failed.id, reason: 'failure', message: `${failed.ticket.issueKey} failed: ${failed.outcome?.reason ?? 'it stopped.'}` };
  const gated = run.entries.find(entry => entry.outcome?.status === 'paused' && entry.outcome.gate);
  if (gated) return { entryId: gated.id, reason: 'approval', message: gated.outcome?.reason ?? `${gated.ticket.issueKey} is waiting for approval.` };
  const stalled = run.entries.find(entry => entry.outcome?.status === 'paused');
  if (stalled) return { entryId: stalled.id, reason: stalled.outcome?.waitReason ?? 'policy', message: stalled.outcome?.reason ?? `${stalled.ticket.issueKey} is waiting.` };
  return undefined;
}

/** Takes the run off pause, unless another entry is still waiting for a person; then the pause moves to it. */
function resumeUnlessWaiting(run: ScheduledRun, at: string, resumed?: Omit<ScheduledRunEvent, 'at'>): ScheduledRun {
  const other = waitingEntry(run);
  if (other) {
    if (run.pause?.entryId === other.entryId && run.status === 'paused') return touch(run, at, resumed);
    return touch(pausedRun(run, other.reason, other.message, at, other.entryId), at, { kind: 'paused', message: other.message, entryId: other.entryId });
  }
  return touch(runningAgain(run), at, resumed);
}

/** Starts an armed run. The trigger records an explicit Run now decision. */
export function startScheduledRunAttempt(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status !== 'scheduled') throw new Error(`A ${run.status} run cannot be started.`);
  const lastDecision = [...run.events].reverse().find(event => event.kind === 'start-now' || event.kind === 'armed');
  const trigger: ScheduledRunTrigger = lastDecision?.kind === 'start-now' ? 'start-now' : 'schedule';
  const attempt = { id: newScheduledId('attempt'), trigger, startedAt: at };
  return touch({ ...run, status: 'running', attempts: [...run.attempts, attempt] }, at, {
    kind: 'started',
    message: trigger === 'start-now' ? 'Started at the user’s request.' : 'Started on schedule.'
  });
}

/**
 * Records, before anything is launched, that this entry is about to be. Saving
 * this first is what makes a crash between "decided to launch" and "launched"
 * recoverable without launching twice.
 */
export function markEntryLaunching(
  run: ScheduledRun,
  entryId: string,
  launchToken: string,
  provider: string | undefined,
  at: string,
  lane?: { lane: number; reason: string }
): ScheduledRun {
  const entry = findEntry(run, entryId);
  if (outcomeOf(entry).status !== 'queued') throw new Error(`${entry.ticket.issueKey} is not waiting to run.`);
  const previous = outcomeOf(entry);
  const next: ScheduledEntryOutcome = {
    status: 'running',
    launchToken,
    startedAt: at,
    ...(provider ? { provider } : {}),
    ...(lane ? { lane: lane.lane, laneReason: lane.reason } : {}),
    ...(previous.estimate ? { estimate: previous.estimate } : {}),
    ...(previous.artifacts ? { artifacts: previous.artifacts } : {}),
    ...(previous.retries ? { retries: previous.retries } : {}),
    ...(previous.handovers ? { handovers: previous.handovers } : {}),
    ...(previous.exhausted ? { exhausted: previous.exhausted } : {})
  };
  return touch(withOutcome(run, entryId, next), at, {
    kind: 'entry-launching',
    message: `Starting ${entry.ticket.issueKey}${provider ? ` on ${provider}` : ''}${lane ? ` in lane ${lane.lane}: ${lane.reason}` : '.'}`,
    entryId
  });
}

/** Ties the entry to the workflow run that was launched for it. */
export function bindEntryWorkflow(run: ScheduledRun, entryId: string, workflowRunId: string, at: string): ScheduledRun {
  const entry = findEntry(run, entryId);
  const outcome = outcomeOf(entry);
  if (outcome.workflowRunId === workflowRunId) return run;
  return touch(withOutcome(run, entryId, { ...outcome, workflowRunId }), at, {
    kind: 'entry-started',
    message: `${entry.ticket.issueKey} is running.`,
    entryId
  });
}

function sameSpend(left?: ScheduledEntrySpend, right?: ScheduledEntrySpend): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** The providers known to have run out, merging what the run reports with what was already recorded. */
function exhaustedAfter(outcome: ScheduledEntryOutcome, reported?: readonly string[]): string[] | undefined {
  const merged = [...new Set([...(outcome.exhausted ?? []), ...(reported ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

const sameExhausted = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function pausedRun(run: ScheduledRun, reason: ScheduledPauseReason, message: string, at: string, entryId?: string): ScheduledRun {
  return { ...run, status: 'paused', pause: { reason, message, at, ...(entryId ? { entryId } : {}) } };
}

function runningAgain(run: ScheduledRun): ScheduledRun {
  const { pause: _pause, ...rest } = run;
  return { ...rest, status: 'running' };
}

/** Pauses the run (not the workflow already in flight) until the user decides. */
export function pauseScheduledRun(run: ScheduledRun, reason: ScheduledPauseReason, message: string, at: string, entryId?: string): ScheduledRun {
  if (run.status !== 'running') {
    if (run.status === 'paused') return run;
    throw new Error(`A ${run.status} run cannot be paused.`);
  }
  return touch(pausedRun(run, reason, message, at, entryId), at, { kind: 'paused', message, ...(entryId ? { entryId } : {}) });
}

/**
 * The user's go-ahead after a pause. A pause caused by a failed ticket needs a
 * decision about that ticket (retry, skip or stop) rather than a bare resume.
 */
export function resumeScheduledRun(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status !== 'paused') throw new Error('Only a paused run can be resumed.');
  if (run.pause?.reason === 'failure') throw new Error('A ticket failed. Retry it, skip it, or stop the run.');
  if (run.pause?.reason === 'approval') throw new Error('A ticket is waiting at an approval gate. Approve it and the run continues by itself.');
  if (run.pause?.reason === 'launch-interrupted') throw new Error('Praxis stopped while starting a ticket. Retry it or skip it.');
  return touch(runningAgain(run), at, { kind: 'resumed', message: 'Resumed.' });
}

/**
 * Applies what the workflow run is doing to the entry (and, when it needs a
 * person, to the run). Idempotent: repeating the same progress changes nothing.
 */
export function applyEntryProgress(run: ScheduledRun, entryId: string, progress: EntryProgress, at: string): ScheduledRun {
  const outcome = outcomeOf(findEntry(run, entryId));
  if (outcome.status === 'done' || outcome.status === 'skipped') return run;
  const estimate = outcome.estimate ?? progress.estimate;
  const artifacts = [...new Map([...(outcome.artifacts ?? []), ...(progress.artifacts ?? [])].map(artifact => [artifact.artifactId, artifact])).values()];
  const changed = JSON.stringify(estimate) !== JSON.stringify(outcome.estimate) || JSON.stringify(artifacts) !== JSON.stringify(outcome.artifacts ?? []);
  const enriched = changed ? withOutcome(run, entryId, { ...outcome, ...(estimate ? { estimate } : {}), ...(artifacts.length ? { artifacts } : {}) }) : run;
  return applyProgressState(enriched, entryId, progress, at);
}

function applyProgressState(run: ScheduledRun, entryId: string, progress: EntryProgress, at: string): ScheduledRun {
  const entry = findEntry(run, entryId);
  const outcome = outcomeOf(entry);
  const key = entry.ticket.issueKey;
  if (outcome.status === 'done' || outcome.status === 'skipped') return run;
  const spend = progress.spend ?? outcome.spend;
  const { gate: _gate, reason: _reason, waitReason: _waitReason, ...withoutGate } = outcome;

  switch (progress.kind) {
    case 'running': {
      const exhausted = exhaustedAfter(outcome, progress.exhausted);
      const wasWaiting = run.status === 'paused' && run.pause?.entryId === entryId && (run.pause.reason === 'approval' || (run.pause.reason === 'budget' && outcome.status === 'paused') || run.pause.reason === 'policy' || run.pause.reason === 'failure');
      const unchanged =
        outcome.status === 'running' && !outcome.gate && !wasWaiting && sameSpend(outcome.spend, spend) && sameExhausted(outcome.exhausted, exhausted) &&
        (!progress.provider || progress.provider === outcome.provider) && (!progress.sessionId || progress.sessionId === outcome.sessionId);
      if (unchanged) return run;
      let next = withOutcome(run, entryId, {
        ...withoutGate,
        status: 'running',
        ...(progress.provider ? { provider: progress.provider } : {}),
        ...(progress.sessionId ? { sessionId: progress.sessionId } : {}),
        ...(spend ? { spend } : {}),
        ...(exhausted ? { exhausted } : {})
      });
      if (wasWaiting) {
        next = resumeUnlessWaiting(next, at, { kind: 'resumed', message: `${key} is running again.`, entryId });
      } else {
        next = touch(next, at);
      }
      return next;
    }
    case 'gate': {
      if (outcome.status === 'paused' && outcome.gate?.nodeId === progress.nodeId && sameSpend(outcome.spend, spend)) return run;
      const exhausted = exhaustedAfter(outcome, progress.exhausted);
      const gate = { nodeId: progress.nodeId, label: progress.label, since: outcome.gate?.nodeId === progress.nodeId ? outcome.gate.since : at };
      const message = `${key} is waiting for approval: ${progress.label}.`;
      const next = withOutcome(run, entryId, { ...outcome, status: 'paused', gate, reason: message, ...(spend ? { spend } : {}), ...(exhausted ? { exhausted } : {}) });
      if (outcome.gate?.nodeId === progress.nodeId) return touch(next, at);
      return touch(pausedRun(next, 'approval', message, at, entryId), at, { kind: 'entry-gate', message, entryId });
    }
    case 'stalled': {
      const exhausted = exhaustedAfter(outcome, progress.exhausted);
      if (outcome.status === 'paused' && outcome.reason === progress.reason && run.status === 'paused' && sameExhausted(outcome.exhausted, exhausted)) return run;
      const next = withOutcome(run, entryId, { ...withoutGate, status: 'paused', reason: progress.reason, waitReason: progress.pauseReason, ...(spend ? { spend } : {}), ...(exhausted ? { exhausted } : {}) });
      return touch(pausedRun(next, progress.pauseReason, progress.reason, at, entryId), at, { kind: 'paused', message: progress.reason, entryId });
    }
    case 'succeeded': {
      const exhausted = exhaustedAfter(outcome, progress.exhausted);
      const next = withOutcome(run, entryId, { ...withoutGate, status: 'done', endedAt: at, ...(spend ? { spend } : {}), ...(exhausted ? { exhausted } : {}) });
      const done = { kind: 'entry-done' as const, message: `${key} finished.`, entryId };
      const settled = run.status === 'paused' && run.pause?.entryId === entryId ? resumeUnlessWaiting(next, at, done) : touch(next, at, done);
      return completeIfDrained(settled, at);
    }
    case 'failed':
    case 'cancelled': {
      const message = `${key} ${progress.kind === 'failed' ? 'failed' : 'was cancelled'}: ${progress.reason}`;
      const exhausted = exhaustedAfter(outcome, progress.exhausted);
      const next = withOutcome(run, entryId, { ...withoutGate, status: 'failed', endedAt: at, reason: progress.reason, ...(spend ? { spend } : {}), ...(exhausted ? { exhausted } : {}) });
      return touch(pausedRun(next, 'failure', message, at, entryId), at, { kind: 'entry-failed', message, entryId });
    }
  }
}

/** Notes a provider switch made mid-ticket, with the checkpoint that preserved the work. */
export function recordProviderHandover(run: ScheduledRun, entryId: string, handover: ScheduledHandover, at: string): ScheduledRun {
  const entry = findEntry(run, entryId);
  const outcome = outcomeOf(entry);
  return touch(
    withOutcome(run, entryId, { ...outcome, provider: handover.to, handovers: [...(outcome.handovers ?? []), handover] }),
    at,
    {
      kind: 'provider-handover',
      message: `${entry.ticket.issueKey}: ${handover.from} → ${handover.to} at ${Math.round(handover.usedPercent)}%${handover.checkpointRef ? `, checkpoint ${handover.checkpointRef}` : ''}.`,
      entryId
    }
  );
}

/** Records what a budget check decided, for the ledger. Does not change the run's state. */
export function recordBudgetCheck(run: ScheduledRun, message: string, at: string, entryId?: string): ScheduledRun {
  return touch(run, at, { kind: 'budget-checked', message, ...(entryId ? { entryId } : {}) });
}

/** Puts a failed, stalled or interrupted ticket back at the front of the queue and lets the run continue. */
export function retryScheduledEntry(run: ScheduledRun, entryId: string, at: string): ScheduledRun {
  const entry = findEntry(run, entryId);
  const outcome = outcomeOf(entry);
  const interrupted = outcome.status === 'running' && !outcome.workflowRunId;
  if (outcome.status !== 'failed' && outcome.status !== 'paused' && !interrupted) {
    throw new Error(`${entry.ticket.issueKey} is not stopped, so there is nothing to retry.`);
  }
  const retries = (outcome.retries ?? 0) + 1;
  const next = withOutcome(run, entryId, {
    status: 'queued',
    retries,
    ...(outcome.estimate ? { estimate: outcome.estimate } : {}),
    ...(outcome.artifacts ? { artifacts: outcome.artifacts } : {}),
    ...(outcome.handovers ? { handovers: outcome.handovers } : {}),
    ...(outcome.exhausted ? { exhausted: outcome.exhausted } : {})
  });
  const retried = { kind: 'entry-retried' as const, message: `Retrying ${entry.ticket.issueKey}.`, entryId };
  return run.status === 'paused' ? resumeUnlessWaiting(next, at, retried) : touch(next, at, retried);
}

/** Leaves a ticket out of this run; the run carries on with the next one. */
export function skipScheduledEntry(run: ScheduledRun, entryId: string, at: string, reason = 'Skipped by the user.'): ScheduledRun {
  const entry = findEntry(run, entryId);
  const outcome = outcomeOf(entry);
  if (outcome.status === 'done' || outcome.status === 'skipped') return run;
  const { gate: _gate, waitReason: _waitReason, ...rest } = outcome;
  const next = withOutcome(run, entryId, { ...rest, status: 'skipped', endedAt: at, reason });
  const skipped = { kind: 'entry-skipped' as const, message: `Skipped ${entry.ticket.issueKey}: ${reason}`, entryId };
  const settled = run.status === 'paused' && run.pause?.entryId === entryId ? resumeUnlessWaiting(next, at, skipped) : touch(next, at, skipped);
  return completeIfDrained(settled, at);
}

/** A run whose every ticket is done or skipped is complete. */
export function completeIfDrained(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status !== 'running') return run;
  if (run.entries.some(entry => !['done', 'skipped'].includes(outcomeOf(entry).status))) return run;
  const attempts = run.attempts.map((attempt, index) => (index === run.attempts.length - 1 && !attempt.endedAt ? { ...attempt, endedAt: at } : attempt));
  const done = run.entries.filter(entry => outcomeOf(entry).status === 'done').length;
  return touch({ ...run, status: 'completed', attempts }, at, {
    kind: 'completed',
    message: `Finished: ${done} of ${run.entries.length} ticket${run.entries.length === 1 ? '' : 's'} done.`
  });
}

/**
 * Ends a running or paused run. Stopping after a failure leaves the run `failed`;
 * any other stop is `cancelled`. Tickets that never started are marked skipped.
 */
export function cancelScheduledRun(run: ScheduledRun, at: string, reason = 'Stopped by the user.'): ScheduledRun {
  if (run.status !== 'running' && run.status !== 'paused') throw new Error(`A ${run.status} run cannot be stopped.`);
  const failed = run.status === 'paused' && run.pause?.reason === 'failure';
  const entries = run.entries.map(entry => {
    const outcome = outcomeOf(entry);
    if (outcome.status === 'queued') return { ...entry, outcome: { ...outcome, status: 'skipped' as const, endedAt: at, reason } };
    if (outcome.status === 'running' || outcome.status === 'paused') {
      const { gate: _gate, ...rest } = outcome;
      return { ...entry, outcome: { ...rest, status: 'failed' as const, endedAt: at, reason } };
    }
    return entry;
  });
  const attempts = run.attempts.map((attempt, index) => (index === run.attempts.length - 1 && !attempt.endedAt ? { ...attempt, endedAt: at } : attempt));
  const { pause: _pause, ...rest } = run;
  return touch({ ...rest, status: failed ? 'failed' : 'cancelled', entries, attempts }, at, {
    kind: 'cancelled',
    message: failed ? `Stopped after a failure. ${reason}` : reason
  });
}
