/**
 * Scheduled ticket runs: the durable definition and its pure operations
 * (FX-BF-047 / FX-BE-147 / TASK-383).
 *
 * A `ScheduledRun` is the *definition* — a name, one absolute start time, and an
 * explicitly ordered queue of board tickets. What actually happens when the run
 * starts is recorded separately: `attempts` say when and why it was started, and
 * each queue entry's `outcome` carries its session link and result. The runner
 * (`scheduledRunRunner.ts`, FX-BE-148) writes those through the transitions in
 * `scheduledRunExecution.ts`; everything here is side-effect free: no clock
 * reads, no I/O, and every operation takes the time it happened at.
 *
 * Three rules shape the contract:
 *
 * - **Order is the schedule's own.** `sequence` is stored on each entry and
 *   renumbered contiguously after every change. It is never derived from board
 *   column order or ticket status, so reordering here cannot touch the board.
 * - **One-off only.** There is one `scheduledStartAt` (an absolute UTC instant)
 *   plus an IANA `timezone` used purely for display and editing. Repeat rules can
 *   be added later without migrating this shape.
 * - **A missed start is never started silently.** A schedule whose time passed
 *   while Praxis was closed becomes `missed`; only an explicit start-now or skip
 *   resolves it.
 */

import type { RunEstimate } from '../workflows/workflowEstimate';
import type { WorkflowArtifactRef } from '../workflows/workflowTypes';
import { randomUUID } from 'node:crypto';
import { zonedTimeToInstant } from './scheduledRunTime';

export const SCHEDULED_RUN_SCHEMA_VERSION = 1;

export type ScheduledRunStatus =
  /** Saved but not armed; it will not start. */
  | 'draft'
  /** Armed and waiting for `scheduledStartAt`. */
  | 'scheduled'
  /** The start passed while Praxis was closed; the user must start it or skip it. */
  | 'missed'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ScheduledEntryStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'skipped';

/** Where a queued ticket lives. `title` is a snapshot so a deleted ticket stays readable. */
export interface ScheduledTicketRef {
  connectionId: string;
  issueKey: string;
  title: string;
}

/** A provider switch the runner made mid-ticket because the first one was nearly out of allowance. */
export interface ScheduledHandover {
  at: string;
  from: string;
  to: string;
  /** 0-100, the allowance the first provider had used when the switch happened. */
  usedPercent: number;
  /** The commit that preserved the work in progress, when there was anything to commit. */
  checkpointRef?: string;
}

/** An approval gate the ticket's workflow is waiting at. */
export interface ScheduledEntryGate {
  nodeId: string;
  label: string;
  since: string;
}

/** What a ticket's run has cost so far; `estimated` marks a figure the provider did not report. */
export interface ScheduledEntrySpend {
  tokens?: number;
  cost?: number;
  currency?: string;
  estimated?: boolean;
}

/** What happened to one queue entry once the run started. Written by the runner, not the editor. */
export interface ScheduledEntryOutcome {
  status: ScheduledEntryStatus;
  sessionId?: string;
  workflowRunId?: string;
  startedAt?: string;
  endedAt?: string;
  /** Why it was skipped, failed, or paused, in words a person can act on. */
  reason?: string;
  /** The AI provider the ticket is running on (changes on a hand-over). */
  provider?: string;
  /**
   * Written and saved *before* the workflow run is launched, and carried onto it.
   * After a crash an entry that is running with a token but no `workflowRunId` is
   * looked up by token, so a ticket is never launched twice.
   */
  launchToken?: string;
  gate?: ScheduledEntryGate;
  handovers?: ScheduledHandover[];
  spend?: ScheduledEntrySpend;
  /** First observed estimate, retained independently of actual spend. */
  estimate?: Pick<RunEstimate, 'tokens' | 'spend' | 'notEstimable' | 'basedOnSessions'>;
  artifacts?: WorkflowArtifactRef[];
  /** Times the user retried this ticket after it failed or stopped. */
  retries?: number;
  /** Why a `paused` entry stopped (a stall's own reason), so the run can pause for it again after another entry is settled. */
  waitReason?: ScheduledPauseReason;
  /** Parallel mode only: the lane (1 to `maxConcurrency`) the ticket was started in. */
  lane?: number;
  /** Parallel mode only: why the runner allowed this ticket to run alongside others, for the ledger. */
  laneReason?: string;
  /**
   * Providers that ran out of credits or hit their limit while this ticket was
   * being worked on. They are never started on again, on a retry or by a
   * hand-over, even when their reported allowance looks fine — a hard limit
   * arrives long before a quota figure shows one.
   */
  exhausted?: string[];
}

