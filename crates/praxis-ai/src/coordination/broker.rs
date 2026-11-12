//! The coordination broker's decisions, as a state machine (FX-BF-048 / TASK-392).
//!
//! Every change goes through [`apply`], which mutates the state and returns the command's
//! result and whether the state changed. The host serialises calls and persists the state
//! *before* acknowledging a grant; this module decides, and never touches a disk, a clock or
//! a process.
//!
//! The rules that make it safe:
//!
//! - **All or none.** A request names every resource it needs; either every one is granted in
//!   one step or none is, so two requests cannot each hold half of what the other needs.
//! - **First come, first served.** A request that conflicts with an earlier waiter queues
//!   behind it even if the resource is momentarily free, so a stream of small requests cannot
//!   starve a large one. Independent requests are not held up.
//! - **A freed resource is offered, not handed over.** The head waiter gets a short
//!   *reservation*; it must start (mark executing) before the reservation lapses.
//! - **Silence is not release.** A reserved claim whose lease runs out is dropped. An
//!   executing one becomes `recovery-required` and blocks its resource until the host or a
//!   person confirms the work stopped. A claim is never silently reassigned.
//! - **No wait cycles.** A request that would wait on a session that is (transitively)
//!   waiting on it is refused with an explanation instead of queued.
//! - **Idempotent.** A repeated request id returns the same grant or queue position.
//! - **A person outranks an agent at a live UI.** `takeover` moves a browser, app or desktop
//!   claim from whichever agent holds it to the person. Nothing else can be taken.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

use super::policy::{claims_conflict, describe_resource};
use super::types::{
    AcquireResult, Blocker, Claim, ClaimState, Command, CommandResult, Event, EventType, Lifetime, Owner, Request, RequestItem, SCHEMA_VERSION, Session, SessionState, State, Wait,
};

/// Lease and timing defaults (ms). Heartbeats every 15 s keep a 90 s lease alive.
pub const LEASE_MS: i64 = 90_000;
pub const RESERVATION_MS: i64 = 30_000;
pub const SESSION_STALE_MS: i64 = 120_000;
/// Bounds — exceeded, a command is refused with a reason; live claims are never evicted.
pub const MAX_EVENTS: usize = 500;
pub const MAX_WAITERS: usize = 200;
pub const MAX_SESSIONS: usize = 200;
pub const MAX_MESSAGE_CHARS: usize = 2000;
/// An ended session's record is kept this long for its handoff, then dropped.
pub const ENDED_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

pub fn empty_state(epoch: &str) -> State {
    State { schema_version: SCHEMA_VERSION, epoch: epoch.to_owned(), revision: 0, sequence: 0, sessions: Default::default(), claims: Vec::new(), waiters: Vec::new(), events: Vec::new(), now: None }
}

/// The result of one command: what to answer, and whether the state (and so the file) changed.
pub struct Applied {
    pub result: CommandResult,
    pub changed: bool,
}

impl Applied {
    fn unchanged(result: CommandResult) -> Self {
        Self { result, changed: false }
    }
    fn fail(error: impl Into<String>) -> Self {
        Self::unchanged(CommandResult::fail(error))
    }
}

/// The only resources a person may take from an agent: the surfaces they are looking at.
fn takeover_kind(item: &RequestItem) -> bool {
    matches!(item.resource, super::types::Resource::Browser { .. } | super::types::Resource::AppUi { .. } | super::types::Resource::Desktop)
}

fn same_owner(left: &Owner, right: &Owner) -> bool {
    left.session_key == right.session_key && left.execution_id.as_deref().unwrap_or("") == right.execution_id.as_deref().unwrap_or("")
}

fn secret() -> &'static Regex {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    SECRET.get_or_init(|| {
        Regex::new(r"(?i)(token|secret|password|apikey|api_key|\bpat\b)\s*[:=]\s*\S+|\b(ghp|gho|github_pat|glpat|sk-ant|sk-)[A-Za-z0-9_-]{8,}").expect("the secret pattern is valid")
    })
}

fn redact(text: &str) -> String {
    secret().replace_all(text, "[redacted]").into_owned()
}

fn truncate(text: String, limit: usize) -> String {
    if text.chars().count() <= limit { text } else { text.chars().take(limit).collect() }
}

#[derive(Default)]
struct Extra {
    session_key: Option<String>,
    to_session_key: Option<String>,
    claim_ids: Option<Vec<String>>,
    needs_ack: bool,
}

impl Extra {
    fn session(key: &str) -> Self {
        Self { session_key: Some(key.to_owned()), ..Self::default() }
    }
    fn to(key: &str) -> Self {
        Self { to_session_key: Some(key.to_owned()), ..Self::default() }
    }
    fn claims(mut self, ids: Vec<String>) -> Self {
        self.claim_ids = Some(ids);
        self
    }
}

fn event(state: &mut State, at: i64, kind: EventType, text: &str, extra: Extra) {
    state.sequence += 1;
    state.events.push(Event {
        sequence: state.sequence,
        kind,
        at,
        session_key: extra.session_key,
        to_session_key: extra.to_session_key,
        text: truncate(redact(text), MAX_MESSAGE_CHARS),
        claim_ids: extra.claim_ids,
        needs_ack: extra.needs_ack.then_some(true),
        acked_by: extra.needs_ack.then(Vec::new),
    });
    // Bounded by dropping the oldest events only — claims and waiters live elsewhere.
    if state.events.len() > MAX_EVENTS {
        let excess = state.events.len() - MAX_EVENTS;
        state.events.drain(..excess);
    }
}

/// Claims an item conflicts with, ignoring the requester's own (sequential reuse by one execution owner).
fn conflicting_claims(state: &State, owner: &Owner, item: &RequestItem) -> Vec<Claim> {
    state.claims.iter().filter(|claim| !same_owner(&claim.owner, owner) && claims_conflict((&claim.resource, claim.mode), (&item.resource, item.mode))).cloned().collect()
}

fn blockers_for(state: &State, owner: &Owner, items: &[RequestItem]) -> Vec<Blocker> {
    let requester_scope = state.sessions.get(&owner.session_key).and_then(|s| s.scope.clone());
    let mut seen = HashSet::new();
    let mut blockers = Vec::new();
    for item in items {
        for claim in conflicting_claims(state, owner, item) {
            if !seen.insert(claim.claim_id.clone()) {
                continue;
            }
            let owner_scope = state.sessions.get(&claim.owner.session_key).and_then(|s| s.scope.clone());
            // Another project sees only that the resource is busy, not whose session or why.
            let redacted = matches!((&requester_scope, &owner_scope), (Some(a), Some(b)) if a != b);
            blockers.push(Blocker {
                resource: claim.resource,
                owner_session_key: if redacted { "another project".into() } else { claim.owner.session_key },
                reason: if redacted { "in use".into() } else { claim.reason },
                state: claim.state,
                redacted,
            });
        }
    }
    blockers
}

