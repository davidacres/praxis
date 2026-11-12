//! The shapes the coordination broker speaks. Field names and tags match the JSON the
//! TypeScript broker wrote and read, so a state file and the local socket protocol are
//! interchangeable between the two.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// Something a session can own. Paths are canonical and relative to their worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Resource {
    File {
        worktree: String,
        path: String,
    },
    Directory {
        worktree: String,
        path: String,
    },
    /// Arbitrary edits whose files cannot be named (a shell command). Shared mode = a stable read.
    Worktree {
        worktree: String,
    },
    /// Branch checkout, reset or rebase: everything in the worktree.
    Checkout {
        worktree: String,
    },
    /// Staging and committing in one worktree's index.
    GitIndex {
        worktree: String,
    },
    /// One live app instance, for a whole interaction sequence.
    AppUi {
        instance: String,
    },
    /// One in-app browser surface, for a whole navigate/inspect sequence.
    Browser {
        surface: String,
    },
    /// The machine's global focus, mouse and keyboard.
    Desktop,
    /// A build output directory; shared mode = tests consuming it.
    BuildOutput {
        dir: String,
    },
    Port {
        port: u32,
    },
    Fixture {
        id: String,
    },
    /// A process group a session started that outlived its tool call (a dev server, a watcher).
    Process {
        host: String,
        pgid: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimMode {
    Exclusive,
    Shared,
}

/// `tool` ends with one tool call, `sequence` spans several, `turn` ends with the turn,
/// `service` outlives it and is released only explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lifetime {
    Tool,
    Sequence,
    Turn,
    Service,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimState {
    Reserved,
    Executing,
    CleaningUp,
    RecoveryRequired,
}

/// Who owns a claim. `execution_id` separates a native subagent from its parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}

impl Owner {
    pub fn session(key: impl Into<String>) -> Self {
        Self {
            session_key: key.into(),
            turn_id: None,
            execution_id: None,
        }
    }
}

/// How well a runtime's side effects are covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Enforced,
    Cooperative,
    Observed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Active,
    Idle,
    Stale,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_key: String,
    pub runtime: String,
    pub coverage: Coverage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    pub state: SessionState,
    pub registered_at: i64,
    pub heartbeat_at: i64,
}

/// What a `register` command carries: identity only; unset fields keep their earlier value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub session_key: String,
    pub runtime: String,
    pub coverage: Coverage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub claim_id: String,
    pub request_id: String,
    pub owner: Owner,
    pub resource: Resource,
    pub mode: ClaimMode,
    pub lifetime: Lifetime,
    pub state: ClaimState,
    pub reason: String,
    pub granted_at: i64,
    /// Renewed by the owner's heartbeat; past it, an executing claim needs recovery.
    pub lease_until: i64,
    /// Bumped whenever ownership changes, so a stale capability cannot act.
    pub generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestItem {
    pub resource: Resource,
    pub mode: ClaimMode,
}

/// A queued request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub owner: Owner,
    pub items: Vec<RequestItem>,
    pub reason: String,
    pub lifetime: Lifetime,
    pub enqueued_at: i64,
    /// Give up waiting after this; absent means until cancelled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventType {
    Registered,
    Activity,
    ResourceAcquired,
    ResourceBlocked,
    ResourceReleased,
    ResourceAvailable,
    RecoveryRequired,
    Recovered,
    Delegated,
    /// A person took a live UI surface from an agent: the agent's view of it is out of date.
    TakenOver,
    Message,
    Acknowledged,
    Done,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub sequence: i64,
    #[serde(rename = "type")]
    pub kind: EventType,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    /// For a targeted message or wakeup. Absent = everyone in scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_session_key: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_ack: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acked_by: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub schema_version: u32,
    /// Changes every time a broker starts: a capability from an earlier epoch is void.
    pub epoch: String,
    pub revision: i64,
    pub sequence: i64,
    pub sessions: BTreeMap<String, Session>,
    pub claims: Vec<Claim>,
    pub waiters: Vec<Request>,
    pub events: Vec<Event>,
    /// The broker's clock when a snapshot was taken (never persisted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub resource: Resource,
    pub owner_session_key: String,
    pub reason: String,
    pub state: ClaimState,
    /// True when the owner is in another scope: only that the resource is busy is shown.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AcquireResult {
    Granted {
        claim_ids: Vec<String>,
        generation: i64,
    },
    Queued {
        position: usize,
        blockers: Vec<Blocker>,
    },
    Blocked {
        blockers: Vec<Blocker>,
        reason: String,
    },
}

/// How long to wait when busy; `wait: false` fails at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum Wait {
    Flag(bool),
    Bounded {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        for_ms: Option<i64>,
    },
}

impl Wait {
    pub fn never() -> Self {
        Self::Flag(false)
    }
    pub fn for_ms(ms: i64) -> Self {
        Self::Bounded {
            until_ms: None,
            for_ms: Some(ms),
        }
    }
}

impl Default for Wait {
    fn default() -> Self {
        Self::never()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Register {
        session: Registration,
    },
    Heartbeat {
        session_key: String,
    },
    Activity {
        session_key: String,
        activity: String,
    },
    Acquire {
        request_id: String,
        owner: Owner,
        items: Vec<RequestItem>,
        reason: String,
        lifetime: Lifetime,
        #[serde(default)]
        wait: Wait,
    },
    Start {
        owner: Owner,
        claim_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation: Option<i64>,
    },
    Cleanup {
        owner: Owner,
        claim_ids: Vec<String>,
    },
    Release {
        owner: Owner,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claim_ids: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    Cancel {
        owner: Owner,
        request_id: String,
    },
    /// A turn ended and its tools are reaped: release its non-service claims, cancel its waits.
    EndTurn {
        owner: Owner,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    EndSession {
        session_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    Delegate {
        owner: Owner,
        claim_id: String,
        to: Owner,
    },
    /// The host or a person confirms a recovery-required claim's work stopped.
    Recover {
        claim_id: String,
        actor: String,
        note: String,
    },
    /// A person took over a live UI surface (browser, app, desktop) an agent may hold.
    Takeover {
        request_id: String,
        session_key: String,
        items: Vec<RequestItem>,
        reason: String,
    },
    Message {
        from: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        needs_ack: Option<bool>,
    },
    Ack {
        session_key: String,
        sequence: i64,
    },
    /// The broker was not running for `paused_ms`: every lease moves forward by it.
    Suspended {
        paused_ms: f64,
    },
    Tick,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquire: Option<AcquireResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            ok: true,
            acquire: None,
            sequence: None,
            error: None,
        }
    }
    pub fn with_acquire(acquire: AcquireResult) -> Self {
        Self {
            ok: true,
            acquire: Some(acquire),
            sequence: None,
            error: None,
        }
    }
    pub fn fail(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            acquire: None,
            sequence: None,
            error: Some(error.into()),
        }
    }
    pub fn error_text(&self) -> &str {
        self.error.as_deref().unwrap_or_default()
    }
}