export interface ScheduledQueueEntry {
  /** Stable for the life of the schedule, even as `sequence` changes. */
  id: string;
  /** 1-based and contiguous. */
  sequence: number;
  ticket: ScheduledTicketRef;
  /**
   * True when this ticket shares a step with the entry before it: the editor draws
   * them as one parallel step, meaning neither depends on the other. The runner
   * still takes them one at a time until bounded parallel lanes (FX-BE-149) land.
   * Never set on the first entry.
   */
  withPrevious?: true;
  outcome?: ScheduledEntryOutcome;
}

export type ScheduledRunTrigger = 'schedule' | 'start-now';

/** One execution of the definition. Sequential one-off schedules have at most one. */
export interface ScheduledRunAttempt {
  id: string;
  trigger: ScheduledRunTrigger;
  startedAt: string;
  endedAt?: string;
}

export type ScheduledRunEventKind =
  | 'created'
  | 'renamed'
  | 'tickets-added'
  | 'ticket-removed'
  | 'reordered'
  | 'rescheduled'
  | 'armed'
  | 'held'
  | 'missed'
  | 'start-now'
  | 'skipped'
  | 'workflow-changed'
  | 'started'
  | 'entry-launching'
  | 'entry-started'
  | 'entry-gate'
  | 'entry-done'
  | 'entry-failed'
  | 'entry-skipped'
  | 'entry-retried'
  | 'paused'
  | 'resumed'
  | 'budget-checked'
  | 'provider-handover'
  | 'completed'
  | 'cancelled';

export interface ScheduledRunEvent {
  at: string;
  kind: ScheduledRunEventKind;
  message: string;
  entryId?: string;
}

/**
 * How a run's tickets are started (FX-BE-149).
 *
 * `sequential` (the default) runs one ticket at a time in order. `parallel` lets
 * the tickets of one *step* (see `withPrevious`) overlap, never more than
 * `maxConcurrency` at once; a step still waits for every ticket before it. It is
 * a ceiling, not a promise: the runner uses fewer lanes whenever a safety or
 * allowance check says so.
 *
 * `workflowId` is the one governed workflow every ticket in the run is started
 * with; without it the run cannot start (readiness says so), because nothing
 * should silently pick a workflow for an unattended run.
 */
export type ScheduledRunPolicy =
  | { mode: 'sequential'; workflowId?: string }
  | { mode: 'parallel'; maxConcurrency: number; workflowId?: string };

/** The most tickets a parallel run may have going at once. Kept low on purpose: each lane spends allowance. */
export const MAX_SCHEDULED_CONCURRENCY = 4;

/** How many tickets may run at once: 1 for a sequential run. */
export function scheduledConcurrency(policy: ScheduledRunPolicy): number {
  return policy.mode === 'parallel' ? policy.maxConcurrency : 1;
}

/**
 * The policy for a requested concurrency. Throws, with a message fit to show,
 * for anything but a whole number from 1 to `MAX_SCHEDULED_CONCURRENCY`; 1 (or
 * nothing) is sequential.
 */
