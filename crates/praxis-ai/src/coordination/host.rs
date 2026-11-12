//! The single local coordination broker (FX-BF-048 / TASK-392), process side.
//!
//! One broker per OS user owns all state. The first process to create `broker.lock`
//! exclusively becomes the leader: it applies commands in order, persists the state
//! atomically to `agent.sessions.chat.json` *before* answering, and serves other processes
//! (a second app instance, a native hook adapter) over an authenticated local socket. Every
//! other process is a follower and sends its commands there. The file layout, token and line
//! protocol are the ones the TypeScript broker used, so either can join the other's broker.
//!
//! Two rules from the design are held strictly:
//! - **A lock is only taken over from a dead owner.** A lock whose recorded process is still
//!   alive is never removed, however old it looks.
//! - **Unreadable state is not an empty registry.** A snapshot that fails to parse is kept
//!   aside and the broker refuses grants until someone resets it, because guessing "nobody
//!   holds anything" is how two agents end up in the same file.
//!
//! On takeover, claims the previous broker recorded as executing become `recovery-required`
//! under the new epoch: their work may still be running.
//!
//! Time is the broker's own **monotonic** clock, so a person changing the system clock moves
//! no lease. When the broker notices it was not running for a while (the machine slept) it
//! extends every lease by the gap before judging any of them.
//!
//! The local socket is a Unix domain socket; on other platforms a process is its own leader
//! and is not joined by others.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::broker::{apply, empty_state, scoped_snapshot};
use super::types::{Command, CommandResult, SCHEMA_VERSION, SessionState, State};

pub const COORDINATION_FILE: &str = "agent.sessions.chat.json";
const LOCK_FILE: &str = "broker.lock";
const TOKEN_FILE: &str = "broker.token";
const TICK_MS: i64 = 15_000;
const MAX_LINE: usize = 1_000_000;

