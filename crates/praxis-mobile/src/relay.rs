//! The Praxis mobile relay (`packages/mobile-relay/src/relayServer.ts` port; FX-BE-079).
//!
//! Two outbound connections meet here; the relay forwards bytes between them and cannot read
//! them — the Noise IK channel runs end to end above it, so the relay is untrusted. There are no
//! accounts: a host proves it owns a channel by signing a challenge with an Ed25519 key, and the
//! channel id *is* the hash of that key.
//!
//! ```text
//! host    GET /v1/host?key=<64 hex>        control socket; challenge → auth → registered
//! phone   GET /v1/connect?channel=<hex>    relay tells the host `incoming`; phone bytes wait
//! host    GET /v1/accept?channel=&conn=    second socket for that one phone; the two are piped
//! ```
//!
//! Wire-compatible with the TS: the same paths and query names, the same JSON control messages
//! (`challenge` / `auth` / `registered` / `incoming`), the signed string
//! `"praxis-relay-v1|" + nonceHex` (UTF-8), hex keys and signatures, the channel id as the first
//! 32 hex characters of SHA-256 over the raw public key, and the same 4xxx close codes. What the
//! relay defends is itself: per-channel and per-address caps, an auth timeout, bounded
//! buffering, a message-size cap and a per-connection byte-rate limit. TLS is not built in;
//! terminate it in front of the relay.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::extract::ws::{
    CloseFrame, Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection,
};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

pub const RELAY_PROTOCOL_VERSION: u32 = 1;
pub const RELAY_SIGNATURE_CONTEXT: &str = "praxis-relay-v1|";

/// Close codes the relay uses; 4xxx is the application range.
pub mod close_code {
    pub const BAD_REQUEST: u16 = 4400;
    pub const AUTH_FAILED: u16 = 4401;
    pub const HOST_OFFLINE: u16 = 4404;
    pub const WAIT_TIMEOUT: u16 = 4408;
    pub const REPLACED: u16 = 4409;
    pub const TOO_MANY_PEERS: u16 = 4429;
    pub const RATE_LIMITED: u16 = 4430;
    pub const SERVER_BUSY: u16 = 4503;
    /// RFC 6455 "message too big", what `ws` sends past `maxPayload`.
    pub const MESSAGE_TOO_BIG: u16 = 1009;
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelayLimits {
    pub max_channels: usize,
    pub max_devices_per_channel: usize,
    pub max_pending_per_channel: usize,
    /// Concurrent sockets from one remote address.
    pub max_sockets_per_address: usize,
    /// New sockets per address per minute.
    pub max_connects_per_minute: usize,
    /// A ws message larger than this closes the socket (the Noise record limit is 1 MiB).
    pub max_message_bytes: usize,
    /// Bytes a phone may send before the host's accept socket attaches.
    pub max_buffered_bytes: usize,
    pub auth_timeout: Duration,
    pub accept_timeout: Duration,
    /// Sustained bytes/second per piped connection, in each direction.
    pub bytes_per_second: f64,
    pub burst_bytes: f64,
    pub heartbeat: Duration,
}

impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            max_channels: 1000,
            max_devices_per_channel: 8,
            max_pending_per_channel: 4,
            max_sockets_per_address: 32,
            max_connects_per_minute: 60,
            max_message_bytes: (1 << 20) + 1024,
            max_buffered_bytes: 256 * 1024,
            auth_timeout: Duration::from_millis(10_000),
            accept_timeout: Duration::from_millis(20_000),
            bytes_per_second: 4.0 * 1024.0 * 1024.0,
            burst_bytes: 8.0 * 1024.0 * 1024.0,
            heartbeat: Duration::from_millis(30_000),
        }
    }
}

/// Diagnostic lines. Never receives payloads or keys.
pub type RelayLog = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct RelayServerOptions {
    /// Where to listen; port 0 picks a free one. Defaults to `0.0.0.0:0`.
    pub address: Option<SocketAddr>,
    pub limits: RelayLimits,
    pub on_log: Option<RelayLog>,
}

/// The channel id for a host's Ed25519 public key (lower-case hex). Invalid hex gives `None`.
pub fn channel_id_for_key(public_key_hex: &str) -> Option<String> {
    let key = decode_hex(public_key_hex)?;
    let mut id = hex(&Sha256::digest(key));
    id.truncate(32);
    Some(id)
}