export function scheduledPolicyFor(maxConcurrency: number | undefined, workflowId: string | undefined): ScheduledRunPolicy {
  const id = workflowId?.trim() || undefined;
  const value = maxConcurrency ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SCHEDULED_CONCURRENCY) {
    throw new Error(`Tickets at once must be a whole number from 1 to ${MAX_SCHEDULED_CONCURRENCY}.`);
  }
  return value === 1 ? { mode: 'sequential', ...(id ? { workflowId: id } : {}) } : { mode: 'parallel', maxConcurrency: value, ...(id ? { workflowId: id } : {}) };
}

/** Why a running schedule stopped and is waiting for the user. */
export type ScheduledPauseReason = 'budget' | 'approval' | 'policy' | 'trust' | 'no-provider' | 'failure' | 'user' | 'launch-interrupted';

export interface ScheduledRunPause {
  reason: ScheduledPauseReason;
  /** The queue entry the pause is about, when it is about one. */
  entryId?: string;
  message: string;
  at: string;
}

export interface ScheduledRun {
  schemaVersion: number;
  id: string;
  name: string;
  /** The project whose tickets this schedule queues; the lineup shows a project's own schedules. Absent on a schedule made without one. */
  projectId?: string;
  /** Absolute UTC instant, ISO 8601. */
  scheduledStartAt: string;
  /** IANA zone the user picked; display and editing only. */
  timezone: string;
  policy: ScheduledRunPolicy;
  entries: ScheduledQueueEntry[];
  status: ScheduledRunStatus;
  attempts: ScheduledRunAttempt[];
  /** Present only while `status` is `paused`. */
  pause?: ScheduledRunPause;
  createdAt: string;
  updatedAt: string;
  events: ScheduledRunEvent[];
}

/** Statuses in which the definition may still be edited. */
const EDITABLE: ReadonlySet<ScheduledRunStatus> = new Set(['draft', 'scheduled']);

export function isScheduledRunEditable(run: Pick<ScheduledRun, 'status'>): boolean {
  return EDITABLE.has(run.status);
}

export function newScheduledId(prefix: 'run' | 'entry' | 'attempt'): string {
  return `${prefix}-${randomUUID()}`;
}

export function ticketRefKey(ref: Pick<ScheduledTicketRef, 'connectionId' | 'issueKey'>): string {
  return `${ref.connectionId}\u0000${ref.issueKey}`;
}

/** True for an IANA zone this runtime knows. */
export function isValidTimeZone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function isValidInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function renumber(entries: readonly ScheduledQueueEntry[]): ScheduledQueueEntry[] {
  return entries.map((entry, index) => {
    if (index === 0 && entry.withPrevious) {
      const { withPrevious: _dropped, ...first } = entry;
      return { ...first, sequence: 1 };
    }
    return entry.sequence === index + 1 ? entry : { ...entry, sequence: index + 1 };
  });
}

/** Groups a queue into steps: each step is one entry, or a run of entries that share it. */
export function scheduledSteps<T extends Pick<ScheduledQueueEntry, 'withPrevious'>>(entries: readonly T[]): T[][] {
  const steps: T[][] = [];
  for (const entry of entries) {
    if (entry.withPrevious && steps.length) steps[steps.length - 1].push(entry);
    else steps.push([entry]);
  }
  return steps;
}

export function touch(run: ScheduledRun, at: string, event?: Omit<ScheduledRunEvent, 'at'>): ScheduledRun {
  return {
    ...run,
    updatedAt: at,
    events: event ? [...run.events, { at, ...event }] : run.events
  };
}

function assertEditable(run: ScheduledRun): void {
  if (!isScheduledRunEditable(run)) {
    throw new Error(`A ${run.status} run can no longer be edited. Duplicate it to plan another.`);
  }
}

