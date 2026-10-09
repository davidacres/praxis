/**
 * The coordination broker's decisions, as a pure state machine (FX-BF-048 / TASK-392).
 *
 * Every change goes through `applyCoordination(state, command, now)`, which returns the
 * next state and the command's result. The host serialises calls and persists the state
 * *before* acknowledging a grant; this module decides, and never touches a disk, a clock
 * or a process.
 *
 * The rules that make it safe:
 *
 * - **All or none.** A request names every resource it needs; either every one is granted
 *   in one step or none is. Nothing is acquired incrementally, so two requests cannot each
 *   hold half of what the other needs.
 * - **First come, first served.** A request that conflicts with an earlier waiter queues
 *   behind it even if the resource is momentarily free, so a stream of small requests cannot
 *   starve a large one. Independent requests are not held up.
 * - **A freed resource is offered, not handed over.** The head waiter gets a short
 *   *reservation*; it must start (mark executing) before the reservation lapses, so a
 *   wakeup can never make an agent act on a resource it last looked at minutes ago.
 * - **Silence is not release.** A reserved claim whose lease runs out is dropped — nothing
 *   started. An executing one becomes `recovery-required` and blocks its resource until the
 *   host or a person confirms the work stopped. A claim is never silently reassigned.
 * - **No wait cycles.** A request that would wait on a session that is (transitively)
 *   waiting on it is refused with an explanation instead of queued.
 * - **Idempotent.** A repeated request id returns the same grant or queue position; a
 *   repeated release or recovery is a no-op.
 * - **A person outranks an agent at a live UI.** `takeover` moves a browser, app or desktop
 *   claim from whichever agent holds it to the person, and tells that agent what it saw there
 *   is out of date. Nothing else can be taken: files, checkouts and processes are only ever
 *   released by their owner or recovered.
 */

import { claimsConflict, describeResource } from './coordinationPolicy';
import {
  COORDINATION_SCHEMA_VERSION,
  type AcquireResult,
  type ClaimLifetime,
  type CoordinationBlocker,
  type CoordinationClaim,
  type CoordinationEvent,
  type CoordinationEventType,
  type CoordinationOwner,
  type CoordinationRequest,
  type CoordinationRequestItem,
  type CoordinationSession,
  type CoordinationState
} from './coordinationTypes';

/** Lease and timing defaults (ms). Heartbeats every 15 s keep a 90 s lease alive. */
export const COORDINATION_LEASE_MS = 90_000;
export const COORDINATION_RESERVATION_MS = 30_000;
export const COORDINATION_SESSION_STALE_MS = 120_000;
/** Bounds — exceeded, a command is refused with a reason; live claims are never evicted. */
export const COORDINATION_MAX_EVENTS = 500;
export const COORDINATION_MAX_WAITERS = 200;
export const COORDINATION_MAX_SESSIONS = 200;
export const COORDINATION_MAX_MESSAGE_CHARS = 2000;
/** An ended session's record is kept this long for its handoff, then dropped. */
export const COORDINATION_ENDED_RETENTION_MS = 24 * 60 * 60 * 1000;

export function emptyCoordinationState(epoch: string): CoordinationState {
  return { schemaVersion: COORDINATION_SCHEMA_VERSION, epoch, revision: 0, sequence: 0, sessions: {}, claims: [], waiters: [], events: [] };
}