/// Verifies `signature_hex` over `RELAY_SIGNATURE_CONTEXT + nonce_hex` with the raw Ed25519 key.
/// Uses strict verification (rejects small-order keys and non-canonical signatures).
pub fn verify_host_signature(public_key_hex: &str, nonce_hex: &str, signature_hex: &str) -> bool {
    let Some(key) = decode_hex(public_key_hex).and_then(|k| <[u8; 32]>::try_from(k).ok()) else {
        return false;
    };
    let Some(signature) = decode_hex(signature_hex).and_then(|s| <[u8; 64]>::try_from(s).ok())
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key) else {
        return false;
    };
    let message = format!("{RELAY_SIGNATURE_CONTEXT}{nonce_hex}");
    key.verify_strict(message.as_bytes(), &Signature::from_bytes(&signature))
        .is_ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).expect("the OS random source is available");
    hex(&buffer)
}

/// A token bucket of bytes.
struct ByteBudget {
    tokens: f64,
    last: Instant,
    per_second: f64,
    burst: f64,
}

impl ByteBudget {
    fn new(per_second: f64, burst: f64) -> Self {
        Self {
            tokens: burst,
            last: Instant::now(),
            per_second,
            burst,
        }
    }

    fn take(&mut self, bytes: usize) -> bool {
        let now = Instant::now();
        self.tokens = self
            .burst
            .min(self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_second);
        self.last = now;
        let bytes = bytes as f64;
        if bytes > self.tokens {
            return false;
        }
        self.tokens -= bytes;
        true
    }
}

enum Command {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, &'static str),
    Terminate,
}

#[derive(Clone)]
struct SocketHandle {
    id: u64,
    commands: mpsc::UnboundedSender<Command>,
}

impl SocketHandle {
    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
    fn close(&self, code: u16, reason: &'static str) {
        self.send(Command::Close(code, reason));
    }
}

struct Channel {
    control: SocketHandle,
    /// Connection ids this registration owns (pending and active).
    conns: HashSet<String>,
}

struct Pipe {
    device: SocketHandle,
    accept: Option<SocketHandle>,
    buffered: Vec<Vec<u8>>,
    buffered_bytes: usize,
}

#[derive(Default)]
struct RelayState {
    channels: HashMap<String, Channel>,
    /// Every piped phone connection by conn id; outlives a replaced registration, as in the TS.
    pipes: HashMap<String, Pipe>,
    sockets: HashMap<u64, SocketHandle>,
    sockets_by_address: HashMap<IpAddr, usize>,
    connects_by_address: HashMap<IpAddr, Vec<Instant>>,
}

struct Relay {
    limits: RelayLimits,
    on_log: Option<RelayLog>,
    state: Mutex<RelayState>,
    next_socket: AtomicU64,
}

impl Relay {
    fn lock(&self) -> MutexGuard<'_, RelayState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn log(&self, line: &str) {
        if let Some(log) = &self.on_log {
            log(line);
        }
    }

    /// Per-address connection-rate and concurrency admission.
    fn admit(&self, address: IpAddr) -> bool {
        let now = Instant::now();
        let mut state = self.lock();
        let mut recent: Vec<Instant> = state
            .connects_by_address
            .remove(&address)
            .unwrap_or_default();
        recent.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
        let admitted = recent.len() < self.limits.max_connects_per_minute
            && state.sockets_by_address.get(&address).copied().unwrap_or(0)
                < self.limits.max_sockets_per_address;
        if admitted {
            recent.push(now);
        }
        state.connects_by_address.insert(address, recent);
        admitted
    }

    fn prune_connect_history(&self) {
        let now = Instant::now();
        let mut state = self.lock();
        state.connects_by_address.retain(|_, times| {
            times.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
            !times.is_empty()
        });
    }
}