export interface CreateScheduledRunInput {
  id?: string;
  projectId?: string;
  name: string;
  scheduledStartAt: string;
  timezone: string;
  tickets?: readonly ScheduledTicketRef[];
  /** `ticketRefKey`s of tickets that share a step with the ticket before them. */
  withPrevious?: readonly string[];
  workflowId?: string;
  /** Tickets allowed at once; 1 or absent is sequential. */
  maxConcurrency?: number;
  at: string;
}

/** A new schedule starts as a draft; arming it is a separate, explicit step. */
export function createScheduledRun(input: CreateScheduledRunInput): ScheduledRun {
  const name = input.name.trim();
  if (!name) throw new Error('A scheduled run needs a name.');
  if (!isValidInstant(input.scheduledStartAt)) throw new Error('The start time is not a valid date and time.');
  if (!isValidTimeZone(input.timezone)) throw new Error(`"${input.timezone}" is not a known timezone.`);

  const seen = new Set<string>();
  const together = new Set(input.withPrevious ?? []);
  const collected: ScheduledQueueEntry[] = [];
  for (const ticket of input.tickets ?? []) {
    const key = ticketRefKey(ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push({ id: newScheduledId('entry'), sequence: collected.length + 1, ticket: { ...ticket }, ...(together.has(key) ? { withPrevious: true as const } : {}) });
  }
  const entries = renumber(collected);

  return {
    schemaVersion: SCHEDULED_RUN_SCHEMA_VERSION,
    id: input.id ?? newScheduledId('run'),
    name,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    scheduledStartAt: new Date(input.scheduledStartAt).toISOString(),
    timezone: input.timezone,
    policy: scheduledPolicyFor(input.maxConcurrency, input.workflowId),
    entries,
    status: 'draft',
    attempts: [],
    createdAt: input.at,
    updatedAt: input.at,
    events: [{ at: input.at, kind: 'created', message: `Created with ${entries.length} ticket${entries.length === 1 ? '' : 's'}.` }]
  };
}

export function renameScheduledRun(run: ScheduledRun, name: string, at: string): ScheduledRun {
  assertEditable(run);
  const next = name.trim();
  if (!next) throw new Error('A scheduled run needs a name.');
  if (next === run.name) return run;
  return touch({ ...run, name: next }, at, { kind: 'renamed', message: `Renamed to "${next}".` });
}

/** Adds tickets to the end of the queue. A ticket already queued is ignored, so a double-drop is harmless. */
export function addTicketsToScheduledRun(run: ScheduledRun, tickets: readonly ScheduledTicketRef[], at: string): ScheduledRun {
  assertEditable(run);
  const seen = new Set(run.entries.map(entry => ticketRefKey(entry.ticket)));
  const added: ScheduledQueueEntry[] = [];
  for (const ticket of tickets) {
    const key = ticketRefKey(ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ id: newScheduledId('entry'), sequence: run.entries.length + added.length + 1, ticket: { ...ticket } });
  }
  if (added.length === 0) return run;
  return touch({ ...run, entries: [...run.entries, ...added] }, at, {
    kind: 'tickets-added',
    message: `Added ${added.map(entry => entry.ticket.issueKey).join(', ')}.`
  });
}

export function removeEntryFromScheduledRun(run: ScheduledRun, entryId: string, at: string): ScheduledRun {
  assertEditable(run);
  const entry = run.entries.find(candidate => candidate.id === entryId);
  if (!entry) throw new Error('That ticket is not in this schedule.');
  const entries = renumber(run.entries.filter(candidate => candidate.id !== entryId));
  return touch({ ...run, entries }, at, { kind: 'ticket-removed', message: `Removed ${entry.ticket.issueKey}.`, entryId });
}

/**
 * Moves an entry to a 0-based position in the queue. Out-of-range positions
 * clamp, so "move to the end" can pass a large number.
 */