export type CoordinationCommand =
  | { kind: 'register'; session: Pick<CoordinationSession, 'sessionKey' | 'runtime' | 'coverage'> & Partial<Pick<CoordinationSession, 'parentSessionKey' | 'scope' | 'worktree' | 'branch' | 'head'>> }
  | { kind: 'heartbeat'; sessionKey: string }
  | { kind: 'activity'; sessionKey: string; activity: string }
  | {
      kind: 'acquire';
      requestId: string;
      owner: CoordinationOwner;
      items: CoordinationRequestItem[];
      reason: string;
      lifetime: ClaimLifetime;
      /**
       * Queue when busy, or fail at once. `forMs` bounds the wait on the broker's own clock —
       * prefer it to `untilMs`, since a client's clock is not the broker's.
       */
      wait: false | { untilMs?: number; forMs?: number };
    }
  | { kind: 'start'; owner: CoordinationOwner; claimIds: string[]; generation?: number }
  | { kind: 'cleanup'; owner: CoordinationOwner; claimIds: string[] }
  | { kind: 'release'; owner: CoordinationOwner; claimIds?: string[]; requestId?: string }
  | { kind: 'cancel'; owner: CoordinationOwner; requestId: string }
  /** A turn ended and its tools are reaped: release its non-service claims, cancel its waits. */
  | { kind: 'end-turn'; owner: CoordinationOwner; summary?: string }
  | { kind: 'end-session'; sessionKey: string; summary?: string }
  | { kind: 'delegate'; owner: CoordinationOwner; claimId: string; to: CoordinationOwner }
  /** The host or a person confirms a recovery-required claim's work stopped. */
  | { kind: 'recover'; claimId: string; actor: string; note: string }
  /** A person took over a live UI surface (browser, app, desktop) an agent may hold. */
  | { kind: 'takeover'; requestId: string; sessionKey: string; items: CoordinationRequestItem[]; reason: string }
  | { kind: 'message'; from: string; to?: string; text: string; needsAck?: boolean }
  | { kind: 'ack'; sessionKey: string; sequence: number }
  /**
   * The broker was not running for `pausedMs` (the machine slept, the process was stopped).
   * Nobody could heartbeat in that time, so it is not counted against anyone: every lease
   * and heartbeat moves forward by it. An owner that is really gone still expires — one
   * lease after the broker resumed.
   */
  | { kind: 'suspended'; pausedMs: number }
  | { kind: 'tick' };

export type CoordinationResult =
  | { ok: true; acquire?: AcquireResult; sequence?: number }
  | { ok: false; error: string };

/** The only resources a person may take from an agent: the surfaces they are looking at. */
const TAKEOVER_KINDS = new Set(['browser', 'app-ui', 'desktop']);

const sameOwner = (left: CoordinationOwner, right: CoordinationOwner): boolean =>
  left.sessionKey === right.sessionKey && (left.executionId ?? '') === (right.executionId ?? '');

const SECRET = /(token|secret|password|apikey|api_key|\bpat\b)\s*[:=]\s*\S+|\b(ghp|gho|github_pat|glpat|sk-ant|sk-)[A-Za-z0-9_-]{8,}/gi;
function redact(text: string): string {
  return text.replace(SECRET, '[redacted]');
}

function event(state: CoordinationState, at: number, type: CoordinationEventType, text: string, extra: Partial<CoordinationEvent> = {}): CoordinationState {
  const sequence = state.sequence + 1;
  const events = [...state.events, { sequence, type, at, text: redact(text).slice(0, COORDINATION_MAX_MESSAGE_CHARS), ...extra }];
  // Bounded by dropping the oldest events only — claims and waiters live elsewhere and are never trimmed.
  return { ...state, sequence, events: events.length > COORDINATION_MAX_EVENTS ? events.slice(events.length - COORDINATION_MAX_EVENTS) : events };
}

/** Claims an item conflicts with, ignoring the requester's own (sequential reuse by one execution owner). */
function conflictingClaims(state: CoordinationState, owner: CoordinationOwner, item: CoordinationRequestItem): CoordinationClaim[] {
  return state.claims.filter(claim => !sameOwner(claim.owner, owner) && claimsConflict(claim, item));
}

function blockersFor(state: CoordinationState, owner: CoordinationOwner, items: CoordinationRequestItem[]): CoordinationBlocker[] {
  const requesterScope = state.sessions[owner.sessionKey]?.scope;
  const seen = new Set<string>();
  const blockers: CoordinationBlocker[] = [];
  for (const item of items) {
    for (const claim of conflictingClaims(state, owner, item)) {
      if (seen.has(claim.claimId)) continue;
      seen.add(claim.claimId);
      const ownerScope = state.sessions[claim.owner.sessionKey]?.scope;
      // Another project sees only that the resource is busy, not whose session or why.
      const redacted = !!requesterScope && !!ownerScope && requesterScope !== ownerScope;
      blockers.push({
        resource: claim.resource,
        ownerSessionKey: redacted ? 'another project' : claim.owner.sessionKey,
        reason: redacted ? 'in use' : claim.reason,
        state: claim.state,
        ...(redacted ? { redacted: true } : {})
      });
    }
  }
  return blockers;
}