/// Wall-clock-shaped milliseconds that only ever move forward at the rate of real time: the
/// wall clock when this process started, plus monotonic time since. Immune to clock changes.
pub fn broker_clock() -> i64 {
    static ORIGIN: OnceLock<(i64, Instant)> = OnceLock::new();
    let (wall, started) = ORIGIN.get_or_init(|| (chrono::Utc::now().timestamp_millis(), Instant::now()));
    wall + i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// The OS-user coordination root, shared by every Praxis profile; a test sets its own.
pub fn default_root() -> PathBuf {
    if let Some(root) = std::env::var_os("PRAXIS_COORDINATION_ROOT").filter(|value| !value.is_empty()) {
        return PathBuf::from(root);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".praxis").join("coordination")
}

fn socket_path(root: &Path) -> PathBuf {
    let direct = root.join("broker.sock");
    if direct.to_string_lossy().len() < 100 {
        return direct;
    }
    // Unix socket paths are short-limited; the root is hashed into the temp dir when it is long.
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("praxis-coord-{}.sock", &hex(&digest)[..16]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_token() -> String {
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    hex(a.as_bytes()) + &hex(b.as_bytes())
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    let Ok(raw) = i32::try_from(pid) else { return false };
    if raw <= 0 {
        return false;
    }
    match kill(Pid::from_raw(raw), None) {
        Ok(()) => true,
        Err(error) => error == Errno::EPERM,
    }
}

#[cfg(not(unix))]
fn process_alive(pid: u32) -> bool {
    pid == std::process::id()
}

fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes JSON atomically: a unique temp file in the same directory, flushed, then renamed over.
fn write_atomic(file: &Path, state: &State) -> std::io::Result<()> {
    let temp = file.with_file_name(format!("{}.{}.{}.tmp", file.file_name().and_then(|n| n.to_str()).unwrap_or("state"), std::process::id(), &hex(uuid::Uuid::new_v4().as_bytes())[..8]));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = options.open(&temp)?;
    let mut body = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    body.push('\n');
    let written = handle.write_all(body.as_bytes()).and_then(|()| handle.sync_all());
    drop(handle);
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, file)
}

/// Loads the persisted state for a new epoch. An unreadable file is kept aside and blocks grants.
fn read_state(file: &Path, epoch: &str) -> (State, Option<String>) {
    let Ok(raw) = std::fs::read_to_string(file) else {
        if file.exists() {
            return unreadable(file, epoch, "the file could not be read");
        }
        return (empty_state(epoch), None);
    };
    match serde_json::from_str::<State>(&raw) {
        Ok(mut state) if state.schema_version == SCHEMA_VERSION => {
            // A new broker, a new epoch: whatever the last one saw executing may still be running.
            for claim in &mut state.claims {
                if matches!(claim.state, super::types::ClaimState::Executing | super::types::ClaimState::CleaningUp) {
                    claim.state = super::types::ClaimState::RecoveryRequired;
                }
            }
            state.epoch = epoch.to_owned();
            state.waiters.clear();
            state.now = None;
            for session in state.sessions.values_mut() {
                if session.state != SessionState::Ended {
                    session.state = SessionState::Stale;
                }
            }
            (state, None)
        }
        Ok(state) => unreadable(file, epoch, &format!("unexpected shape (schema {})", state.schema_version)),
        Err(error) => unreadable(file, epoch, &error.to_string()),
    }
}

fn unreadable(file: &Path, epoch: &str, why: &str) -> (State, Option<String>) {
    let aside = PathBuf::from(format!("{}.unreadable-{}", file.display(), chrono::Utc::now().timestamp_millis()));
    let _ = std::fs::copy(file, &aside);
    (
        empty_state(epoch),
        Some(format!("Coordination state could not be read ({why}); a copy is at {}. No resources are granted until it is reset.", aside.display())),
    )
}

/// Options for becoming a leader; tests use a short beat and a fake clock.
#[derive(Clone, Default)]
pub struct LeaderOptions {
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    /// Called after each change this process applied (leader only).
    pub on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    /// How often leases are judged.
    pub tick_ms: Option<i64>,
    /// A gap between beats longer than this means the broker was suspended. Default three beats.
    pub suspended_after_ms: Option<i64>,
}

struct LeaderInner {
    state: State,
    blocked_reason: Option<String>,
    last_beat: i64,
}

/// The process that owns the broker's state.
pub struct Leader {
    root: PathBuf,
    token: String,
    inner: Mutex<LeaderInner>,
    options: LeaderOptions,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Cancelled on close: ends the accept loop and every live connection.
    shutdown: tokio_util::sync::CancellationToken,
}

impl Leader {
    fn new(root: &Path, token: String, epoch: &str, options: LeaderOptions) -> Self {
        let (state, blocked_reason) = read_state(&root.join(COORDINATION_FILE), epoch);
        let leader = Self { root: root.to_path_buf(), token, inner: Mutex::new(LeaderInner { state, blocked_reason, last_beat: 0 }), options, tasks: Mutex::new(Vec::new()), shutdown: tokio_util::sync::CancellationToken::new() };
        {
            let inner = lock_ignoring_poison(&leader.inner);
            if inner.blocked_reason.is_none() {
                let _ = write_atomic(&leader.root.join(COORDINATION_FILE), &inner.state);
            }
        }
        leader
    }

    fn now(&self) -> i64 {
        self.options.now.as_ref().map_or_else(broker_clock, |clock| clock())
    }

    fn tick_ms(&self) -> i64 {
        self.options.tick_ms.unwrap_or(TICK_MS)
    }

    pub fn blocked_reason(&self) -> Option<String> {
        lock_ignoring_poison(&self.inner).blocked_reason.clone()
    }

    /// One beat: first account for any time the broker was suspended, then judge leases.
    pub fn beat(&self) {
        let at = self.now();
        let gap = {
            let mut inner = lock_ignoring_poison(&self.inner);
            let gap = if inner.last_beat == 0 { 0 } else { at - inner.last_beat };
            inner.last_beat = at;
            gap
        };
        if gap > self.options.suspended_after_ms.unwrap_or(self.tick_ms() * 3) {
            self.send(&Command::Suspended { paused_ms: (gap - self.tick_ms()) as f64 });
        }
        self.send(&Command::Tick);
    }

    /// Applies one command. The state is persisted before the answer goes out: a grant nobody
    /// wrote down was never given.
    pub fn send(&self, command: &Command) -> CommandResult {
        let (result, changed) = {
            let mut inner = lock_ignoring_poison(&self.inner);
            if inner.blocked_reason.is_some() && matches!(command, Command::Acquire { .. } | Command::Start { .. }) {
                return CommandResult::fail(inner.blocked_reason.clone().unwrap_or_default());
            }
            let now = self.now();
            let applied = apply(&mut inner.state, command, now);
            if applied.changed && inner.blocked_reason.is_none() {
                let _ = write_atomic(&self.root.join(COORDINATION_FILE), &inner.state);
            }
            (applied.result, applied.changed)
        };
        if changed && let Some(listener) = &self.options.on_change {
            listener();
        }
        result
    }

    /// The whole state, or one session's scoped view of it, with the broker's clock.
    pub fn snapshot(&self, session_key: Option<&str>, since: Option<i64>) -> Value {
        let inner = lock_ignoring_poison(&self.inner);
        let mut value = match session_key {
            Some(key) => scoped_snapshot(&inner.state, key, since.unwrap_or(0)),
            None => serde_json::to_value(&inner.state).unwrap_or(Value::Null),
        };
        value["now"] = json!(self.now());
        value
    }

    /// Clears an unreadable state (after a person looked at the copy) and starts granting again.
    pub fn reset(&self) {
        let mut inner = lock_ignoring_poison(&self.inner);
        let epoch = inner.state.epoch.clone();
        inner.state = empty_state(&epoch);
        inner.blocked_reason = None;
        let _ = write_atomic(&self.root.join(COORDINATION_FILE), &inner.state);
    }

    fn answer(&self, line: &str) -> Option<Value> {
        let message: Value = serde_json::from_str(line).ok()?;
        let id = message["id"].clone();
        // Every request carries the token from the user-only token file: another user cannot speak to this broker.
        if message["token"].as_str() != Some(self.token.as_str()) {
            return Some(json!({ "id": id, "result": { "ok": false, "error": "Not authorised." } }));
        }
        let result = match message["op"].as_str() {
            Some("send") => match serde_json::from_value::<Command>(message["command"].clone()) {
                Ok(command) => serde_json::to_value(self.send(&command)).unwrap_or(Value::Null),
                Err(error) => json!({ "ok": false, "error": format!("Unrecognised coordination command: {error}") }),
            },
            Some("snapshot") => self.snapshot(message["sessionKey"].as_str(), message["since"].as_i64()),
            _ => json!({ "ok": false, "error": "Unknown operation." }),
        };
        Some(json!({ "id": id, "result": result }))
    }

    #[cfg(unix)]
    async fn listen(self: &Arc<Self>) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let where_ = socket_path(&self.root);
        let _ = std::fs::remove_file(&where_);
        let listener = tokio::net::UnixListener::bind(&where_)?;
        std::fs::set_permissions(&where_, std::fs::Permissions::from_mode(0o600))?;
        lock_ignoring_poison(&self.inner).last_beat = self.now();

        let leader = Arc::clone(self);
        let accept = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    () = leader.shutdown.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _)) = accepted else { break };
                let leader = Arc::clone(&leader);
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut reader = tokio::io::BufReader::new(read);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        let read = tokio::select! {
                            () = leader.shutdown.cancelled() => break,
                            read = reader.read_line(&mut line) => read,
                        };
                        match read {
                            Ok(0) | Err(_) => break,
                            Ok(_) if line.len() > MAX_LINE => break,
                            Ok(_) => {}
                        }
                        let request = line.trim_end().to_owned();
                        let handler = Arc::clone(&leader);
                        // Applying a command takes a lock and a disk write: keep it off the reactor.
                        let reply = tokio::task::spawn_blocking(move || handler.answer(&request)).await.ok().flatten();
                        if let Some(reply) = reply
                            && write.write_all(format!("{reply}\n").as_bytes()).await.is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        // Leases and stale sessions are judged on the broker's clock, on a steady beat.
        let leader = Arc::clone(self);
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(u64::try_from(leader.tick_ms()).unwrap_or(15_000).max(1)));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await;
            loop {
                interval.tick().await;
                let beater = Arc::clone(&leader);
                let _ = tokio::task::spawn_blocking(move || beater.beat()).await;
            }
        });
        lock_ignoring_poison(&self.tasks).extend([accept, ticker]);
        Ok(())
    }

    #[cfg(not(unix))]
    async fn listen(self: &Arc<Self>) -> std::io::Result<()> {
        lock_ignoring_poison(&self.inner).last_beat = self.now();
        let leader = Arc::clone(self);
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(u64::try_from(leader.tick_ms()).unwrap_or(15_000).max(1)));
            interval.tick().await;
            loop {
                interval.tick().await;
                let beater = Arc::clone(&leader);
                let _ = tokio::task::spawn_blocking(move || beater.beat()).await;
            }
        });
        lock_ignoring_poison(&self.tasks).push(ticker);
        Ok(())
    }

    pub fn close(&self) {
        self.shutdown.cancel();
        for task in lock_ignoring_poison(&self.tasks).drain(..) {
            task.abort();
        }
        let _ = std::fs::remove_file(socket_path(&self.root));
        if let Ok(raw) = std::fs::read_to_string(self.root.join(LOCK_FILE))
            && serde_json::from_str::<Value>(&raw).ok().and_then(|lock| lock["pid"].as_u64()) == Some(u64::from(std::process::id()))
        {
            let _ = std::fs::remove_file(self.root.join(LOCK_FILE));
        }
    }
}