export function moveEntryInScheduledRun(run: ScheduledRun, entryId: string, toIndex: number, at: string): ScheduledRun {
  assertEditable(run);
  const from = run.entries.findIndex(candidate => candidate.id === entryId);
  if (from < 0) throw new Error('That ticket is not in this schedule.');
  const target = Math.max(0, Math.min(run.entries.length - 1, Math.trunc(toIndex)));
  if (target === from) return run;
  const entries = [...run.entries];
  const [moved] = entries.splice(from, 1);
  entries.splice(target, 0, moved);
  return touch({ ...run, entries: renumber(entries) }, at, {
    kind: 'reordered',
    message: `Moved ${moved.ticket.issueKey} to position ${target + 1}.`,
    entryId
  });
}

export function rescheduleScheduledRun(run: ScheduledRun, scheduledStartAt: string, timezone: string, at: string): ScheduledRun {
  assertEditable(run);
  if (!isValidInstant(scheduledStartAt)) throw new Error('The start time is not a valid date and time.');
  if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" is not a known timezone.`);
  const instant = new Date(scheduledStartAt).toISOString();
  if (instant === run.scheduledStartAt && timezone === run.timezone) return run;
  return touch({ ...run, scheduledStartAt: instant, timezone }, at, { kind: 'rescheduled', message: `Start set to ${instant} (${timezone}).` });
}

/**
 * Arms a draft so it will start at its time. Needs at least one ticket and a
 * start that has not already passed — a schedule in the past is a mistake to
 * flag, not something to start the moment it is saved.
 */
export function armScheduledRun(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status === 'scheduled') return run;
  if (run.status !== 'draft') throw new Error(`A ${run.status} run cannot be armed.`);
  if (run.entries.length === 0) throw new Error('Add at least one ticket before scheduling the run.');
  if (Date.parse(run.scheduledStartAt) <= Date.parse(at)) throw new Error('The start time has already passed. Choose a later time.');
  return touch({ ...run, status: 'scheduled' }, at, { kind: 'armed', message: 'Scheduled.' });
}

/** Takes an armed schedule back to a draft so it will not start. */
export function holdScheduledRun(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status === 'draft') return run;
  if (run.status !== 'scheduled') throw new Error(`A ${run.status} run cannot be put on hold.`);
  return touch({ ...run, status: 'draft' }, at, { kind: 'held', message: 'Put on hold.' });
}

/**
 * Run when Praxis starts: anything armed whose time already passed was missed
 * because the app was not there to start it. The user decides what happens next.
 */
export function reconcileScheduledRunOnLaunch(run: ScheduledRun, now: string): ScheduledRun {
  if (run.status !== 'scheduled') return run;
  if (Date.parse(run.scheduledStartAt) > Date.parse(now)) return run;
  return touch({ ...run, status: 'missed' }, now, {
    kind: 'missed',
    message: `Due ${run.scheduledStartAt} while Praxis was not running.`
  });
}

/** Makes a saved draft, future schedule or missed run due at the user's request. */
export function startScheduledRunNow(run: ScheduledRun, at: string): ScheduledRun {
  if (!['draft', 'scheduled', 'missed'].includes(run.status)) throw new Error(`A ${run.status} run cannot be started now.`);
  if (run.entries.length === 0) throw new Error('Add at least one ticket before starting the run.');
  return touch({ ...run, status: 'scheduled', scheduledStartAt: new Date(at).toISOString() }, at, {
    kind: 'start-now',
    message: 'Run now requested by the user.'
  });
}

export type MissedResolution = 'start-now' | 'skip';

/**
 * Resolves a missed run. `start-now` re-arms it for the current moment so the
 * runner picks it up as due; `skip` cancels it. Neither starts anything itself.
 */
export function resolveMissedScheduledRun(run: ScheduledRun, resolution: MissedResolution, at: string): ScheduledRun {
  if (run.status !== 'missed') throw new Error('Only a missed run needs this decision.');
  if (resolution === 'skip') {
    return touch({ ...run, status: 'cancelled' }, at, { kind: 'skipped', message: 'Skipped by the user.' });
  }
  return touch({ ...run, status: 'scheduled', scheduledStartAt: new Date(at).toISOString() }, at, {
    kind: 'start-now',
    message: 'Started late at the user’s request.'
  });
}