enum Flow {
    Continue,
    Close(u16, &'static str),
}

enum Role {
    Host {
        key_hex: String,
        nonce: String,
        authed: bool,
    },
    Device {
        conn: String,
        budget: ByteBudget,
    },
    Accept {
        channel_id: String,
        conn: String,
        budget: ByteBudget,
    },
    Refused,
}

impl Role {
    /// Routes a new socket. Returns the role, an optional deadline, and an immediate close.
    fn start(
        relay: &Relay,
        me: &SocketHandle,
        path: &str,
        query: &HashMap<String, String>,
    ) -> (Role, Option<Instant>, Option<(u16, &'static str)>) {
        let param = |name: &str| {
            query
                .get(name)
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_default()
        };
        let limits = &relay.limits;
        match path {
            "/v1/host" => {
                let key_hex = param("key");
                if !is_lower_hex(&key_hex, 64) {
                    return (
                        Role::Refused,
                        None,
                        Some((close_code::BAD_REQUEST, "bad key")),
                    );
                }
                let nonce = random_hex(32);
                me.send(Command::Text(json!({ "type": "challenge", "version": RELAY_PROTOCOL_VERSION, "nonce": nonce }).to_string()));
                (
                    Role::Host {
                        key_hex,
                        nonce,
                        authed: false,
                    },
                    Some(Instant::now() + limits.auth_timeout),
                    None,
                )
            }
            "/v1/connect" => {
                let channel_id = param("channel");
                let mut state = relay.lock();
                let state = &mut *state;
                let Some(channel) = is_lower_hex(&channel_id, 32)
                    .then(|| state.channels.get_mut(&channel_id))
                    .flatten()
                else {
                    return (
                        Role::Refused,
                        None,
                        Some((close_code::HOST_OFFLINE, "host offline")),
                    );
                };
                let pending = channel
                    .conns
                    .iter()
                    .filter(|c| state.pipes.get(*c).is_some_and(|p| p.accept.is_none()))
                    .count();
                if pending >= limits.max_pending_per_channel
                    || channel.conns.len() >= limits.max_devices_per_channel
                {
                    return (
                        Role::Refused,
                        None,
                        Some((
                            close_code::TOO_MANY_PEERS,
                            "too many connections for this host",
                        )),
                    );
                }
                let conn = random_hex(16);
                channel.conns.insert(conn.clone());
                state.pipes.insert(
                    conn.clone(),
                    Pipe {
                        device: me.clone(),
                        accept: None,
                        buffered: Vec::new(),
                        buffered_bytes: 0,
                    },
                );
                channel.control.send(Command::Text(
                    json!({ "type": "incoming", "conn": conn }).to_string(),
                ));
                let budget = ByteBudget::new(limits.bytes_per_second, limits.burst_bytes);
                (
                    Role::Device { conn, budget },
                    Some(Instant::now() + limits.accept_timeout),
                    None,
                )
            }
            "/v1/accept" => {
                let (channel_id, conn) = (param("channel"), param("conn"));
                let mut state = relay.lock();
                let state = &mut *state;
                let owned = is_lower_hex(&channel_id, 32)
                    && is_lower_hex(&conn, 32)
                    && state
                        .channels
                        .get(&channel_id)
                        .is_some_and(|c| c.conns.contains(&conn));
                let Some(pipe) = state
                    .pipes
                    .get_mut(&conn)
                    .filter(|p| owned && p.accept.is_none())
                else {
                    return (
                        Role::Refused,
                        None,
                        Some((close_code::BAD_REQUEST, "unknown connection")),
                    );
                };
                pipe.accept = Some(me.clone());
                for chunk in std::mem::take(&mut pipe.buffered) {
                    me.send(Command::Binary(chunk));
                }
                pipe.buffered_bytes = 0;
                let budget = ByteBudget::new(limits.bytes_per_second, limits.burst_bytes);
                (
                    Role::Accept {
                        channel_id,
                        conn,
                        budget,
                    },
                    None,
                    None,
                )
            }
            _ => (
                Role::Refused,
                None,
                Some((close_code::BAD_REQUEST, "unknown path")),
            ),
        }
    }

    fn on_message(
        &mut self,
        relay: &Relay,
        me: &SocketHandle,
        data: Vec<u8>,
        is_binary: bool,
    ) -> Flow {
        match self {
            Role::Host {
                key_hex,
                nonce,
                authed,
            } => {
                if *authed || is_binary {
                    return Flow::Close(close_code::BAD_REQUEST, "unexpected message");
                }
                let Ok(message) = serde_json::from_slice::<Value>(&data) else {
                    return Flow::Close(close_code::BAD_REQUEST, "bad json");
                };
                let signature = message.get("signature").and_then(Value::as_str);
                let valid = message.get("type").and_then(Value::as_str) == Some("auth")
                    && signature
                        .is_some_and(|signature| verify_host_signature(key_hex, nonce, signature));
                let Some(id) = channel_id_for_key(key_hex).filter(|_| valid) else {
                    return Flow::Close(close_code::AUTH_FAILED, "auth failed");
                };
                let mut state = relay.lock();
                if !state.channels.contains_key(&id)
                    && state.channels.len() >= relay.limits.max_channels
                {
                    return Flow::Close(close_code::SERVER_BUSY, "relay full");
                }
                *authed = true;
                let previous = state.channels.insert(
                    id.clone(),
                    Channel {
                        control: me.clone(),
                        conns: HashSet::new(),
                    },
                );
                drop(state);
                if let Some(previous) = previous {
                    previous
                        .control
                        .close(close_code::REPLACED, "replaced by a newer registration");
                }
                me.send(Command::Text(
                    json!({ "type": "registered", "channel": id }).to_string(),
                ));
                relay.log(&format!("channel {} registered", &id[..8]));
                Flow::Continue
            }
            Role::Device { conn, budget } => {
                if !budget.take(data.len()) {
                    return Flow::Close(close_code::RATE_LIMITED, "rate limit");
                }
                let mut state = relay.lock();
                let Some(pipe) = state.pipes.get_mut(conn.as_str()) else {
                    return Flow::Continue;
                };
                if let Some(accept) = &pipe.accept {
                    accept.send(Command::Binary(data));
                    return Flow::Continue;
                }
                if pipe.buffered_bytes + data.len() > relay.limits.max_buffered_bytes {
                    return Flow::Close(close_code::RATE_LIMITED, "buffer limit");
                }
                pipe.buffered_bytes += data.len();
                pipe.buffered.push(data);
                Flow::Continue
            }
            Role::Accept { conn, budget, .. } => {
                if !budget.take(data.len()) {
                    return Flow::Close(close_code::RATE_LIMITED, "rate limit");
                }
                if let Some(pipe) = relay.lock().pipes.get(conn.as_str()) {
                    pipe.device.send(Command::Binary(data));
                }
                Flow::Continue
            }
            Role::Refused => Flow::Continue,
        }
    }

    fn on_deadline(&self, relay: &Relay) -> Flow {
        match self {
            Role::Host { authed: false, .. } => {
                Flow::Close(close_code::AUTH_FAILED, "auth timeout")
            }
            Role::Device { conn, .. }
                if relay
                    .lock()
                    .pipes
                    .get(conn.as_str())
                    .is_some_and(|p| p.accept.is_none()) =>
            {
                Flow::Close(close_code::WAIT_TIMEOUT, "host did not answer")
            }
            _ => Flow::Continue,
        }
    }

    fn on_close(&self, relay: &Relay, me: &SocketHandle) {
        let mut state = relay.lock();
        match self {
            Role::Host {
                key_hex,
                authed: true,
                ..
            } => {
                let Some(id) = channel_id_for_key(key_hex) else {
                    return;
                };
                if state
                    .channels
                    .get(&id)
                    .is_none_or(|c| c.control.id != me.id)
                {
                    return;
                }
                let Some(channel) = state.channels.remove(&id) else {
                    return;
                };
                for conn in &channel.conns {
                    if let Some(pipe) = state.pipes.get(conn) {
                        pipe.device
                            .close(close_code::HOST_OFFLINE, "host went offline");
                        if let Some(accept) = &pipe.accept {
                            accept.close(close_code::HOST_OFFLINE, "host went offline");
                        }
                    }
                }
            }
            Role::Device { conn, .. } => {
                if let Some(pipe) = state.pipes.remove(conn.as_str()) {
                    if let Some(accept) = pipe.accept {
                        accept.close(1000, "phone disconnected");
                    }
                }
                for channel in state.channels.values_mut() {
                    channel.conns.remove(conn.as_str());
                }
            }
            Role::Accept {
                channel_id, conn, ..
            } => {
                if let Some(channel) = state.channels.get_mut(channel_id.as_str()) {
                    channel.conns.remove(conn.as_str());
                }
                if let Some(pipe) = state.pipes.get(conn.as_str()) {
                    pipe.device.close(1000, "host disconnected");
                }
            }
            Role::Host { .. } | Role::Refused => {}
        }
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn is_too_big(error: &axum::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("too long") || text.contains("too big") || text.contains("space limit")
}

async fn run_socket(
    relay: Arc<Relay>,
    socket: WebSocket,
    address: IpAddr,
    path: String,
    query: HashMap<String, String>,
) {
    let (commands, mut queued) = mpsc::unbounded_channel();
    let me = SocketHandle {
        id: relay.next_socket.fetch_add(1, Ordering::Relaxed),
        commands,
    };
    relay.lock().sockets.insert(me.id, me.clone());
    let (mut sink, mut stream) = socket.split();
    let (mut role, mut deadline, refused) = Role::start(&relay, &me, &path, &query);
    if let Some((code, reason)) = refused {
        me.close(code, reason);
    }
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + relay.limits.heartbeat,
        relay.limits.heartbeat,
    );
    let mut alive = true;
    loop {
        let flow = tokio::select! {
            command = queued.recv() => match command {
                Some(Command::Text(text)) => {
                    if sink.send(Message::Text(text.into())).await.is_err() { break }
                    Flow::Continue
                }
                Some(Command::Binary(bytes)) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() { break }
                    Flow::Continue
                }
                Some(Command::Close(code, reason)) => Flow::Close(code, reason),
                Some(Command::Terminate) | None => break,
            },
            message = stream.next() => match message {
                Some(Ok(Message::Binary(bytes))) => role.on_message(&relay, &me, bytes.to_vec(), true),
                Some(Ok(Message::Text(text))) => role.on_message(&relay, &me, text.as_bytes().to_vec(), false),
                Some(Ok(Message::Pong(_))) => { alive = true; Flow::Continue }
                Some(Ok(Message::Ping(_))) => Flow::Continue,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) if is_too_big(&error) => Flow::Close(close_code::MESSAGE_TOO_BIG, "message too big"),
                Some(Err(_)) => break,
            },
            _ = heartbeat.tick() => {
                if !alive { break }
                alive = false;
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break }
                Flow::Continue
            },
            () = sleep_until_some(deadline) => {
                deadline = None;
                role.on_deadline(&relay)
            },
        };
        if let Flow::Close(code, reason) = flow {
            let _ = sink
                .send(Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })))
                .await;
            break;
        }
    }
    role.on_close(&relay, &me);
    let mut state = relay.lock();
    state.sockets.remove(&me.id);
    match state.sockets_by_address.get(&address).copied() {
        Some(count) if count > 1 => {
            state.sockets_by_address.insert(address, count - 1);
        }
        _ => {
            state.sockets_by_address.remove(&address);
        }
    }
}