/** Earlier waiters a request would overtake: it must queue behind them. */
function earlierConflictingWaiters(state: CoordinationState, request: Pick<CoordinationRequest, 'requestId' | 'owner' | 'items'>): CoordinationRequest[] {
  const index = state.waiters.findIndex(waiter => waiter.requestId === request.requestId);
  const ahead = index >= 0 ? state.waiters.slice(0, index) : state.waiters;
  return ahead.filter(waiter =>
    !sameOwner(waiter.owner, request.owner) &&
    waiter.items.some(theirs => request.items.some(mine => claimsConflict({ ...theirs }, mine)))
  );
}

const ownerKey = (owner: CoordinationOwner): string => `${owner.sessionKey}::${owner.executionId ?? ''}`;

/** Execution owners `owner` is (transitively) waiting on, through claims it is queued behind. */
function waitsOn(state: CoordinationState, key: string, seen = new Set<string>()): Set<string> {
  for (const waiter of state.waiters.filter(candidate => ownerKey(candidate.owner) === key)) {
    const holders = [
      ...waiter.items.flatMap(item => conflictingClaims(state, waiter.owner, item).map(claim => claim.owner)),
      ...earlierConflictingWaiters(state, waiter).map(ahead => ahead.owner)
    ];
    for (const holder of holders) {
      const next = ownerKey(holder);
      if (seen.has(next)) continue;
      seen.add(next);
      waitsOn(state, next, seen);
    }
  }
  return seen;
}

function grant(state: CoordinationState, request: Omit<CoordinationRequest, 'enqueuedAt'>, now: number, initial: 'reserved' | 'executing'): { state: CoordinationState; claimIds: string[]; generation: number } {
  const generation = state.revision + 1;
  const claims = request.items.map((item, index): CoordinationClaim => ({
    claimId: `${request.requestId}#${index}`,
    requestId: request.requestId,
    owner: request.owner,
    resource: item.resource,
    mode: item.mode,
    lifetime: request.lifetime,
    state: initial,
    reason: redact(request.reason).slice(0, 300),
    grantedAt: now,
    leaseUntil: now + (initial === 'reserved' ? COORDINATION_RESERVATION_MS : COORDINATION_LEASE_MS),
    generation
  }));
  let next: CoordinationState = {
    ...state,
    claims: [...state.claims, ...claims],
    waiters: state.waiters.filter(waiter => waiter.requestId !== request.requestId)
  };
  next = event(next, now, 'resource-acquired', `${request.owner.sessionKey} holds ${request.items.map(item => describeResource(item.resource)).join(', ')}: ${request.reason}`, {
    sessionKey: request.owner.sessionKey,
    claimIds: claims.map(claim => claim.claimId)
  });
  return { state: next, claimIds: claims.map(claim => claim.claimId), generation };
}

/** Offers freed resources to waiters in order: each fully satisfiable head waiter gets a reservation. */
function promoteWaiters(state: CoordinationState, now: number): CoordinationState {
  let next = state;
  for (const waiter of [...state.waiters]) {
    if (!next.waiters.some(candidate => candidate.requestId === waiter.requestId)) continue;
    if (waiter.waitUntil !== undefined && waiter.waitUntil < now) {
      next = event({ ...next, waiters: next.waiters.filter(candidate => candidate.requestId !== waiter.requestId) }, now, 'resource-blocked', `${waiter.owner.sessionKey} stopped waiting for ${waiter.reason}: the wait timed out.`, { toSessionKey: waiter.owner.sessionKey });
      continue;
    }
    const free = waiter.items.every(item => conflictingClaims(next, waiter.owner, item).length === 0);
    if (!free || earlierConflictingWaiters(next, waiter).length > 0) continue;
    const granted = grant(next, waiter, now, 'reserved');
    next = event(granted.state, now, 'resource-available', `What ${waiter.owner.sessionKey} was waiting for is reserved for it: start within ${Math.round(COORDINATION_RESERVATION_MS / 1000)} s or it is offered to the next waiter.`, {
      toSessionKey: waiter.owner.sessionKey,
      claimIds: granted.claimIds
    });
  }
  return next;
}