/** Armed runs whose time has come, earliest first. */
export function dueScheduledRuns(runs: readonly ScheduledRun[], now: string): ScheduledRun[] {
  const cutoff = Date.parse(now);
  return runs
    .filter(run => run.status === 'scheduled' && Date.parse(run.scheduledStartAt) <= cutoff)
    .sort((left, right) => Date.parse(left.scheduledStartAt) - Date.parse(right.scheduledStartAt));
}

/** The next armed run that has not started yet; what the close warning should name. */
export function nextScheduledRun(runs: readonly ScheduledRun[]): ScheduledRun | undefined {
  return runs
    .filter(run => run.status === 'scheduled')
    .sort((left, right) => Date.parse(left.scheduledStartAt) - Date.parse(right.scheduledStartAt))[0];
}

/** Hands back a normalised copy of a queue with contiguous 1-based sequence numbers. */
export function renumberEntries(entries: readonly ScheduledQueueEntry[]): ScheduledQueueEntry[] {
  return renumber(entries);
}

/** What the schedule editor submits: the whole definition, with tickets in run order. */
export interface ComposeScheduledRunInput {
  /** Which project the schedule belongs to. Fixed when the schedule is created. */
  projectId?: string;
  name: string;
  /** Wall-clock start, interpreted in `timezone`: `YYYY-MM-DD` and `HH:mm`. */
  date: string;
  time: string;
  timezone: string;
  /** In run order; the position here becomes the sequence. */
  tickets: readonly ScheduledTicketRef[];
  /** `ticketRefKey`s of tickets that share a step with the ticket before them (drawn as parallel). */
  withPrevious?: readonly string[];
  /** The governed workflow each ticket is started with. */
  workflowId?: string;
  /** Tickets allowed at once (FX-BE-149); 1 or absent keeps the run sequential. */
  maxConcurrency?: number;
  /** True to schedule it, false to keep it as a draft. */
  arm: boolean;
  at: string;
}

/**
 * Builds or updates a schedule from the editor's submission.
 *
 * The editor works with a plain ordered list, so this is where that list becomes
 * queue entries: a ticket that was already queued keeps its entry id (so its
 * session link and history stay attached), a new one gets a fresh id, and a
 * removed one drops out. Events record what actually changed.
 *
 * Throws, with a message fit to show, for an empty name, an unknown timezone, a
 * wall time that does not exist (clocks going forward), a run that has already
 * started, or arming with no tickets or a start in the past.
 */
export function composeScheduledRun(existing: ScheduledRun | undefined, input: ComposeScheduledRunInput): ScheduledRun {
  const startAt = zonedTimeToInstant(input.date, input.time, input.timezone);
  if (!isValidTimeZone(input.timezone)) throw new Error(`"${input.timezone}" is not a known timezone.`);
  if (!startAt) {
    throw new Error(`${input.date} ${input.time} is not a valid time in ${input.timezone}. Clocks may change at that hour; pick another time.`);
  }

  let run: ScheduledRun;
  if (!existing) {
    run = createScheduledRun({ projectId: input.projectId, name: input.name, scheduledStartAt: startAt, timezone: input.timezone, tickets: input.tickets, withPrevious: input.withPrevious, workflowId: input.workflowId, maxConcurrency: input.maxConcurrency, at: input.at });
  } else {
    assertEditable(existing);
    run = existing.name === input.name.trim() ? existing : renameScheduledRun(existing, input.name, input.at);
    run = rescheduleScheduledRun(run, startAt, input.timezone, input.at);
    run = replaceQueue(run, input.tickets, input.withPrevious ?? [], input.at);
    run = setPolicy(run, scheduledPolicyFor(input.maxConcurrency, input.workflowId), input.at);
    if (run.status === 'scheduled' && !input.arm) run = holdScheduledRun(run, input.at);
  }
  if (input.arm && Date.parse(run.scheduledStartAt) <= Date.parse(input.at)) {
    throw new Error('The start time has already passed. Choose a later time.');
  }
  return input.arm ? armScheduledRun(run, input.at) : run;
}