fn parse_query(uri: &Uri) -> HashMap<String, String> {
    uri.query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default()
}

async fn handle(
    State(relay): State<Arc<Relay>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        let mut response = (StatusCode::NOT_FOUND, "praxis-relay").into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        return response;
    };
    let address = peer.ip();
    if !relay.admit(address) {
        let mut response = StatusCode::TOO_MANY_REQUESTS.into_response();
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        return response;
    }
    *relay.lock().sockets_by_address.entry(address).or_default() += 1;
    let path = uri.path().to_owned();
    let query = parse_query(&uri);
    let limit = relay.limits.max_message_bytes;
    upgrade
        .max_message_size(limit)
        .max_frame_size(limit)
        .on_failed_upgrade({
            let relay = relay.clone();
            move |_| {
                let mut state = relay.lock();
                if let Some(count) = state.sockets_by_address.get_mut(&address) {
                    *count = count.saturating_sub(1);
                }
            }
        })
        .on_upgrade(move |socket| run_socket(relay, socket, address, path, query))
}

/// A running relay; dropping it stops it.
pub struct RelayServer {
    relay: Arc<Relay>,
    port: u16,
    tasks: Vec<JoinHandle<()>>,
}

impl RelayServer {
    pub async fn start(options: RelayServerOptions) -> std::io::Result<Self> {
        let relay = Arc::new(Relay {
            limits: options.limits,
            on_log: options.on_log,
            state: Mutex::new(RelayState::default()),
            next_socket: AtomicU64::new(1),
        });
        let address = options
            .address
            .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0)));
        let listener = tokio::net::TcpListener::bind(address).await?;
        let port = listener.local_addr()?.port();
        let app = Router::new().fallback(handle).with_state(relay.clone());
        let serve = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let pruner = tokio::spawn({
            let relay = relay.clone();
            async move {
                let mut tick = tokio::time::interval(relay.limits.heartbeat);
                loop {
                    tick.tick().await;
                    relay.prune_connect_history();
                }
            }
        });
        relay.log(&format!("relay listening on {port}"));
        Ok(Self {
            relay,
            port,
            tasks: vec![serve, pruner],
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn channel_count(&self) -> usize {
        self.relay.lock().channels.len()
    }

    /// Stops listening and drops every socket.
    pub fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        let mut state = self.relay.lock();
        for socket in state.sockets.values() {
            socket.send(Command::Terminate);
        }
        state.channels.clear();
    }
}

impl Drop for RelayServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests;