/// Earlier waiters a request would overtake: it must queue behind them.
fn earlier_conflicting_waiters(state: &State, request_id: &str, owner: &Owner, items: &[RequestItem]) -> Vec<Request> {
    let index = state.waiters.iter().position(|waiter| waiter.request_id == request_id);
    let ahead = match index {
        Some(i) => &state.waiters[..i],
        None => &state.waiters[..],
    };
    ahead
        .iter()
        .filter(|waiter| !same_owner(&waiter.owner, owner) && waiter.items.iter().any(|theirs| items.iter().any(|mine| claims_conflict((&theirs.resource, theirs.mode), (&mine.resource, mine.mode)))))
        .cloned()
        .collect()
}

fn owner_key(owner: &Owner) -> String {
    format!("{}::{}", owner.session_key, owner.execution_id.as_deref().unwrap_or(""))
}

/// Execution owners `key` is (transitively) waiting on, through claims it is queued behind.
fn waits_on(state: &State, key: &str, seen: &mut HashSet<String>) {
    for waiter in state.waiters.iter().filter(|candidate| owner_key(&candidate.owner) == key) {
        let mut holders: Vec<Owner> = waiter.items.iter().flat_map(|item| conflicting_claims(state, &waiter.owner, item).into_iter().map(|claim| claim.owner)).collect();
        holders.extend(earlier_conflicting_waiters(state, &waiter.request_id, &waiter.owner, &waiter.items).into_iter().map(|ahead| ahead.owner));
        for holder in holders {
            let next = owner_key(&holder);
            if !seen.insert(next.clone()) {
                continue;
            }
            waits_on(state, &next, seen);
        }
    }
}

struct Pending<'a> {
    request_id: &'a str,
    owner: &'a Owner,
    items: &'a [RequestItem],
    reason: &'a str,
    lifetime: Lifetime,
}

fn grant(state: &mut State, request: &Pending<'_>, now: i64, initial: ClaimState) -> (Vec<String>, i64) {
    let generation = state.revision + 1;
    let claims: Vec<Claim> = request
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| Claim {
            claim_id: format!("{}#{index}", request.request_id),
            request_id: request.request_id.to_owned(),
            owner: request.owner.clone(),
            resource: item.resource.clone(),
            mode: item.mode,
            lifetime: request.lifetime,
            state: initial,
            reason: truncate(redact(request.reason), 300),
            granted_at: now,
            lease_until: now + if initial == ClaimState::Reserved { RESERVATION_MS } else { LEASE_MS },
            generation,
        })
        .collect();
    let ids: Vec<String> = claims.iter().map(|claim| claim.claim_id.clone()).collect();
    state.claims.extend(claims);
    state.waiters.retain(|waiter| waiter.request_id != request.request_id);
    let what = request.items.iter().map(|item| describe_resource(&item.resource)).collect::<Vec<_>>().join(", ");
    event(state, now, EventType::ResourceAcquired, &format!("{} holds {what}: {}", request.owner.session_key, request.reason), Extra::session(&request.owner.session_key).claims(ids.clone()));
    (ids, generation)
}

/// Offers freed resources to waiters in order: each fully satisfiable head waiter gets a reservation.
fn promote_waiters(state: &mut State, now: i64) -> bool {
    let mut changed = false;
    for waiter in state.waiters.clone() {
        if !state.waiters.iter().any(|candidate| candidate.request_id == waiter.request_id) {
            continue;
        }
        if waiter.wait_until.is_some_and(|until| until < now) {
            state.waiters.retain(|candidate| candidate.request_id != waiter.request_id);
            event(state, now, EventType::ResourceBlocked, &format!("{} stopped waiting for {}: the wait timed out.", waiter.owner.session_key, waiter.reason), Extra::to(&waiter.owner.session_key));
            changed = true;
            continue;
        }
        let free = waiter.items.iter().all(|item| conflicting_claims(state, &waiter.owner, item).is_empty());
        if !free || !earlier_conflicting_waiters(state, &waiter.request_id, &waiter.owner, &waiter.items).is_empty() {
            continue;
        }
        let pending = Pending { request_id: &waiter.request_id, owner: &waiter.owner, items: &waiter.items, reason: &waiter.reason, lifetime: waiter.lifetime };
        let (ids, _) = grant(state, &pending, now, ClaimState::Reserved);
        event(
            state,
            now,
            EventType::ResourceAvailable,
            &format!("What {} was waiting for is reserved for it: start within {} s or it is offered to the next waiter.", waiter.owner.session_key, RESERVATION_MS / 1000),
            Extra::to(&waiter.owner.session_key).claims(ids),
        );
        changed = true;
    }
    changed
}

fn done(state: &mut State, result: CommandResult) -> Applied {
    state.revision += 1;
    Applied { result, changed: true }
}

fn list_claims(claims: &[Claim]) -> String {
    claims.iter().map(|claim| describe_resource(&claim.resource)).collect::<Vec<_>>().join(", ")
}