function setPolicy(run: ScheduledRun, policy: ScheduledRunPolicy, at: string): ScheduledRun {
  const workflowChanged = policy.workflowId !== run.policy.workflowId;
  const lanesChanged = scheduledConcurrency(policy) !== scheduledConcurrency(run.policy);
  if (!workflowChanged && !lanesChanged) return run;
  let next = touch({ ...run, policy }, at);
  if (workflowChanged) {
    next = touch(next, at, { kind: 'workflow-changed', message: policy.workflowId ? `Workflow set to ${policy.workflowId}.` : 'Workflow cleared.' });
  }
  if (lanesChanged) {
    const lanes = scheduledConcurrency(policy);
    next = touch(next, at, { kind: 'workflow-changed', message: lanes > 1 ? `Up to ${lanes} tickets of a shared step may run at once.` : 'Tickets run one at a time.' });
  }
  return next;
}

function replaceQueue(run: ScheduledRun, tickets: readonly ScheduledTicketRef[], withPrevious: readonly string[], at: string): ScheduledRun {
  const existingByKey = new Map(run.entries.map(entry => [ticketRefKey(entry.ticket), entry] as const));
  const together = new Set(withPrevious);
  const seen = new Set<string>();
  const next: ScheduledQueueEntry[] = [];
  for (const ticket of tickets) {
    const key = ticketRefKey(ticket);
    if (seen.has(key)) continue;
    seen.add(key);
    const kept = existingByKey.get(key);
    const base: ScheduledQueueEntry = kept ? { ...kept, ticket: { ...kept.ticket, title: ticket.title || kept.ticket.title } } : { id: newScheduledId('entry'), sequence: 0, ticket: { ...ticket } };
    const { withPrevious: _previous, ...plain } = base;
    next.push(together.has(key) ? { ...plain, withPrevious: true } : plain);
  }
  const entries = renumber(next);
  const stepShape = (list: readonly ScheduledQueueEntry[]) => scheduledSteps(list).map(step => step.map(entry => ticketRefKey(entry.ticket)).join('+')).join(',');
  const regrouped = stepShape(entries) !== stepShape(run.entries);

  const removed = run.entries.filter(entry => !seen.has(ticketRefKey(entry.ticket)));
  const added = entries.filter(entry => !existingByKey.has(ticketRefKey(entry.ticket)));
  const survivorsBefore = run.entries.filter(entry => seen.has(ticketRefKey(entry.ticket))).map(entry => entry.id);
  const survivorsAfter = entries.filter(entry => existingByKey.has(ticketRefKey(entry.ticket))).map(entry => entry.id);
  const reordered = survivorsBefore.some((id, index) => id !== survivorsAfter[index]);

  if (removed.length === 0 && added.length === 0 && !reordered && !regrouped) return run;
  let result: ScheduledRun = { ...run, entries };
  const events: Array<Omit<ScheduledRunEvent, 'at'>> = [];
  for (const entry of removed) events.push({ kind: 'ticket-removed', message: `Removed ${entry.ticket.issueKey}.`, entryId: entry.id });
  if (added.length > 0) events.push({ kind: 'tickets-added', message: `Added ${added.map(entry => entry.ticket.issueKey).join(', ')}.` });
  if (reordered || regrouped) {
    const order = scheduledSteps(entries).map(step => step.map(entry => entry.ticket.issueKey).join(' + ')).join(', ');
    events.push({ kind: 'reordered', message: `Run order is now ${order}.` });
  }
  result = touch(result, at);
  return { ...result, events: [...result.events, ...events.map(event => ({ at, ...event }))] };
}