const WENT_AWAY: &str = "The coordination broker went away; nothing was granted.";
const NOT_CONNECTED: &str = "Not connected to the coordination broker; nothing was granted.";

/// A connection to the leader in another process (or this one).
pub struct Follower {
    token: String,
    #[cfg(unix)]
    stream: Mutex<Option<(std::os::unix::net::UnixStream, BufReader<std::os::unix::net::UnixStream>)>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl Follower {
    #[cfg(unix)]
    fn connect(root: &Path, token: &str) -> std::io::Result<Self> {
        let stream = std::os::unix::net::UnixStream::connect(socket_path(root))?;
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        let reader = BufReader::new(stream.try_clone()?);
        Ok(Self { token: token.to_owned(), stream: Mutex::new(Some((stream, reader))), next_id: std::sync::atomic::AtomicU64::new(1) })
    }

    #[cfg(not(unix))]
    fn connect(_root: &Path, _token: &str) -> std::io::Result<Self> {
        Err(std::io::Error::other("joining another process's coordination broker is not supported on this platform"))
    }

    /// One request, one reply: lock-step on the connection. A lost broker is not a grant.
    #[cfg(unix)]
    fn call(&self, mut payload: Value) -> Value {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        payload["id"] = json!(id);
        payload["token"] = json!(self.token);
        let mut guard = lock_ignoring_poison(&self.stream);
        let Some((stream, reader)) = guard.as_mut() else { return json!({ "ok": false, "error": NOT_CONNECTED }) };
        let sent = stream.write_all(format!("{payload}\n").as_bytes());
        let mut line = String::new();
        let outcome = sent.and_then(|()| reader.read_line(&mut line));
        match outcome {
            Ok(n) if n > 0 => match serde_json::from_str::<Value>(&line) {
                Ok(reply) if reply["id"] == json!(id) => reply["result"].clone(),
                _ => json!({ "ok": false, "error": WENT_AWAY }),
            },
            _ => {
                *guard = None;
                json!({ "ok": false, "error": WENT_AWAY })
            }
        }
    }

    #[cfg(not(unix))]
    fn call(&self, _payload: Value) -> Value {
        json!({ "ok": false, "error": NOT_CONNECTED })
    }

    pub fn send(&self, command: &Command) -> CommandResult {
        let reply = self.call(json!({ "op": "send", "command": command }));
        serde_json::from_value(reply).unwrap_or_else(|error| CommandResult::fail(format!("The coordination broker sent an unreadable answer ({error}); nothing was granted.")))
    }

    pub fn snapshot(&self, session_key: Option<&str>, since: Option<i64>) -> Value {
        self.call(json!({ "op": "snapshot", "sessionKey": session_key, "since": since }))
    }

    pub fn close(&self) {
        #[cfg(unix)]
        {
            if let Some((stream, _)) = lock_ignoring_poison(&self.stream).take() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Leader,
    Follower,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Leader => "leader",
            Self::Follower => "follower",
        }
    }
}

/// Either seat at the broker.
#[derive(Clone)]
pub enum Endpoint {
    Leader(Arc<Leader>),
    Follower(Arc<Follower>),
}

impl Endpoint {
    pub fn role(&self) -> Role {
        match self {
            Self::Leader(_) => Role::Leader,
            Self::Follower(_) => Role::Follower,
        }
    }