/// Applies one command to the state.
pub fn apply(state: &mut State, command: &Command, now: i64) -> Applied {
    match command {
        Command::Register { session } => {
            let existing = state.sessions.get(&session.session_key).cloned();
            if existing.is_none() && state.sessions.len() >= MAX_SESSIONS {
                return Applied::fail("Too many coordinated sessions; end idle ones first.");
            }
            // Re-registering (a resume, a compaction) refreshes identity and never clears live claims.
            let base = existing.clone();
            let merged = Session {
                session_key: session.session_key.clone(),
                runtime: session.runtime.clone(),
                coverage: session.coverage,
                parent_session_key: session.parent_session_key.clone().or_else(|| base.as_ref().and_then(|s| s.parent_session_key.clone())),
                scope: session.scope.clone().or_else(|| base.as_ref().and_then(|s| s.scope.clone())),
                worktree: session.worktree.clone().or_else(|| base.as_ref().and_then(|s| s.worktree.clone())),
                branch: session.branch.clone().or_else(|| base.as_ref().and_then(|s| s.branch.clone())),
                head: session.head.clone().or_else(|| base.as_ref().and_then(|s| s.head.clone())),
                activity: base.as_ref().and_then(|s| s.activity.clone()),
                state: SessionState::Active,
                registered_at: base.as_ref().map_or(now, |s| s.registered_at),
                heartbeat_at: now,
            };
            let key = merged.session_key.clone();
            let text = format!("{key} joined ({}, {}).", merged.runtime, coverage_word(merged.coverage));
            state.sessions.insert(key.clone(), merged);
            if existing.is_none() {
                event(state, now, EventType::Registered, &text, Extra::session(&key));
            }
            done(state, CommandResult::ok())
        }
        Command::Heartbeat { session_key } => {
            let Some(session) = state.sessions.get(session_key).cloned() else { return Applied::fail("Unknown session.") };
            for claim in &mut state.claims {
                if claim.owner.session_key == *session_key && claim.state != ClaimState::Reserved && claim.state != ClaimState::RecoveryRequired {
                    claim.lease_until = now + LEASE_MS;
                }
            }
            let next_state = if session.state == SessionState::Stale { SessionState::Active } else { session.state };
            state.sessions.insert(session_key.clone(), Session { heartbeat_at: now, state: next_state, ..session });
            done(state, CommandResult::ok())
        }
        Command::Activity { session_key, activity } => {
            let Some(session) = state.sessions.get(session_key).cloned() else { return Applied::fail("Unknown session.") };
            let activity = truncate(redact(activity), 300);
            state.sessions.insert(session_key.clone(), Session { activity: Some(activity.clone()), ..session });
            event(state, now, EventType::Activity, &format!("{session_key}: {activity}"), Extra::session(session_key));
            done(state, CommandResult::ok())
        }
        Command::Acquire { request_id, owner, items, reason, lifetime, wait } => acquire(state, request_id, owner, items, reason, *lifetime, wait, now),
        Command::Start { owner, claim_ids, generation } => {
            // A reservation becomes executing — only by its owner, only at the generation it was granted.
            let owned: Vec<&Claim> = state.claims.iter().filter(|claim| claim_ids.contains(&claim.claim_id) && same_owner(&claim.owner, owner)).collect();
            if owned.len() != claim_ids.len() {
                return Applied::fail("Those claims are not yours, or no longer exist: acquire again.");
            }
            if generation.is_some_and(|g| owned.iter().any(|claim| claim.generation != g)) {
                return Applied::fail("Those claims changed hands since they were granted: acquire again.");
            }
            let mut changed = false;
            for claim in &mut state.claims {
                if claim_ids.contains(&claim.claim_id) && same_owner(&claim.owner, owner) && claim.state == ClaimState::Reserved {
                    claim.state = ClaimState::Executing;
                    claim.lease_until = now + LEASE_MS;
                    changed = true;
                }
            }
            if changed { done(state, CommandResult::ok()) } else { Applied::unchanged(CommandResult::ok()) }
        }
        Command::Cleanup { owner, claim_ids } => {
            for claim in &mut state.claims {
                if claim_ids.contains(&claim.claim_id) && same_owner(&claim.owner, owner) && claim.state == ClaimState::Executing {
                    claim.state = ClaimState::CleaningUp;
                }
            }
            done(state, CommandResult::ok())
        }
        Command::Release { owner, claim_ids, request_id } => {
            let releasing: Vec<Claim> = state
                .claims
                .iter()
                .filter(|claim| {
                    same_owner(&claim.owner, owner)
                        && claim.state != ClaimState::RecoveryRequired
                        && match (claim_ids, request_id) {
                            (Some(ids), _) => ids.contains(&claim.claim_id),
                            (None, Some(request)) => claim.request_id == *request,
                            (None, None) => false,
                        }
                })
                .cloned()
                .collect();
            if releasing.is_empty() {
                return Applied::unchanged(CommandResult::ok());
            }
            let gone: Vec<&str> = releasing.iter().map(|claim| claim.claim_id.as_str()).collect();
            state.claims.retain(|claim| !gone.contains(&claim.claim_id.as_str()));
            event(state, now, EventType::ResourceReleased, &format!("{} released {}.", owner.session_key, list_claims(&releasing)), Extra::session(&owner.session_key).claims(releasing.iter().map(|c| c.claim_id.clone()).collect()));
            promote_waiters(state, now);
            done(state, CommandResult::ok())
        }
        Command::Cancel { owner, request_id } => {
            if !state.waiters.iter().any(|candidate| candidate.request_id == *request_id && same_owner(&candidate.owner, owner)) {
                return Applied::unchanged(CommandResult::ok());
            }
            state.waiters.retain(|candidate| !(candidate.request_id == *request_id && same_owner(&candidate.owner, owner)));
            promote_waiters(state, now);
            done(state, CommandResult::ok())
        }
        Command::EndTurn { owner, summary } => {
            let ending = |claim: &Claim| {
                claim.owner.session_key == owner.session_key
                    && owner.turn_id.as_ref().is_none_or(|turn| claim.owner.turn_id.as_ref() == Some(turn))
                    && claim.lifetime != Lifetime::Service
                    && claim.state != ClaimState::RecoveryRequired
            };
            let released: Vec<Claim> = state.claims.iter().filter(|claim| ending(claim)).cloned().collect();
            state.claims.retain(|claim| !ending(claim));
            state.waiters.retain(|waiter| !(waiter.owner.session_key == owner.session_key && owner.turn_id.as_ref().is_none_or(|turn| waiter.owner.turn_id.as_ref() == Some(turn))));
            if let Some(session) = state.sessions.get_mut(&owner.session_key) {
                session.state = SessionState::Idle;
                session.heartbeat_at = now;
            }
            if summary.is_some() || !released.is_empty() {
                let releasing = if released.is_empty() { String::new() } else { format!(", releasing {} claim{}", released.len(), if released.len() == 1 { "" } else { "s" }) };
                let tail = summary.as_ref().map_or_else(|| ".".to_owned(), |s| format!(": {s}"));
                event(state, now, EventType::Done, &format!("{} finished a turn{releasing}{tail}", owner.session_key), Extra::session(&owner.session_key).claims(released.iter().map(|c| c.claim_id.clone()).collect()));
            }
            promote_waiters(state, now);
            done(state, CommandResult::ok())
        }
        Command::EndSession { session_key, summary } => {
            if !state.sessions.contains_key(session_key) {
                return Applied::unchanged(CommandResult::ok());
            }
            // An executing claim at session end has no proof its work stopped: it waits for recovery.
            state.claims.retain(|claim| {
                claim.owner.session_key != *session_key
                    || matches!(claim.state, ClaimState::Executing | ClaimState::CleaningUp | ClaimState::RecoveryRequired)
                    || claim.lifetime == Lifetime::Service
            });
            for claim in &mut state.claims {
                if claim.owner.session_key == *session_key && matches!(claim.state, ClaimState::Executing | ClaimState::CleaningUp) {
                    claim.state = ClaimState::RecoveryRequired;
                }
            }
            state.waiters.retain(|waiter| waiter.owner.session_key != *session_key);
            if let Some(session) = state.sessions.get_mut(session_key) {
                session.state = SessionState::Ended;
                session.heartbeat_at = now;
            }
            let tail = summary.as_ref().map_or_else(|| ".".to_owned(), |s| format!(": {s}"));
            event(state, now, EventType::Done, &format!("{session_key} ended{tail}"), Extra::session(session_key));
            promote_waiters(state, now);
            done(state, CommandResult::ok())
        }
        Command::Delegate { owner, claim_id, to } => {
            let Some(claim) = state.claims.iter().find(|candidate| candidate.claim_id == *claim_id).cloned().filter(|claim| same_owner(&claim.owner, owner)) else {
                return Applied::fail("Only the owner of a claim can delegate it.");
            };
            if claim.state == ClaimState::RecoveryRequired {
                return Applied::fail("A claim awaiting recovery cannot be delegated.");
            }
            if !state.sessions.contains_key(&to.session_key) {
                return Applied::fail("The delegate is not a registered session.");
            }
            // The child owns it alone from here; the parent's access is suspended, not shared.
            let generation = state.revision + 1;
            if let Some(target) = state.claims.iter_mut().find(|candidate| candidate.claim_id == *claim_id) {
                target.owner = to.clone();
                target.generation = generation;
            }
            event(
                state,
                now,
                EventType::Delegated,
                &format!("{} handed {} to {}.", owner.session_key, describe_resource(&claim.resource), to.session_key),
                Extra { session_key: Some(owner.session_key.clone()), to_session_key: Some(to.session_key.clone()), claim_ids: Some(vec![claim.claim_id.clone()]), needs_ack: false },
            );
            done(state, CommandResult::ok())
        }
        Command::Recover { claim_id, actor, note } => {
            let Some(claim) = state.claims.iter().find(|candidate| candidate.claim_id == *claim_id).cloned() else { return Applied::unchanged(CommandResult::ok()) };
            if claim.state != ClaimState::RecoveryRequired {
                return Applied::fail("Only a claim awaiting recovery can be recovered; its owner releases it otherwise.");
            }
            if actor.trim().is_empty() || note.trim().is_empty() {
                return Applied::fail("Recovery must record who confirmed the work stopped, and how.");
            }
            state.claims.retain(|candidate| candidate.claim_id != claim.claim_id);
            event(
                state,
                now,
                EventType::Recovered,
                &format!("{actor} confirmed {} is free (was {}'s): {note}", describe_resource(&claim.resource), claim.owner.session_key),
                Extra { claim_ids: Some(vec![claim.claim_id.clone()]), ..Extra::default() },
            );
            promote_waiters(state, now);
            done(state, CommandResult::ok())
        }
        Command::Takeover { request_id, session_key, items, reason } => {
            if !state.sessions.contains_key(session_key) {
                return Applied::fail("Register the session before taking over.");
            }
            if items.is_empty() || !items.iter().all(takeover_kind) {
                return Applied::fail("Only the in-app browser, the live app or the desktop can be taken over; anything else is released by its owner.");
            }
            let owner = Owner::session(session_key.clone());
            // Already the person's: a repeated input refreshes nothing and says nothing.
            if state.claims.iter().any(|claim| claim.request_id == *request_id) {
                return Applied::unchanged(CommandResult::ok());
            }
            let displaced: Vec<Claim> = state
                .claims
                .iter()
                .filter(|claim| !same_owner(&claim.owner, &owner) && items.iter().any(|item| claims_conflict((&claim.resource, claim.mode), (&item.resource, item.mode))))
                .cloned()
                .collect();
            let gone: Vec<&str> = displaced.iter().map(|claim| claim.claim_id.as_str()).collect();
            state.claims.retain(|claim| !gone.contains(&claim.claim_id.as_str()));
            let mut losers: Vec<&str> = Vec::new();
            for claim in &displaced {
                if !losers.contains(&claim.owner.session_key.as_str()) {
                    losers.push(&claim.owner.session_key);
                }
            }
            for loser in losers {
                let mine: Vec<&Claim> = displaced.iter().filter(|claim| claim.owner.session_key == loser).collect();
                let what = mine.iter().map(|claim| describe_resource(&claim.resource)).collect::<Vec<_>>().join(", ");
                event(
                    state,
                    now,
                    EventType::TakenOver,
                    &format!("A person took over {what} from {loser}. Anything {loser} saw there is out of date; it must not act on it again until it is handed back."),
                    Extra { session_key: Some(session_key.clone()), to_session_key: Some(loser.to_owned()), claim_ids: Some(mine.iter().map(|c| c.claim_id.clone()).collect()), needs_ack: false },
                );
            }
            let pending = Pending { request_id, owner: &owner, items, reason, lifetime: Lifetime::Sequence };
            let (ids, generation) = grant(state, &pending, now, ClaimState::Executing);
            done(state, CommandResult::with_acquire(AcquireResult::Granted { claim_ids: ids, generation }))
        }
        Command::Message { from, to, text, needs_ack } => {
            if !state.sessions.contains_key(from) {
                return Applied::fail("Unknown session.");
            }
            if text.trim().is_empty() {
                return Applied::fail("A message needs text.");
            }
            if text.chars().count() > MAX_MESSAGE_CHARS {
                return Applied::fail(format!("Messages are limited to {MAX_MESSAGE_CHARS} characters."));
            }
            event(state, now, EventType::Message, text, Extra { session_key: Some(from.clone()), to_session_key: to.clone(), claim_ids: None, needs_ack: needs_ack.unwrap_or(false) });
            let sequence = state.sequence;
            let mut result = CommandResult::ok();
            result.sequence = Some(sequence);
            done(state, result)
        }
        Command::Ack { session_key, sequence } => {
            for candidate in &mut state.events {
                if candidate.sequence == *sequence && candidate.needs_ack == Some(true) {
                    let acked = candidate.acked_by.get_or_insert_with(Vec::new);
                    if !acked.contains(session_key) {
                        acked.push(session_key.clone());
                    }
                }
            }
            event(state, now, EventType::Acknowledged, &format!("{session_key} acknowledged message {sequence}."), Extra::session(session_key));
            done(state, CommandResult::ok())
        }
        Command::Suspended { paused_ms } => {
            let paused = paused_ms.round().max(0.0) as i64;
            if paused == 0 {
                return Applied::unchanged(CommandResult::ok());
            }
            for claim in &mut state.claims {
                if claim.state != ClaimState::RecoveryRequired {
                    claim.lease_until += paused;
                }
            }
            for session in state.sessions.values_mut() {
                if session.state != SessionState::Ended {
                    session.heartbeat_at += paused;
                }
            }
            for waiter in &mut state.waiters {
                if let Some(until) = waiter.wait_until.as_mut() {
                    *until += paused;
                }
            }
            event(
                state,
                now,
                EventType::Activity,
                &format!("Coordination was paused for {} s (the machine slept or the broker was stopped); leases were extended by that much rather than expired.", (paused as f64 / 1000.0).round() as i64),
                Extra::default(),
            );
            done(state, CommandResult::ok())
        }
        Command::Tick => tick(state, now),
    }
}