function bump(state: CoordinationState): CoordinationState {
  return { ...state, revision: state.revision + 1 };
}

export function applyCoordination(
  state: CoordinationState,
  command: CoordinationCommand,
  now: number
): { state: CoordinationState; result: CoordinationResult } {
  const fail = (error: string) => ({ state, result: { ok: false as const, error } });
  const done = (next: CoordinationState, extra: Omit<Extract<CoordinationResult, { ok: true }>, 'ok'> = {}) => ({ state: bump(next), result: { ok: true as const, ...extra } });

  switch (command.kind) {
    case 'register': {
      const existing = state.sessions[command.session.sessionKey];
      if (!existing && Object.keys(state.sessions).length >= COORDINATION_MAX_SESSIONS) return fail('Too many coordinated sessions; end idle ones first.');
      // Re-registering (a resume, a compaction) refreshes identity and never clears live claims.
      const session: CoordinationSession = {
        ...existing,
        ...command.session,
        state: 'active',
        registeredAt: existing?.registeredAt ?? now,
        heartbeatAt: now
      };
      let next: CoordinationState = { ...state, sessions: { ...state.sessions, [session.sessionKey]: session } };
      if (!existing) next = event(next, now, 'registered', `${session.sessionKey} joined (${session.runtime}, ${session.coverage}).`, { sessionKey: session.sessionKey });
      return done(next);
    }
    case 'heartbeat': {
      const session = state.sessions[command.sessionKey];
      if (!session) return fail('Unknown session.');
      const claims = state.claims.map(claim =>
        claim.owner.sessionKey === command.sessionKey && claim.state !== 'reserved' && claim.state !== 'recovery-required'
          ? { ...claim, leaseUntil: now + COORDINATION_LEASE_MS }
          : claim
      );
      return done({ ...state, claims, sessions: { ...state.sessions, [command.sessionKey]: { ...session, heartbeatAt: now, state: session.state === 'stale' ? 'active' : session.state } } });
    }
    case 'activity': {
      const session = state.sessions[command.sessionKey];
      if (!session) return fail('Unknown session.');
      const activity = redact(command.activity).slice(0, 300);
      return done(event({ ...state, sessions: { ...state.sessions, [command.sessionKey]: { ...session, activity } } }, now, 'activity', `${command.sessionKey}: ${activity}`, { sessionKey: command.sessionKey }));
    }
    case 'acquire': {
      if (!state.sessions[command.owner.sessionKey]) return fail('Register the session before acquiring.');
      if (command.items.length === 0) return fail('A request must name at least one resource.');
      // Idempotent: the same request id returns what it already has.
      const held = state.claims.filter(claim => claim.requestId === command.requestId);
      if (held.length > 0) return { state, result: { ok: true, acquire: { status: 'granted', claimIds: held.map(claim => claim.claimId), generation: held[0].generation } } };
      const queuedAt = state.waiters.findIndex(waiter => waiter.requestId === command.requestId);
      if (queuedAt >= 0) return { state, result: { ok: true, acquire: { status: 'queued', position: queuedAt + 1, blockers: blockersFor(state, command.owner, command.items) } } };

      const request = { requestId: command.requestId, owner: command.owner, items: command.items, reason: command.reason, lifetime: command.lifetime };
      const blockers = blockersFor(state, command.owner, command.items);
      const ahead = earlierConflictingWaiters(state, request);
      if (blockers.length === 0 && ahead.length === 0) {
        // Granted straight away to a requester about to act: it is executing from the start.
        const granted = grant(state, request, now, 'executing');
        return done(granted.state, { acquire: { status: 'granted', claimIds: granted.claimIds, generation: granted.generation } });
      }
      if (command.wait === false) {
        const reason = blockers.length > 0
          ? `Busy: ${blockers.map(blocker => `${describeResource(blocker.resource)} is held by ${blocker.ownerSessionKey} (${blocker.reason})`).join('; ')}.`
          : 'Busy: an earlier request is waiting for the same resources.';
        return { state: bump(event(state, now, 'resource-blocked', `${command.owner.sessionKey} was refused: ${reason}`, { sessionKey: command.owner.sessionKey })), result: { ok: true, acquire: { status: 'blocked', blockers, reason } } };
      }
      // Refuse a wait that would close a cycle: a holder is (transitively) waiting on the requester.
      const holders = [
        ...command.items.flatMap(item => conflictingClaims(state, command.owner, item).map(claim => claim.owner)),
        ...ahead.map(waiter => waiter.owner)
      ];
      for (const holder of holders) {
        if (waitsOn(state, ownerKey(holder)).has(ownerKey(command.owner))) {
          const reason = `Waiting would deadlock: ${holder.sessionKey} is waiting on what ${command.owner.sessionKey} holds. Release it, or restructure the work so the two do not wait on each other.`;
          return { state: bump(event(state, now, 'resource-blocked', reason, { sessionKey: command.owner.sessionKey })), result: { ok: true, acquire: { status: 'blocked', blockers, reason } } };
        }
      }
      if (state.waiters.length >= COORDINATION_MAX_WAITERS) return fail('Too many waiting requests; try again later.');
      const waitUntil = command.wait.forMs !== undefined ? now + command.wait.forMs : command.wait.untilMs;
      const waiter: CoordinationRequest = { ...request, enqueuedAt: now, ...(waitUntil !== undefined ? { waitUntil } : {}) };
      const next = event({ ...state, waiters: [...state.waiters, waiter] }, now, 'resource-blocked', `${command.owner.sessionKey} is waiting: ${command.reason}`, { sessionKey: command.owner.sessionKey });
      return done(next, { acquire: { status: 'queued', position: next.waiters.length, blockers } });
    }
    case 'start': {
      // A reservation becomes executing — only by its owner, only at the generation it was granted.
      let changed = false;
      const claims = state.claims.map(claim => {
        if (!command.claimIds.includes(claim.claimId) || !sameOwner(claim.owner, command.owner)) return claim;
        if (command.generation !== undefined && claim.generation !== command.generation) return claim;
        if (claim.state !== 'reserved') return claim;
        changed = true;
        return { ...claim, state: 'executing' as const, leaseUntil: now + COORDINATION_LEASE_MS };
      });
      const owned = state.claims.filter(claim => command.claimIds.includes(claim.claimId) && sameOwner(claim.owner, command.owner));
      if (owned.length !== command.claimIds.length) return fail('Those claims are not yours, or no longer exist: acquire again.');
      if (command.generation !== undefined && owned.some(claim => claim.generation !== command.generation)) return fail('Those claims changed hands since they were granted: acquire again.');
      return changed ? done({ ...state, claims }) : { state, result: { ok: true } };
    }
    case 'cleanup': {
      const claims = state.claims.map(claim =>
        command.claimIds.includes(claim.claimId) && sameOwner(claim.owner, command.owner) && claim.state === 'executing'
          ? { ...claim, state: 'cleaning-up' as const }
          : claim
      );
      return done({ ...state, claims });
    }
    case 'release': {
      const releasing = state.claims.filter(claim =>
        sameOwner(claim.owner, command.owner) &&
        claim.state !== 'recovery-required' &&
        (command.claimIds ? command.claimIds.includes(claim.claimId) : command.requestId ? claim.requestId === command.requestId : false)
      );
      if (releasing.length === 0) return { state, result: { ok: true } };
      let next: CoordinationState = { ...state, claims: state.claims.filter(claim => !releasing.includes(claim)) };
      next = event(next, now, 'resource-released', `${command.owner.sessionKey} released ${releasing.map(claim => describeResource(claim.resource)).join(', ')}.`, { sessionKey: command.owner.sessionKey, claimIds: releasing.map(claim => claim.claimId) });
      return done(promoteWaiters(next, now));
    }
    case 'cancel': {
      const waiter = state.waiters.find(candidate => candidate.requestId === command.requestId && sameOwner(candidate.owner, command.owner));
      if (!waiter) return { state, result: { ok: true } };
      return done(promoteWaiters({ ...state, waiters: state.waiters.filter(candidate => candidate !== waiter) }, now));
    }
    case 'end-turn': {
      const ending = (claim: CoordinationClaim) =>
        claim.owner.sessionKey === command.owner.sessionKey &&
        (command.owner.turnId === undefined || claim.owner.turnId === command.owner.turnId) &&
        claim.lifetime !== 'service' &&
        claim.state !== 'recovery-required';
      const released = state.claims.filter(ending);
      let next: CoordinationState = {
        ...state,
        claims: state.claims.filter(claim => !ending(claim)),
        waiters: state.waiters.filter(waiter => !(waiter.owner.sessionKey === command.owner.sessionKey && (command.owner.turnId === undefined || waiter.owner.turnId === command.owner.turnId)))
      };
      const session = next.sessions[command.owner.sessionKey];
      if (session) next = { ...next, sessions: { ...next.sessions, [session.sessionKey]: { ...session, state: 'idle', heartbeatAt: now } } };
      if (command.summary || released.length > 0) {
        next = event(next, now, 'done', `${command.owner.sessionKey} finished a turn${released.length ? `, releasing ${released.length} claim${released.length === 1 ? '' : 's'}` : ''}${command.summary ? `: ${command.summary}` : '.'}`, { sessionKey: command.owner.sessionKey, claimIds: released.map(claim => claim.claimId) });
      }
      return done(promoteWaiters(next, now));
    }
    case 'end-session': {
      const session = state.sessions[command.sessionKey];
      if (!session) return { state, result: { ok: true } };
      // An executing claim at session end has no proof its work stopped: it waits for recovery.
      const claims = state.claims
        .filter(claim => claim.owner.sessionKey !== command.sessionKey || claim.state === 'executing' || claim.state === 'cleaning-up' || claim.state === 'recovery-required' || claim.lifetime === 'service')
        .map(claim => (claim.owner.sessionKey === command.sessionKey && (claim.state === 'executing' || claim.state === 'cleaning-up') ? { ...claim, state: 'recovery-required' as const } : claim));
      let next: CoordinationState = {
        ...state,
        claims,
        waiters: state.waiters.filter(waiter => waiter.owner.sessionKey !== command.sessionKey),
        sessions: { ...state.sessions, [command.sessionKey]: { ...session, state: 'ended', heartbeatAt: now } }
      };
      next = event(next, now, 'done', `${command.sessionKey} ended${command.summary ? `: ${command.summary}` : '.'}`, { sessionKey: command.sessionKey });
      return done(promoteWaiters(next, now));
    }
    case 'delegate': {
      const claim = state.claims.find(candidate => candidate.claimId === command.claimId);
      if (!claim || !sameOwner(claim.owner, command.owner)) return fail('Only the owner of a claim can delegate it.');
      if (claim.state === 'recovery-required') return fail('A claim awaiting recovery cannot be delegated.');
      if (!state.sessions[command.to.sessionKey]) return fail('The delegate is not a registered session.');
      // The child owns it alone from here; the parent's access is suspended, not shared.
      const claims = state.claims.map(candidate => (candidate === claim ? { ...candidate, owner: command.to, generation: state.revision + 1 } : candidate));
      return done(event({ ...state, claims }, now, 'delegated', `${command.owner.sessionKey} handed ${describeResource(claim.resource)} to ${command.to.sessionKey}.`, { sessionKey: command.owner.sessionKey, toSessionKey: command.to.sessionKey, claimIds: [claim.claimId] }));
    }
    case 'recover': {
      const claim = state.claims.find(candidate => candidate.claimId === command.claimId);
      if (!claim) return { state, result: { ok: true } };
      if (claim.state !== 'recovery-required') return fail('Only a claim awaiting recovery can be recovered; its owner releases it otherwise.');
      if (!command.actor.trim() || !command.note.trim()) return fail('Recovery must record who confirmed the work stopped, and how.');
      let next: CoordinationState = { ...state, claims: state.claims.filter(candidate => candidate !== claim) };
      next = event(next, now, 'recovered', `${command.actor} confirmed ${describeResource(claim.resource)} is free (was ${claim.owner.sessionKey}'s): ${command.note}`, { claimIds: [claim.claimId] });
      return done(promoteWaiters(next, now));
    }
    case 'takeover': {
      if (!state.sessions[command.sessionKey]) return fail('Register the session before taking over.');
      if (command.items.length === 0 || command.items.some(item => !TAKEOVER_KINDS.has(item.resource.kind))) {
        return fail('Only the in-app browser, the live app or the desktop can be taken over; anything else is released by its owner.');
      }
      const owner = { sessionKey: command.sessionKey };
      // Already the person's: a repeated input refreshes nothing and says nothing.
      if (state.claims.some(claim => claim.requestId === command.requestId)) return { state, result: { ok: true } };
      const displaced = state.claims.filter(claim => !sameOwner(claim.owner, owner) && command.items.some(item => claimsConflict(claim, item)));
      let next: CoordinationState = { ...state, claims: state.claims.filter(claim => !displaced.includes(claim)) };
      for (const loser of new Set(displaced.map(claim => claim.owner.sessionKey))) {
        next = event(next, now, 'taken-over', `A person took over ${displaced.filter(claim => claim.owner.sessionKey === loser).map(claim => describeResource(claim.resource)).join(', ')} from ${loser}. Anything ${loser} saw there is out of date; it must not act on it again until it is handed back.`, {
          sessionKey: command.sessionKey,
          toSessionKey: loser,
          claimIds: displaced.filter(claim => claim.owner.sessionKey === loser).map(claim => claim.claimId)
        });
      }
      const granted = grant(next, { requestId: command.requestId, owner, items: command.items, reason: command.reason, lifetime: 'sequence' }, now, 'executing');
      return done(granted.state, { acquire: { status: 'granted', claimIds: granted.claimIds, generation: granted.generation } });
    }
    case 'message': {
      if (!state.sessions[command.from]) return fail('Unknown session.');
      if (!command.text.trim()) return fail('A message needs text.');
      if (command.text.length > COORDINATION_MAX_MESSAGE_CHARS) return fail(`Messages are limited to ${COORDINATION_MAX_MESSAGE_CHARS} characters.`);
      const next = event(state, now, 'message', command.text, { sessionKey: command.from, ...(command.to ? { toSessionKey: command.to } : {}), ...(command.needsAck ? { needsAck: true, ackedBy: [] } : {}) });
      return done(next, { sequence: next.sequence });
    }
    case 'ack': {
      const events = state.events.map(candidate =>
        candidate.sequence === command.sequence && candidate.needsAck && !(candidate.ackedBy ?? []).includes(command.sessionKey)
          ? { ...candidate, ackedBy: [...(candidate.ackedBy ?? []), command.sessionKey] }
          : candidate
      );
      return done(event({ ...state, events }, now, 'acknowledged', `${command.sessionKey} acknowledged message ${command.sequence}.`, { sessionKey: command.sessionKey }));
    }
    case 'suspended': {
      const pausedMs = Math.max(0, Math.round(command.pausedMs));
      if (pausedMs === 0) return { state, result: { ok: true } };
      const claims = state.claims.map(claim => (claim.state === 'recovery-required' ? claim : { ...claim, leaseUntil: claim.leaseUntil + pausedMs }));
      const sessions = Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, session.state === 'ended' ? session : { ...session, heartbeatAt: session.heartbeatAt + pausedMs }]));
      const waiters = state.waiters.map(waiter => (waiter.waitUntil !== undefined ? { ...waiter, waitUntil: waiter.waitUntil + pausedMs } : waiter));
      return done(event({ ...state, claims, sessions, waiters }, now, 'activity', `Coordination was paused for ${Math.round(pausedMs / 1000)} s (the machine slept or the broker was stopped); leases were extended by that much rather than expired.`));
    }
    case 'tick': {
      let next = state;
      let changed = false;
      // Reservations that lapsed: nothing started, so they are simply dropped and re-offered.
      const lapsed = next.claims.filter(claim => claim.state === 'reserved' && claim.leaseUntil < now);
      if (lapsed.length > 0) {
        changed = true;
        next = { ...next, claims: next.claims.filter(claim => !lapsed.includes(claim)) };
        next = event(next, now, 'resource-released', `Unused reservations lapsed: ${lapsed.map(claim => `${describeResource(claim.resource)} (${claim.owner.sessionKey})`).join(', ')}.`, { claimIds: lapsed.map(claim => claim.claimId) });
      }
      // Executing claims whose owner went silent: blocked for recovery, never reassigned.
      const silent = next.claims.filter(claim => (claim.state === 'executing' || claim.state === 'cleaning-up') && claim.leaseUntil < now);
      if (silent.length > 0) {
        changed = true;
        next = { ...next, claims: next.claims.map(claim => (silent.includes(claim) ? { ...claim, state: 'recovery-required' as const } : claim)) };
        next = event(next, now, 'recovery-required', `No heartbeat from the owner of ${silent.map(claim => `${describeResource(claim.resource)} (${claim.owner.sessionKey})`).join(', ')}: blocked until someone confirms the work stopped.`, { claimIds: silent.map(claim => claim.claimId) });
      }
      for (const session of Object.values(next.sessions)) {
        if (session.state === 'active' && now - session.heartbeatAt > COORDINATION_SESSION_STALE_MS) {
          changed = true;
          next = event({ ...next, sessions: { ...next.sessions, [session.sessionKey]: { ...session, state: 'stale' } } }, now, 'stale', `${session.sessionKey} has stopped responding.`, { sessionKey: session.sessionKey });
        }
        if (session.state === 'ended' && now - session.heartbeatAt > COORDINATION_ENDED_RETENTION_MS && !next.claims.some(claim => claim.owner.sessionKey === session.sessionKey)) {
          changed = true;
          const { [session.sessionKey]: _gone, ...rest } = next.sessions;
          next = { ...next, sessions: rest };
        }
      }
      const promoted = promoteWaiters(next, now);
      if (promoted !== next) changed = true;
      return changed ? done(promoted) : { state, result: { ok: true } };
    }
  }
}