    pub fn blocked_reason(&self) -> Option<String> {
        match self {
            Self::Leader(leader) => leader.blocked_reason(),
            Self::Follower(_) => None,
        }
    }

    pub async fn send(&self, command: Command) -> CommandResult {
        match self {
            Self::Leader(leader) => {
                let leader = Arc::clone(leader);
                tokio::task::spawn_blocking(move || leader.send(&command)).await.unwrap_or_else(|error| CommandResult::fail(error.to_string()))
            }
            Self::Follower(follower) => {
                let follower = Arc::clone(follower);
                tokio::task::spawn_blocking(move || follower.send(&command)).await.unwrap_or_else(|error| CommandResult::fail(error.to_string()))
            }
        }
    }

    pub async fn snapshot(&self, session_key: Option<String>, since: Option<i64>) -> Value {
        match self {
            Self::Leader(leader) => leader.snapshot(session_key.as_deref(), since),
            Self::Follower(follower) => {
                let follower = Arc::clone(follower);
                tokio::task::spawn_blocking(move || follower.snapshot(session_key.as_deref(), since)).await.unwrap_or(Value::Null)
            }
        }
    }

    pub fn close(&self) {
        match self {
            Self::Leader(leader) => leader.close(),
            Self::Follower(follower) => follower.close(),
        }
    }