fn coverage_word(coverage: super::types::Coverage) -> &'static str {
    match coverage {
        super::types::Coverage::Enforced => "enforced",
        super::types::Coverage::Cooperative => "cooperative",
        super::types::Coverage::Observed => "observed",
    }
}

#[allow(clippy::too_many_arguments)]
fn acquire(state: &mut State, request_id: &str, owner: &Owner, items: &[RequestItem], reason: &str, lifetime: Lifetime, wait: &Wait, now: i64) -> Applied {
    if !state.sessions.contains_key(&owner.session_key) {
        return Applied::fail("Register the session before acquiring.");
    }
    if items.is_empty() {
        return Applied::fail("A request must name at least one resource.");
    }
    // Idempotent: the same request id returns what it already has.
    let held: Vec<&Claim> = state.claims.iter().filter(|claim| claim.request_id == request_id).collect();
    if let Some(first) = held.first() {
        return Applied::unchanged(CommandResult::with_acquire(AcquireResult::Granted { claim_ids: held.iter().map(|c| c.claim_id.clone()).collect(), generation: first.generation }));
    }
    if let Some(queued_at) = state.waiters.iter().position(|waiter| waiter.request_id == request_id) {
        return Applied::unchanged(CommandResult::with_acquire(AcquireResult::Queued { position: queued_at + 1, blockers: blockers_for(state, owner, items) }));
    }

    let blockers = blockers_for(state, owner, items);
    let ahead = earlier_conflicting_waiters(state, request_id, owner, items);
    if blockers.is_empty() && ahead.is_empty() {
        // Granted straight away to a requester about to act: it is executing from the start.
        let pending = Pending { request_id, owner, items, reason, lifetime };
        let (claim_ids, generation) = grant(state, &pending, now, ClaimState::Executing);
        return done(state, CommandResult::with_acquire(AcquireResult::Granted { claim_ids, generation }));
    }
    let no_wait = matches!(wait, Wait::Flag(false));
    if no_wait {
        let why = if blockers.is_empty() {
            "Busy: an earlier request is waiting for the same resources.".to_owned()
        } else {
            format!("Busy: {}.", blockers.iter().map(|b| format!("{} is held by {} ({})", describe_resource(&b.resource), b.owner_session_key, b.reason)).collect::<Vec<_>>().join("; "))
        };
        event(state, now, EventType::ResourceBlocked, &format!("{} was refused: {why}", owner.session_key), Extra::session(&owner.session_key));
        return done(state, CommandResult::with_acquire(AcquireResult::Blocked { blockers, reason: why }));
    }
    // Refuse a wait that would close a cycle: a holder is (transitively) waiting on the requester.
    let mut holders: Vec<Owner> = items.iter().flat_map(|item| conflicting_claims(state, owner, item).into_iter().map(|claim| claim.owner)).collect();
    holders.extend(ahead.into_iter().map(|waiter| waiter.owner));
    for holder in holders {
        let mut seen = HashSet::new();
        waits_on(state, &owner_key(&holder), &mut seen);
        if seen.contains(&owner_key(owner)) {
            let why = format!(
                "Waiting would deadlock: {} is waiting on what {} holds. Release it, or restructure the work so the two do not wait on each other.",
                holder.session_key, owner.session_key
            );
            event(state, now, EventType::ResourceBlocked, &why, Extra::session(&owner.session_key));
            return done(state, CommandResult::with_acquire(AcquireResult::Blocked { blockers, reason: why }));
        }
    }
    if state.waiters.len() >= MAX_WAITERS {
        return Applied::fail("Too many waiting requests; try again later.");
    }
    let wait_until = match wait {
        Wait::Bounded { for_ms: Some(ms), .. } => Some(now + ms),
        Wait::Bounded { until_ms, .. } => *until_ms,
        Wait::Flag(_) => None,
    };
    state.waiters.push(Request { request_id: request_id.to_owned(), owner: owner.clone(), items: items.to_vec(), reason: reason.to_owned(), lifetime, enqueued_at: now, wait_until });
    event(state, now, EventType::ResourceBlocked, &format!("{} is waiting: {reason}", owner.session_key), Extra::session(&owner.session_key));
    let position = state.waiters.len();
    done(state, CommandResult::with_acquire(AcquireResult::Queued { position, blockers }))
}