/**
 * What one session may see: its scope's sessions and claims, messages to it or its scope.
 * With `sinceSequence`, only the events after it — and `resync: true` when some of those were
 * already trimmed, so the reader knows its delta has a gap and takes the snapshot as a whole.
 */
export function scopedSnapshot(state: CoordinationState, sessionKey: string, sinceSequence = 0) {
  const scope = state.sessions[sessionKey]?.scope;
  const oldest = state.events[0]?.sequence;
  const visible = (key?: string) => !key || key === sessionKey || !scope || state.sessions[key]?.scope === scope;
  return {
    schemaVersion: state.schemaVersion,
    epoch: state.epoch,
    revision: state.revision,
    sessions: Object.values(state.sessions).filter(session => visible(session.sessionKey)),
    claims: state.claims.map(claim => (visible(claim.owner.sessionKey) ? claim : { ...claim, owner: { sessionKey: 'another project' }, reason: 'in use', requestId: '' })),
    waiters: state.waiters.filter(waiter => visible(waiter.owner.sessionKey)),
    events: state.events.filter(entry => entry.sequence > sinceSequence && visible(entry.sessionKey) && (!entry.toSessionKey || entry.toSessionKey === sessionKey || entry.sessionKey === sessionKey)),
    lastSequence: state.sequence,
    resync: sinceSequence > 0 && (sinceSequence > state.sequence || (oldest !== undefined && oldest > sinceSequence + 1))
  };
}