    pub fn reset(&self) {
        if let Self::Leader(leader) = self {
            leader.reset();
        }
    }
}

/// Joins the coordination broker under `root`: becomes it if no live process holds the lock,
/// otherwise connects to the one that does.
pub async fn join(root: &Path, options: LeaderOptions) -> Result<Endpoint, String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }
    let token_file = root.join(TOKEN_FILE);
    if !token_file.exists() {
        // Another process may make it first; either way a token exists afterwards.
        let _ = create_private(&token_file, random_token().as_bytes());
    }
    let lock_file = root.join(LOCK_FILE);
    for attempt in 0..5u64 {
        // Exclusive creation publishes the filename before its bytes. A competing process
        // must not cache an empty/partial credential for the whole connection.
        let token = std::fs::read_to_string(&token_file).unwrap_or_default().trim().to_owned();
        if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
            if attempt == 4 {
                return Err("The coordination broker token is incomplete; joining was refused.".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let epoch = uuid::Uuid::new_v4().to_string();
        let lock = json!({ "pid": std::process::id(), "epoch": epoch, "at": chrono::Utc::now().to_rfc3339() }).to_string();
        match create_private(&lock_file, lock.as_bytes()) {
            Ok(()) => {
                let leader = Arc::new(Leader::new(root, token, &epoch, options));
                if let Err(error) = leader.listen().await {
                    leader.close();
                    let _ = std::fs::remove_file(&lock_file);
                    return Err(format!("The coordination broker could not listen: {error}"));
                }
                return Ok(Endpoint::Leader(leader));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        let holder = std::fs::read_to_string(&lock_file).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|lock| lock["pid"].as_u64());
        match holder {
            Some(pid) if u32::try_from(pid).is_ok_and(process_alive) => {
                let (root, token) = (root.to_path_buf(), token.clone());
                match tokio::task::spawn_blocking(move || Follower::connect(&root, &token)).await {
                    Ok(Ok(follower)) => return Ok(Endpoint::Follower(Arc::new(follower))),
                    // Alive but not listening yet (it is still starting): wait and retry rather than take over.
                    _ => tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await,
                }
            }
            // Its recorded owner is dead: the lock is stale and may be replaced.
            Some(_) => {
                let _ = std::fs::remove_file(&lock_file);
            }
            // A lock mid-write: try again shortly.
            None => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    Err(format!("Could not join the coordination broker at {}: another process holds it but does not answer.", root.display()))
}

/// Creates a file exclusively with owner-only permissions and writes `bytes` to it.
fn create_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)?.write_all(bytes)
}

/// Connects to a running broker without ever becoming one — for a short-lived process such as
/// a native hook, whose exit would otherwise strand its claims.
pub fn connect(root: &Path) -> Option<Endpoint> {
    let token = std::fs::read_to_string(root.join(TOKEN_FILE)).ok()?.trim().to_owned();
    Follower::connect(root, &token).ok().map(|follower| Endpoint::Follower(Arc::new(follower)))
}

/// A coordination endpoint that survives its broker going away: a follower whose leader died
/// rejoins — becoming the leader itself if the lock's owner is dead — and retries the request
/// once. Nothing is ever reported granted that the broker did not grant.
pub struct Resilient {
    root: PathBuf,
    options: LeaderOptions,
    endpoint: Mutex<Option<Endpoint>>,
    joining: tokio::sync::Mutex<()>,
}

impl Resilient {
    pub fn new(root: PathBuf, options: LeaderOptions) -> Self {
        Self { root, options, endpoint: Mutex::new(None), joining: tokio::sync::Mutex::new(()) }
    }

    pub fn role(&self) -> Role {
        lock_ignoring_poison(&self.endpoint).as_ref().map_or(Role::Follower, Endpoint::role)
    }

    pub fn blocked_reason(&self) -> Option<String> {
        lock_ignoring_poison(&self.endpoint).as_ref().and_then(Endpoint::blocked_reason)
    }

    async fn current(&self) -> Result<Endpoint, String> {
        let _joining = self.joining.lock().await;
        if let Some(endpoint) = lock_ignoring_poison(&self.endpoint).clone() {
            return Ok(endpoint);
        }
        let endpoint = join(&self.root, self.options.clone()).await?;
        *lock_ignoring_poison(&self.endpoint) = Some(endpoint.clone());
        Ok(endpoint)
    }

    fn lost(result: &CommandResult) -> bool {
        !result.ok && (result.error_text().contains("went away") || result.error_text().contains("Not connected"))
    }

    pub async fn send(&self, command: Command) -> CommandResult {
        let first = match self.current().await {
            Ok(endpoint) => endpoint.send(command.clone()).await,
            Err(error) => return unavailable(&error),
        };
        if !Self::lost(&first) {
            return first;
        }
        if let Some(old) = lock_ignoring_poison(&self.endpoint).take() {
            old.close();
        }
        match self.current().await {
            Ok(endpoint) => endpoint.send(command).await,
            Err(error) => unavailable(&error),
        }
    }

    pub async fn snapshot(&self, session_key: Option<&str>, since: Option<i64>) -> Value {
        match self.current().await {
            Ok(endpoint) => endpoint.snapshot(session_key.map(str::to_owned), since).await,
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    /// Joins now (rather than on first use), so a native hook adapter has a broker to ask.
    pub async fn ensure_joined(&self) -> Result<(), String> {
        self.current().await.map(|_| ())
    }

    pub fn reset(&self) {
        if let Some(endpoint) = lock_ignoring_poison(&self.endpoint).as_ref() {
            endpoint.reset();
        }
    }

    pub fn close(&self) {
        if let Some(endpoint) = lock_ignoring_poison(&self.endpoint).take() {
            endpoint.close();
        }
    }
}

fn unavailable(error: &str) -> CommandResult {
    CommandResult::fail(format!("Coordination is unavailable ({error}); nothing was granted."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::types::{AcquireResult, ClaimMode, Coverage, Lifetime, Owner, Registration, RequestItem, Resource, Wait};

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("praxis-coord-{name}-{}", &hex(uuid::Uuid::new_v4().as_bytes())[..8]));
        std::fs::create_dir_all(&root).expect("root");
        root
    }

    fn register(key: &str) -> Command {
        Command::Register { session: Registration { session_key: key.into(), runtime: "gateway".into(), coverage: Coverage::Enforced, parent_session_key: None, scope: None, worktree: None, branch: None, head: None } }
    }

    fn acquire(id: &str, key: &str, path: &str) -> Command {
        Command::Acquire {
            request_id: id.into(),
            owner: Owner::session(key),
            items: vec![RequestItem { resource: Resource::File { worktree: "/r".into(), path: path.into() }, mode: ClaimMode::Exclusive }],
            reason: "editing".into(),
            lifetime: Lifetime::Sequence,
            wait: Wait::never(),
        }
    }

    #[tokio::test]
    async fn the_first_process_leads_and_a_second_connection_follows_over_the_socket() {
        let root = temp_root("lead");
        let leader = join(&root, LeaderOptions::default()).await.expect("leads");
        assert_eq!(leader.role(), Role::Leader);
        // The lock names a live process (this one), so the second join follows.
        let follower = join(&root, LeaderOptions::default()).await.expect("follows");
        assert_eq!(follower.role(), Role::Follower);

        assert!(follower.send(register("OTHER")).await.ok);
        let held = follower.send(acquire("r1", "OTHER", "sum.js")).await;
        assert!(matches!(held.acquire, Some(AcquireResult::Granted { .. })));

        assert!(leader.send(register("MINE")).await.ok);
        let refused = leader.send(acquire("r2", "MINE", "sum.js")).await;
        let Some(AcquireResult::Blocked { reason, .. }) = refused.acquire else { panic!("expected blocked") };
        assert!(reason.contains("held by OTHER"), "{reason}");

        // The follower reads the same state.
        let view = follower.snapshot(None, None).await;
        assert_eq!(view["claims"].as_array().map(Vec::len), Some(1));
        assert!(view["now"].is_number());
        follower.close();
        leader.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_request_with_the_wrong_token_is_refused() {
        let root = temp_root("token");
        let leader = join(&root, LeaderOptions::default()).await.expect("leads");
        let Endpoint::Leader(inner) = &leader else { panic!("leader") };
        let reply = inner.answer(r#"{"op":"snapshot","id":1,"token":"nope"}"#).expect("answers");
        assert_eq!(reply["result"]["error"], "Not authorised.");
        let good = inner.answer(&format!(r#"{{"op":"snapshot","id":2,"token":"{}"}}"#, inner.token)).expect("answers");
        assert_eq!(good["result"]["schemaVersion"], 1);
        leader.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn state_is_persisted_before_the_answer_and_recovered_as_recovery_required() {
        let root = temp_root("persist");
        let leader = join(&root, LeaderOptions::default()).await.expect("leads");
        leader.send(register("A")).await;
        leader.send(acquire("r1", "A", "x.rs")).await;
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(root.join(COORDINATION_FILE)).expect("file")).expect("json");
        assert_eq!(on_disk["claims"][0]["state"], "executing");
        leader.close();

        // A new broker, a new epoch: what was executing may still be running.
        let again = join(&root, LeaderOptions::default()).await.expect("leads again");
        let view = again.snapshot(None, None).await;
        assert_eq!(view["claims"][0]["state"], "recovery-required");
        assert_eq!(view["sessions"]["A"]["state"], "stale");
        assert_ne!(view["epoch"], on_disk["epoch"]);
        again.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn unreadable_state_blocks_grants_until_it_is_reset() {
        let root = temp_root("unreadable");
        std::fs::write(root.join(COORDINATION_FILE), "{ not json").expect("seed");
        let leader = join(&root, LeaderOptions::default()).await.expect("leads");
        let reason = leader.blocked_reason().expect("blocked");
        assert!(reason.contains("No resources are granted until it is reset"), "{reason}");
        assert!(std::fs::read_dir(&root).expect("dir").flatten().any(|entry| entry.file_name().to_string_lossy().contains(".unreadable-")));
        assert!(leader.send(register("A")).await.ok);
        let refused = leader.send(acquire("r1", "A", "x.rs")).await;
        assert!(!refused.ok);
        leader.reset();
        assert!(leader.blocked_reason().is_none());
        // Reset empties the registry, so the session joins again before acquiring.
        assert!(leader.send(register("A")).await.ok);
        assert!(leader.send(acquire("r1", "A", "x.rs")).await.ok);
        leader.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_lock_held_by_a_dead_process_is_taken_over_but_a_live_one_never_is() {
        let root = temp_root("lock");
        // PID 2^31-1 is not a running process.
        std::fs::write(root.join(LOCK_FILE), r#"{"pid":2147483646,"epoch":"old"}"#).expect("lock");
        let leader = join(&root, LeaderOptions::default()).await.expect("takes over");
        assert_eq!(leader.role(), Role::Leader);
        leader.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_resilient_endpoint_rejoins_when_its_leader_goes_away() {
        let root = temp_root("resilient");
        let leader = join(&root, LeaderOptions::default()).await.expect("leads");
        let resilient = Resilient::new(root.clone(), LeaderOptions::default());
        assert!(resilient.send(register("A")).await.ok);
        assert_eq!(resilient.role(), Role::Follower);
        // The leader dies: its socket closes and the lock's owner (this process) is still "alive",
        // so release the lock the way a dead owner would have.
        leader.close();
        let _ = std::fs::remove_file(root.join(LOCK_FILE));
        let result = resilient.send(register("B")).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(resilient.role(), Role::Leader);
        resilient.close();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn long_roots_hash_their_socket_into_the_temp_dir() {
        let long = PathBuf::from(format!("/{}", "x".repeat(120)));
        let socket = socket_path(&long);
        assert!(socket.starts_with(std::env::temp_dir()));
        assert!(socket.to_string_lossy().len() < 100);
        assert_eq!(socket_path(Path::new("/tmp/short")), PathBuf::from("/tmp/short/broker.sock"));
    }

    #[test]
    fn the_beat_extends_leases_after_a_suspension_instead_of_expiring_them() {
        let root = temp_root("beat");
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
        let options = LeaderOptions { now: Some({ let clock = Arc::clone(&clock); Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)) }), tick_ms: Some(1000), ..LeaderOptions::default() };
        let leader = Leader::new(&root, "t".repeat(64), "e", options);
        leader.send(&register("A"));
        leader.send(&acquire("r1", "A", "x.rs"));
        leader.beat();
        // The machine sleeps for ten minutes; nobody could heartbeat.
        clock.fetch_add(600_000, std::sync::atomic::Ordering::SeqCst);
        leader.beat();
        let view = leader.snapshot(None, None);
        assert_eq!(view["claims"][0]["state"], "executing");
        assert!(view["events"].as_array().expect("events").iter().any(|e| e["text"].as_str().is_some_and(|t| t.contains("Coordination was paused"))));
        let _ = std::fs::remove_dir_all(&root);
    }
}