fn tick(state: &mut State, now: i64) -> Applied {
    let mut changed = false;
    // Reservations that lapsed: nothing started, so they are simply dropped and re-offered.
    let lapsed: Vec<Claim> = state.claims.iter().filter(|claim| claim.state == ClaimState::Reserved && claim.lease_until < now).cloned().collect();
    if !lapsed.is_empty() {
        changed = true;
        state.claims.retain(|claim| !lapsed.iter().any(|gone| gone.claim_id == claim.claim_id));
        let what = lapsed.iter().map(|claim| format!("{} ({})", describe_resource(&claim.resource), claim.owner.session_key)).collect::<Vec<_>>().join(", ");
        event(state, now, EventType::ResourceReleased, &format!("Unused reservations lapsed: {what}."), Extra { claim_ids: Some(lapsed.iter().map(|c| c.claim_id.clone()).collect()), ..Extra::default() });
    }
    // Executing claims whose owner went silent: blocked for recovery, never reassigned.
    let silent: Vec<Claim> = state.claims.iter().filter(|claim| matches!(claim.state, ClaimState::Executing | ClaimState::CleaningUp) && claim.lease_until < now).cloned().collect();
    if !silent.is_empty() {
        changed = true;
        for claim in &mut state.claims {
            if silent.iter().any(|s| s.claim_id == claim.claim_id) {
                claim.state = ClaimState::RecoveryRequired;
            }
        }
        let what = silent.iter().map(|claim| format!("{} ({})", describe_resource(&claim.resource), claim.owner.session_key)).collect::<Vec<_>>().join(", ");
        event(
            state,
            now,
            EventType::RecoveryRequired,
            &format!("No heartbeat from the owner of {what}: blocked until someone confirms the work stopped."),
            Extra { claim_ids: Some(silent.iter().map(|c| c.claim_id.clone()).collect()), ..Extra::default() },
        );
    }
    for session in state.sessions.values().cloned().collect::<Vec<_>>() {
        if session.state == SessionState::Active && now - session.heartbeat_at > SESSION_STALE_MS {
            changed = true;
            if let Some(live) = state.sessions.get_mut(&session.session_key) {
                live.state = SessionState::Stale;
            }
            event(state, now, EventType::Stale, &format!("{} has stopped responding.", session.session_key), Extra::session(&session.session_key));
        }
        if session.state == SessionState::Ended && now - session.heartbeat_at > ENDED_RETENTION_MS && !state.claims.iter().any(|claim| claim.owner.session_key == session.session_key) {
            changed = true;
            state.sessions.remove(&session.session_key);
        }
    }
    if promote_waiters(state, now) {
        changed = true;
    }
    if changed { done(state, CommandResult::ok()) } else { Applied::unchanged(CommandResult::ok()) }
}

/// What one session may see: its scope's sessions and claims, messages to it or its scope.
/// With `since_sequence`, only the events after it — and `resync: true` when some of those were
/// already trimmed, so the reader knows its delta has a gap and takes the snapshot as a whole.
pub fn scoped_snapshot(state: &State, session_key: &str, since_sequence: i64) -> Value {
    let scope = state.sessions.get(session_key).and_then(|s| s.scope.clone());
    let oldest = state.events.first().map(|e| e.sequence);
    let visible = |key: Option<&str>| match key {
        None => true,
        Some(key) => key == session_key || scope.is_none() || state.sessions.get(key).and_then(|s| s.scope.as_deref()) == scope.as_deref(),
    };
    let claims: Vec<Value> = state
        .claims
        .iter()
        .map(|claim| {
            if visible(Some(&claim.owner.session_key)) {
                json!(claim)
            } else {
                let mut redacted = json!(claim);
                redacted["owner"] = json!({ "sessionKey": "another project" });
                redacted["reason"] = json!("in use");
                redacted["requestId"] = json!("");
                redacted
            }
        })
        .collect();
    let events: Vec<&Event> = state
        .events
        .iter()
        .filter(|entry| entry.sequence > since_sequence && visible(entry.session_key.as_deref()) && (entry.to_session_key.as_deref().is_none_or(|to| to == session_key) || entry.session_key.as_deref() == Some(session_key)))
        .collect();
    json!({
        "schemaVersion": state.schema_version,
        "epoch": state.epoch,
        "revision": state.revision,
        "sessions": state.sessions.values().filter(|s| visible(Some(&s.session_key))).collect::<Vec<_>>(),
        "claims": claims,
        "waiters": state.waiters.iter().filter(|w| visible(Some(&w.owner.session_key))).collect::<Vec<_>>(),
        "events": events,
        "lastSequence": state.sequence,
        "resync": since_sequence > 0 && (since_sequence > state.sequence || oldest.is_some_and(|o| o > since_sequence + 1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::types::{ClaimMode, Coverage, Registration, Resource};

    fn file(path: &str) -> RequestItem {
        RequestItem { resource: Resource::File { worktree: "/repo".into(), path: path.into() }, mode: ClaimMode::Exclusive }
    }

    fn register(state: &mut State, key: &str, scope: Option<&str>, now: i64) {
        let command = Command::Register {
            session: Registration { session_key: key.into(), runtime: "gateway".into(), coverage: Coverage::Enforced, parent_session_key: None, scope: scope.map(str::to_owned), worktree: None, branch: None, head: None },
        };
        assert!(apply(state, &command, now).result.ok);
    }

    fn acquire_cmd(id: &str, key: &str, items: Vec<RequestItem>, wait: Wait) -> Command {
        Command::Acquire { request_id: id.into(), owner: Owner::session(key), items, reason: "editing".into(), lifetime: Lifetime::Sequence, wait }
    }

    fn run(state: &mut State, command: Command, now: i64) -> CommandResult {
        apply(state, &command, now).result
    }

    fn status(result: &CommandResult) -> &AcquireResult {
        result.acquire.as_ref().expect("an acquire result")
    }

    fn two_sessions() -> State {
        let mut state = empty_state("e1");
        register(&mut state, "A", Some("repo"), 0);
        register(&mut state, "B", Some("repo"), 0);
        state
    }

    #[test]
    fn a_free_resource_is_granted_straight_away_as_executing() {
        let mut state = two_sessions();
        let result = run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        assert!(matches!(status(&result), AcquireResult::Granted { claim_ids, .. } if claim_ids == &["a1#0".to_owned()]));
        assert_eq!(state.claims[0].state, ClaimState::Executing);
    }

    #[test]
    fn a_held_resource_refuses_the_second_session_and_names_the_holder() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        let result = run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::never()), 11);
        let AcquireResult::Blocked { reason, blockers } = status(&result) else { panic!("expected blocked") };
        assert!(reason.contains("file x.rs is held by A (editing)"), "{reason}");
        assert_eq!(blockers.len(), 1);
    }

    #[test]
    fn acquiring_is_all_or_none() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("held.rs")], Wait::never()), 10);
        let result = run(&mut state, acquire_cmd("b1", "B", vec![file("free.rs"), file("held.rs")], Wait::never()), 11);
        assert!(matches!(status(&result), AcquireResult::Blocked { .. }));
        assert_eq!(state.claims.len(), 1, "nothing of the refused request was granted");
    }

    #[test]
    fn a_repeated_request_id_returns_the_same_grant() {
        let mut state = two_sessions();
        let first = run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        let revision = state.revision;
        let again = run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 11);
        assert_eq!(first, again);
        assert_eq!(state.revision, revision);
        assert_eq!(state.claims.len(), 1);
    }

    #[test]
    fn acquiring_needs_a_registered_session() {
        let mut state = empty_state("e");
        let result = run(&mut state, acquire_cmd("x", "ghost", vec![file("a")], Wait::never()), 1);
        assert_eq!(result.error_text(), "Register the session before acquiring.");
    }

    #[test]
    fn a_waiter_is_offered_the_resource_when_it_is_released() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        let queued = run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::for_ms(60_000)), 11);
        assert!(matches!(status(&queued), AcquireResult::Queued { position: 1, .. }));

        run(&mut state, Command::Release { owner: Owner::session("A"), claim_ids: None, request_id: Some("a1".into()) }, 20);
        // Offered as a reservation, not handed over as executing.
        assert_eq!(state.claims.len(), 1);
        assert_eq!(state.claims[0].owner.session_key, "B");
        assert_eq!(state.claims[0].state, ClaimState::Reserved);
        assert!(state.waiters.is_empty());
        assert_eq!(state.events.iter().filter(|e| e.kind == EventType::ResourceAvailable).count(), 1);

        // Asking again by the same id reports the grant; starting makes it executing.
        let again = run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::never()), 21);
        let AcquireResult::Granted { claim_ids, generation } = status(&again).clone() else { panic!("granted") };
        let started = run(&mut state, Command::Start { owner: Owner::session("B"), claim_ids, generation: Some(generation) }, 22);
        assert!(started.ok);
        assert_eq!(state.claims[0].state, ClaimState::Executing);
    }

    #[test]
    fn a_request_queues_behind_an_earlier_conflicting_waiter_even_if_the_resource_is_free() {
        let mut state = two_sessions();
        register(&mut state, "C", Some("repo"), 0);
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs"), file("y.rs")], Wait::for_ms(60_000)), 11);
        // y.rs is free, but B is ahead of C for it.
        let c = run(&mut state, acquire_cmd("c1", "C", vec![file("y.rs")], Wait::never()), 12);
        let AcquireResult::Blocked { reason, .. } = status(&c) else { panic!("blocked") };
        assert!(reason.contains("an earlier request is waiting"), "{reason}");
    }

    #[test]
    fn a_wait_that_would_deadlock_is_refused() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("a.rs")], Wait::never()), 10);
        run(&mut state, acquire_cmd("b1", "B", vec![file("b.rs")], Wait::never()), 10);
        run(&mut state, acquire_cmd("a2", "A", vec![file("b.rs")], Wait::for_ms(60_000)), 11);
        let result = run(&mut state, acquire_cmd("b2", "B", vec![file("a.rs")], Wait::for_ms(60_000)), 12);
        let AcquireResult::Blocked { reason, .. } = status(&result) else { panic!("blocked") };
        assert!(reason.starts_with("Waiting would deadlock"), "{reason}");
        assert_eq!(state.waiters.len(), 1);
    }

    #[test]
    fn a_wait_times_out_on_the_brokers_clock() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::for_ms(1000)), 11);
        run(&mut state, Command::Tick, 5000);
        assert!(state.waiters.is_empty());
        assert!(state.events.iter().any(|e| e.kind == EventType::ResourceBlocked && e.text.contains("the wait timed out")));
    }

    #[test]
    fn an_ended_session_with_an_executing_claim_waits_for_recovery_and_stays_blocking() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        run(&mut state, Command::EndSession { session_key: "A".into(), summary: None }, 11);
        assert_eq!(state.claims[0].state, ClaimState::RecoveryRequired);
        let b = run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::never()), 12);
        assert!(matches!(status(&b), AcquireResult::Blocked { .. }));

        // The owner cannot release a claim that awaits recovery; a person recovers it.
        run(&mut state, Command::Release { owner: Owner::session("A"), claim_ids: None, request_id: Some("a1".into()) }, 13);
        assert_eq!(state.claims.len(), 1);
        let recovered = run(&mut state, Command::Recover { claim_id: "a1#0".into(), actor: "you, in Praxis".into(), note: "confirmed".into() }, 14);
        assert!(recovered.ok);
        assert!(state.claims.is_empty());
        assert!(state.events.iter().any(|e| e.kind == EventType::Recovered && e.text.contains("you, in Praxis")));
    }

    #[test]
    fn recovery_needs_a_claim_awaiting_it_and_a_note() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 10);
        let not_yet = run(&mut state, Command::Recover { claim_id: "a1#0".into(), actor: "p".into(), note: "n".into() }, 11);
        assert!(!not_yet.ok);
        run(&mut state, Command::EndSession { session_key: "A".into(), summary: None }, 12);
        let blank = run(&mut state, Command::Recover { claim_id: "a1#0".into(), actor: "p".into(), note: " ".into() }, 13);
        assert!(!blank.ok);
        assert!(run(&mut state, Command::Recover { claim_id: "missing".into(), actor: "p".into(), note: "n".into() }, 14).ok);
    }

    #[test]
    fn a_silent_owner_is_sent_to_recovery_and_a_lapsed_reservation_is_dropped() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        run(&mut state, Command::Tick, LEASE_MS + 1);
        assert_eq!(state.claims[0].state, ClaimState::RecoveryRequired);

        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::for_ms(10_000_000)), 1);
        run(&mut state, Command::Release { owner: Owner::session("A"), claim_ids: None, request_id: Some("a1".into()) }, 2);
        assert_eq!(state.claims[0].state, ClaimState::Reserved);
        run(&mut state, Command::Tick, RESERVATION_MS + 10);
        assert!(state.claims.is_empty(), "nothing started, so the reservation just lapses");
    }

    #[test]
    fn a_heartbeat_extends_executing_leases_only() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        run(&mut state, Command::Heartbeat { session_key: "A".into() }, 60_000);
        assert_eq!(state.claims[0].lease_until, 60_000 + LEASE_MS);
        assert!(!run(&mut state, Command::Heartbeat { session_key: "nobody".into() }, 1).ok);
    }

    #[test]
    fn a_suspended_broker_extends_leases_instead_of_expiring_them() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        run(&mut state, Command::Suspended { paused_ms: 600_000.0 }, 600_000);
        run(&mut state, Command::Tick, 600_000 + 1000);
        assert_eq!(state.claims[0].state, ClaimState::Executing);
    }

    #[test]
    fn ending_a_turn_releases_its_claims_but_not_a_service() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        let service = Command::Acquire {
            request_id: "svc".into(),
            owner: Owner::session("A"),
            items: vec![RequestItem { resource: Resource::Process { host: "h".into(), pgid: 7 }, mode: ClaimMode::Exclusive }],
            reason: "server".into(),
            lifetime: Lifetime::Service,
            wait: Wait::never(),
        };
        run(&mut state, service, 1);
        run(&mut state, Command::EndTurn { owner: Owner::session("A"), summary: None }, 2);
        assert_eq!(state.claims.len(), 1);
        assert_eq!(state.claims[0].request_id, "svc");
        assert_eq!(state.sessions["A"].state, SessionState::Idle);
    }

    #[test]
    fn a_person_takes_a_browser_from_an_agent_and_nothing_else() {
        let mut state = two_sessions();
        register(&mut state, "person:1", None, 0);
        let browser = RequestItem { resource: Resource::Browser { surface: "in-app:1".into() }, mode: ClaimMode::Exclusive };
        run(&mut state, acquire_cmd("agent-browser", "A", vec![browser.clone()], Wait::never()), 1);
        let taken = run(&mut state, Command::Takeover { request_id: "p1".into(), session_key: "person:1".into(), items: vec![browser.clone()], reason: "a person".into() }, 2);
        assert!(taken.ok);
        assert_eq!(state.claims.len(), 1);
        assert_eq!(state.claims[0].owner.session_key, "person:1");
        let event = state.events.iter().find(|e| e.kind == EventType::TakenOver).expect("taken-over");
        assert_eq!(event.to_session_key.as_deref(), Some("A"));
        // The agent is refused until the person lets go.
        let again = run(&mut state, acquire_cmd("agent-browser-2", "A", vec![browser], Wait::never()), 3);
        assert!(matches!(status(&again), AcquireResult::Blocked { .. }));
        // A repeated input changes nothing.
        let revision = state.revision;
        let item = RequestItem { resource: Resource::Browser { surface: "in-app:1".into() }, mode: ClaimMode::Exclusive };
        run(&mut state, Command::Takeover { request_id: "p1".into(), session_key: "person:1".into(), items: vec![item], reason: "x".into() }, 4);
        assert_eq!(state.revision, revision);
        // Files cannot be taken.
        let refused = run(&mut state, Command::Takeover { request_id: "p2".into(), session_key: "person:1".into(), items: vec![file("x.rs")], reason: "x".into() }, 5);
        assert!(!refused.ok);
    }

    #[test]
    fn delegation_moves_a_claim_to_a_registered_child_only() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 0);
        assert!(!run(&mut state, Command::Delegate { owner: Owner::session("A"), claim_id: "a1#0".into(), to: Owner::session("ghost") }, 1).ok);
        assert!(!run(&mut state, Command::Delegate { owner: Owner::session("B"), claim_id: "a1#0".into(), to: Owner::session("A") }, 1).ok);
        assert!(run(&mut state, Command::Delegate { owner: Owner::session("A"), claim_id: "a1#0".into(), to: Owner::session("B") }, 2).ok);
        assert_eq!(state.claims[0].owner.session_key, "B");
    }

    #[test]
    fn messages_are_acknowledged_by_number() {
        let mut state = two_sessions();
        let sent = run(&mut state, Command::Message { from: "A".into(), to: Some("B".into()), text: "hand-off".into(), needs_ack: Some(true) }, 1);
        let sequence = sent.sequence.expect("sequence");
        run(&mut state, Command::Ack { session_key: "B".into(), sequence }, 2);
        let message = state.events.iter().find(|e| e.sequence == sequence).expect("message");
        assert_eq!(message.acked_by.as_deref(), Some(&["B".to_owned()][..]));
        assert!(!run(&mut state, Command::Message { from: "A".into(), to: None, text: "  ".into(), needs_ack: None }, 3).ok);
        assert!(!run(&mut state, Command::Message { from: "ghost".into(), to: None, text: "hi".into(), needs_ack: None }, 3).ok);
    }

    #[test]
    fn secrets_are_redacted_from_reasons_and_events() {
        let mut state = two_sessions();
        let command = Command::Acquire {
            request_id: "a1".into(),
            owner: Owner::session("A"),
            items: vec![file("x.rs")],
            reason: "deploy with token=abc123secret now".into(),
            lifetime: Lifetime::Tool,
            wait: Wait::never(),
        };
        run(&mut state, command, 0);
        assert!(!state.claims[0].reason.contains("abc123secret"));
        assert!(state.events.iter().all(|e| !e.text.contains("abc123secret")));
    }

    #[test]
    fn another_projects_claims_are_redacted_to_busy() {
        let mut state = empty_state("e");
        register(&mut state, "A", Some("repo-one"), 0);
        register(&mut state, "B", Some("repo-two"), 0);
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 1);
        let b = run(&mut state, acquire_cmd("b1", "B", vec![file("x.rs")], Wait::never()), 2);
        let AcquireResult::Blocked { blockers, .. } = status(&b) else { panic!("blocked") };
        assert!(blockers[0].redacted);
        assert_eq!(blockers[0].owner_session_key, "another project");
        let view = scoped_snapshot(&state, "B", 0);
        assert_eq!(view["claims"][0]["owner"]["sessionKey"], "another project");
        assert_eq!(view["sessions"].as_array().expect("sessions").len(), 1);
    }

    #[test]
    fn a_delta_read_reports_a_gap_when_events_were_trimmed() {
        let mut state = two_sessions();
        for n in 0..(MAX_EVENTS + 20) {
            run(&mut state, Command::Activity { session_key: "A".into(), activity: format!("step {n}") }, n as i64);
        }
        assert_eq!(state.events.len(), MAX_EVENTS);
        assert_eq!(scoped_snapshot(&state, "A", 1)["resync"], true);
        let last = state.sequence;
        assert_eq!(scoped_snapshot(&state, "A", last)["resync"], false);
        assert_eq!(scoped_snapshot(&state, "A", last)["events"].as_array().expect("events").len(), 0);
    }

    #[test]
    fn commands_round_trip_the_wire_json() {
        let wire = r#"{"kind":"acquire","requestId":"other-1","owner":{"sessionKey":"OTHER-SESSION"},"items":[{"resource":{"kind":"file","worktree":"/r","path":"sum.js"},"mode":"exclusive"}],"reason":"refactoring sum.js","lifetime":"sequence","wait":false}"#;
        let command: Command = serde_json::from_str(wire).expect("parses");
        assert!(matches!(&command, Command::Acquire { wait: Wait::Flag(false), .. }));
        let bounded: Command = serde_json::from_str(r#"{"kind":"acquire","requestId":"r","owner":{"sessionKey":"s"},"items":[],"reason":"","lifetime":"tool","wait":{"forMs":500}}"#).expect("parses");
        assert!(matches!(bounded, Command::Acquire { wait: Wait::Bounded { for_ms: Some(500), .. }, .. }));
        let register: Command = serde_json::from_str(r#"{"kind":"register","session":{"sessionKey":"S","runtime":"gateway","coverage":"enforced","scope":"/r/.git","worktree":"/r"}}"#).expect("parses");
        assert!(matches!(register, Command::Register { .. }));
        let end: Command = serde_json::from_str(r#"{"kind":"end-session","sessionKey":"S"}"#).expect("parses");
        assert!(matches!(end, Command::EndSession { .. }));
        let result = serde_json::to_value(CommandResult::with_acquire(AcquireResult::Granted { claim_ids: vec!["a#0".into()], generation: 3 })).expect("serialises");
        assert_eq!(result, json!({ "ok": true, "acquire": { "status": "granted", "claimIds": ["a#0"], "generation": 3 } }));
    }

    #[test]
    fn state_serialises_with_the_wire_names() {
        let mut state = two_sessions();
        run(&mut state, acquire_cmd("a1", "A", vec![file("x.rs")], Wait::never()), 5);
        let value = serde_json::to_value(&state).expect("serialises");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["claims"][0]["state"], "executing");
        assert_eq!(value["claims"][0]["resource"]["kind"], "file");
        assert_eq!(value["events"][2]["type"], "resource-acquired");
        assert!(value["sessions"]["A"].is_object());
        let back: State = serde_json::from_value(value).expect("round trips");
        assert_eq!(back, state);
    }
}
