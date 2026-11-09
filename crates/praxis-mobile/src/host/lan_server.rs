//! TCP/Noise host transport (`mobileLanServer.ts`), shared by LAN and relay streams.
//!
//! The desktop supplies an OS interface snapshot at bind time. Only explicit local addresses
//! are bound. Device grants come from the authenticated Noise key, replacing wire caller claims.

use super::access::{
    MobileAccessMode, MobileAccessPolicy, MobileAccessRefusal, MobilePeerContext,
    evaluate_mobile_access, is_private_address,
};
use super::application::{
    MobileHostApplication, dispatch_mobile_command, handle_mobile_command, handle_mobile_read,
};
use super::ledger::MOBILE_REPLAY_LIMIT;
use super::protocol::{
    MobileCaller, MobileCapability, MobileReadOperation, validate_mobile_command,
};
use crate::noise::KeyPair;
use crate::relay::hex;
use crate::secure_channel::{RecordAssembler, SecureChannel, SecureChannelOptions};
use crate::wire::{
    MobileConnectionStatus, MobileConnectionStatusCode as Status, MobileRequestFrame,
    MobileRequestKind, mobile_connection_status,
};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, timeout};

#[derive(Clone, Debug)]
pub struct MobileLanAuthorizedPeer {
    pub device_id: String,
    pub capabilities: Vec<MobileCapability>,
    /// Empty is a desktop-wide grant, matching the TypeScript registry.
    pub project_ids: Vec<String>,
}
pub type MobilePeerAuthorizer = Arc<dyn Fn(&str) -> Option<MobileLanAuthorizedPeer> + Send + Sync>;
pub type UnpairedPeerHandler =
    Arc<dyn Fn(&str, Option<&str>) -> MobileConnectionStatus + Send + Sync>;
pub type MobileTransportLog = Arc<dyn Fn(&str) + Send + Sync>;
pub struct MobileLanServerDeps {
    pub app: MobileHostApplication,
    /// The trusted desktop handlers share admission/outcomes with other transports.
    /// Envelope, capability and project checks still run before forwarding.
    pub commands_own_ledger: bool,
    pub host_static_key: KeyPair,
    pub pairing_code: Option<String>,
    pub authorize_peer: Option<MobilePeerAuthorizer>,
    pub on_unpaired_peer: Option<UnpairedPeerHandler>,
    pub on_log: Option<MobileTransportLog>,
    pub handshake_timeout: Duration,
    pub max_pending_peers: usize,
    pub max_peers_per_address: usize,
}
impl MobileLanServerDeps {
    pub fn new(app: MobileHostApplication, host_static_key: KeyPair) -> Self {
        Self {
            app,
            commands_own_ledger: false,
            host_static_key,
            pairing_code: None,
            authorize_peer: None,
            on_unpaired_peer: None,
            on_log: None,
            handshake_timeout: Duration::from_secs(15),
            max_pending_peers: 32,
            max_peers_per_address: 4,
        }
    }
}
/// An address from the desktop's OS inventory, including an IPv6 scope id if needed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MobileLocalAddress {
    pub interface_name: String,
    pub address: SocketAddr,
}
#[derive(Clone, Default)]
struct PeerControl {
    grant: Option<MobileLanAuthorizedPeer>,
    close: Option<MobileConnectionStatus>,
}
struct TrackedPeer {
    remote_address: String,
    public_key: Option<String>,
    control: watch::Sender<PeerControl>,
}
struct Shared {
    deps: MobileLanServerDeps,
    policy: RwLock<MobileAccessPolicy>,
    peers: Mutex<HashMap<u64, TrackedPeer>>,
    next_peer: AtomicU64,
    closed: AtomicBool,
}
impl Shared {
    fn peers(&self) -> MutexGuard<'_, HashMap<u64, TrackedPeer>> {
        self.peers.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn policy(&self) -> MobileAccessPolicy {
        self.policy
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
    fn log(&self, message: &str) {
        if let Some(log) = &self.deps.on_log {
            log(message);
        }
    }
}
#[derive(Default)]
struct Binding {
    addresses: Vec<MobileLocalAddress>,
    port: Option<u16>,
    error: Option<String>,
    stop: Option<watch::Sender<bool>>,
    tasks: Vec<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct MobileLanServer {
    shared: Arc<Shared>,
    binding: Arc<tokio::sync::Mutex<Binding>>,
}
impl Drop for MobileLanServer {
    fn drop(&mut self) {
        if Arc::strong_count(&self.binding) == 1 {
            self.shared.closed.store(true, Ordering::SeqCst);
            self.drop_all(mobile_connection_status(Status::HostShutdown, None));
            if let Ok(mut binding) = self.binding.try_lock() {
                if let Some(stop) = binding.stop.take() {
                    let _ = stop.send(true);
                }
                for task in binding.tasks.drain(..) {
                    task.abort();
                }
            }
        }
    }
}
impl MobileLanServer {
    pub fn new(deps: MobileLanServerDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                deps,
                policy: RwLock::new(MobileAccessPolicy::off()),
                peers: Mutex::default(),
                next_peer: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
            binding: Arc::default(),
        }
    }
    pub fn connection_count(&self) -> usize {
        self.shared.peers().len()
    }
    pub async fn port(&self) -> Option<u16> {
        self.binding.lock().await.port
    }
    pub async fn addresses(&self) -> Vec<MobileLocalAddress> {
        self.binding.lock().await.addresses.clone()
    }
    pub async fn bind_error(&self) -> Option<String> {
        self.binding.lock().await.error.clone()
    }
    /// Binds all eligible addresses on one port; partial binds roll back in full.
    pub async fn start(
        &self,
        port: u16,
        policy: MobileAccessPolicy,
        addresses: &[MobileLocalAddress],
    ) -> Result<(), String> {
        let mut selected = vec![];
        for address in addresses {
            if !is_private_address(&address.address.ip().to_string())
                || address.address.ip().is_unspecified()
                || (!policy.allowed_interfaces.is_empty()
                    && !policy.allowed_interfaces.contains(&address.interface_name))
            {
                continue;
            }
            let mut address = address.clone();
            address.address.set_port(0);
            if !selected
                .iter()
                .any(|other: &MobileLocalAddress| other.address == address.address)
            {
                selected.push(address);
            }
        }
        if selected.is_empty() {
            return Err("No local addresses match the selected mobile interfaces.".into());
        }
        let mut binding = self.binding.lock().await;
        if port != 0 && binding.port == Some(port) && binding.addresses == selected {
            self.apply_policy(policy, false);
            binding.error = None;
            return Ok(());
        }
        self.stop_binding(&mut binding).await;
        *self
            .shared
            .policy
            .write()
            .unwrap_or_else(PoisonError::into_inner) = policy;
        let mut chosen_port = port;
        let mut listeners = vec![];
        for local in &selected {
            let mut address = local.address;
            address.set_port(chosen_port);
            match TcpListener::bind(address).await {
                Ok(listener) => {
                    chosen_port = listener.local_addr().map_err(|e| e.to_string())?.port();
                    listeners.push((listener, local.interface_name.clone()));
                }
                Err(error) => {
                    binding.error = Some(error.to_string());
                    return Err(error.to_string());
                }
            }
        }
        let (stop, _) = watch::channel(false);
        for (listener, interface_name) in listeners {
            let shared = self.shared.clone();
            let mut stopping = stop.subscribe();
            binding.tasks.push(tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = stopping.changed() => break,
                        result = listener.accept() => match result {
                            Ok((stream, address)) => { accept_stream(&shared, stream, MobilePeerContext { interface_name: interface_name.clone(), remote_address: address.ip().to_string(), ..MobilePeerContext::default() }); }
                            Err(_) => break,
                        }
                    }
                }
            }));
        }
        binding.stop = Some(stop);
        binding.port = Some(chosen_port);
        binding.addresses = selected;
        binding.error = None;
        self.shared.log("[mobile] LAN listener bound.");
        Ok(())
    }
    async fn stop_binding(&self, binding: &mut Binding) {
        if let Some(stop) = binding.stop.take() {
            let _ = stop.send(true);
        }
        // Stop accepts before draining peers, including concurrent accepts.
        for task in binding.tasks.drain(..) {
            let _ = task.await;
        }
        self.drop_all(mobile_connection_status(Status::HostShutdown, None));
        binding.port = None;
        binding.addresses.clear();
    }
    pub async fn stop(&self) {
        self.stop_binding(&mut *self.binding.lock().await).await;
    }
    pub fn apply_policy(&self, policy: MobileAccessPolicy, drop_connections: bool) {
        let off = policy.mode == MobileAccessMode::Off;
        *self
            .shared
            .policy
            .write()
            .unwrap_or_else(PoisonError::into_inner) = policy;
        if off || drop_connections {
            self.drop_all(mobile_connection_status(
                if off {
                    Status::AccessDisabled
                } else {
                    Status::HostShutdown
                },
                None,
            ));
        }
    }
    pub fn drop_all(&self, status: MobileConnectionStatus) {
        for (_, peer) in self.shared.peers().drain() {
            peer.control
                .send_modify(|control| control.close = Some(status.clone()));
        }
    }
    pub fn drop_device(&self, device_id: &str, status: MobileConnectionStatus) -> usize {
        self.drop_matching(
            |peer| {
                peer.control
                    .borrow()
                    .grant
                    .as_ref()
                    .is_some_and(|grant| grant.device_id == device_id)
            },
            status,
        )
    }
    pub fn drop_public_key(&self, public_key: &str, status: MobileConnectionStatus) -> usize {
        self.drop_matching(
            |peer| {
                peer.public_key
                    .as_deref()
                    .is_some_and(|key| key.eq_ignore_ascii_case(public_key))
            },
            status,
        )
    }
    fn drop_matching(
        &self,
        predicate: impl Fn(&TrackedPeer) -> bool,
        status: MobileConnectionStatus,
    ) -> usize {
        let mut peers = self.shared.peers();
        let ids: Vec<_> = peers
            .iter()
            .filter(|(_, peer)| predicate(peer))
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            if let Some(peer) = peers.remove(id) {
                peer.control
                    .send_modify(|control| control.close = Some(status.clone()));
            }
        }
        ids.len()
    }
    pub fn promote_pending(&self, public_key: &str, grant: MobileLanAuthorizedPeer) {
        for peer in self.shared.peers().values() {
            if peer
                .public_key
                .as_deref()
                .is_some_and(|key| key.eq_ignore_ascii_case(public_key))
            {
                peer.control.send_modify(|control| {
                    if control.close.is_none() {
                        control.grant = Some(grant.clone());
                    }
                });
            }
        }
    }
    /// Relay callers set `relay_route`, with no local interface. False means admission refused.
    pub fn accept_stream<S>(&self, stream: S, context: MobilePeerContext) -> bool
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        accept_stream(&self.shared, stream, context)
    }
}
fn accept_stream<S>(shared: &Arc<Shared>, stream: S, context: MobilePeerContext) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut peers = shared.peers();
    let pending: Vec<_> = peers
        .values()
        .filter(|peer| peer.control.borrow().grant.is_none())
        .collect();
    if shared.closed.load(Ordering::SeqCst)
        || peers.len() >= 128
        || pending.len() >= shared.deps.max_pending_peers
        || pending
            .iter()
            .filter(|peer| peer.remote_address == context.remote_address)
            .count()
            >= shared.deps.max_peers_per_address
    {
        drop(pending);
        drop(peers);
        shared.log("[mobile] pending peer limit reached.");
        return false;
    }
    let id = shared.next_peer.fetch_add(1, Ordering::Relaxed);
    let (control, receiver) = watch::channel(PeerControl::default());
    peers.insert(
        id,
        TrackedPeer {
            remote_address: context.remote_address.clone(),
            public_key: None,
            control,
        },
    );
    drop(peers);
    let shared = shared.clone();
    tokio::spawn(async move {
        let _lease = PeerLease {
            shared: shared.clone(),
            id,
        };
        if let Err(error) = serve_peer(shared.clone(), id, stream, context, receiver).await {
            shared.log(&format!("[mobile] peer closed: {error}"));
        }
    });
    true
}
struct PeerLease {
    shared: Arc<Shared>,
    id: u64,
}
// Revoking a socket must not abort an admitted mutation before it records its outcome.
#[derive(Default)]
struct PeerRequests(JoinSet<Value>);
impl Drop for PeerRequests {
    fn drop(&mut self) {
        self.0.detach_all();
    }
}
impl Drop for PeerLease {
    fn drop(&mut self) {
        self.shared.peers().remove(&self.id);
    }
}
fn refusal(reason: MobileAccessRefusal) -> MobileConnectionStatus {
    mobile_connection_status(
        if reason == MobileAccessRefusal::Disabled {
            Status::AccessDisabled
        } else {
            Status::AccessDenied
        },
        None,
    )
}
async fn send<S: AsyncWrite + Unpin>(
    stream: &mut S,
    channel: &mut SecureChannel,
    value: Value,
) -> Result<(), String> {
    let encoded = channel
        .encrypt(&serde_json::to_vec(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    timeout(Duration::from_millis(500), stream.write_all(&encoded))
        .await
        .map_err(|_| "Mobile peer is not reading.".to_owned())?
        .map_err(|e| e.to_string())
}
async fn send_status<S: AsyncWrite + Unpin>(
    stream: &mut S,
    channel: &mut SecureChannel,
    status: MobileConnectionStatus,
) -> Result<(), String> {
    send(stream, channel, json!({"kind": "status", "status": status})).await
}
async fn flush_events<S: AsyncWrite + Unpin>(
    shared: &Shared,
    grant: &MobileLanAuthorizedPeer,
    flushed: &mut u64,
    stream: &mut S,
    channel: &mut SecureChannel,
) -> Result<(), String> {
    for envelope in shared.deps.app.ledger.replay(*flushed, MOBILE_REPLAY_LIMIT) {
        *flushed = (*flushed).max(envelope.sequence);
        let host_wide =
            envelope.event.get("type").and_then(Value::as_str) == Some("host.appearance");
        if !host_wide
            && !grant.project_ids.is_empty()
            && !envelope
                .target
                .project_id
                .as_ref()
                .is_some_and(|id| grant.project_ids.contains(id))
        {
            continue;
        }
        send(
            stream,
            channel,
            json!({"kind": "event", "envelope": envelope}),
        )
        .await?;
    }
    Ok(())
}
fn authorize_payload(
    shared: &Shared,
    grant: &MobileLanAuthorizedPeer,
    request: &MobileRequestFrame,
) -> Result<Value, String> {
    let mut supplied = request.payload.clone();
    let operation = supplied
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let project = supplied
        .pointer("/target/projectId")
        .and_then(Value::as_str);
    let unscoped = MobileReadOperation::parse(&operation).is_some_and(|op| op.is_unscoped());
    if !grant.project_ids.is_empty() {
        if !unscoped && project.is_none_or(str::is_empty) {
            return Err("This operation requires an authorised project.".into());
        }
        if let Some(project) = project.filter(|id| !id.is_empty()) {
            if !grant.project_ids.iter().any(|id| id == project) {
                return Err(format!(
                    "The mobile device is not authorised for project {project}."
                ));
            }
        }
    }
    if !supplied.is_object() {
        return Err("A mobile request requires an operation and target.".into());
    }
    supplied["caller"] = json!(MobileCaller {
        device_id: grant.device_id.clone(),
        subject: None,
        capabilities: grant.capabilities.clone()
    });
    if request.kind == MobileRequestKind::Read
        && !MobileReadOperation::parse(&operation)
            .is_some_and(|op| shared.deps.app.reads.contains_key(&op))
    {
        return Err(format!(
            "unsupported-operation:This desktop does not support {operation}. Update Praxis on the desktop."
        ));
    }
    Ok(supplied)
}
async fn dispatch(
    shared: Arc<Shared>,
    grant: MobileLanAuthorizedPeer,
    request: MobileRequestFrame,
) -> Value {
    let result = async {
        let supplied = authorize_payload(&shared, &grant, &request)?;
        let project_list = supplied["operation"] == "projects.snapshot"
            && supplied
                .pointer("/target/projectId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty);
        let mut value = match request.kind {
            MobileRequestKind::Command => {
                let command = serde_json::from_value(supplied).map_err(|e| e.to_string())?;
                if shared.deps.commands_own_ledger {
                    validate_mobile_command(&command).map_err(|error| error.message)?;
                    dispatch_mobile_command(command, &shared.deps.app.commands)
                        .await
                        .map_err(Into::into)
                } else {
                    handle_mobile_command(&shared.deps.app, command).await
                }
            }
            _ => {
                handle_mobile_read(
                    &shared.deps.app,
                    serde_json::from_value(supplied).map_err(|e| e.to_string())?,
                )
                .await
            }
        }
        .map_err(|e| e.0)?;
        if project_list && !grant.project_ids.is_empty() {
            if let Some(projects) = value.get_mut("projects").and_then(Value::as_array_mut) {
                projects.retain(|project| {
                    project
                        .get("projectId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| grant.project_ids.iter().any(|allowed| allowed == id))
                });
            }
        }
        Ok::<_, String>(value)
    }
    .await;
    match result {
        Ok(value) => json!({"id": request.id, "kind": "reply", "ok": true, "value": value}),
        Err(error) => {
            let (code, message) = error
                .strip_prefix("unsupported-operation:")
                .map_or(("rejected", error.as_str()), |message| {
                    ("unsupported-operation", message)
                });
            json!({"id": request.id, "kind": "reply", "ok": false, "code": code, "error": message})
        }
    }
}
fn replay_after(payload: &Value) -> u64 {
    let value = payload.get("afterSequence");
    let number = value
        .and_then(Value::as_f64)
        .or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|s| s.trim().parse().ok())
        })
        .unwrap_or(0.0);
    if number.is_finite() && number > 0.0 {
        number as u64
    } else {
        0
    }
}
async fn serve_peer<S>(
    shared: Arc<Shared>,
    id: u64,
    mut stream: S,
    mut context: MobilePeerContext,
    mut control: watch::Receiver<PeerControl>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut options = SecureChannelOptions::new(shared.deps.host_static_key.clone());
    options.prologue = shared
        .deps
        .pairing_code
        .as_ref()
        .map(|code| code.as_bytes().to_vec());
    let mut channel = SecureChannel::responder(options).map_err(|e| e.to_string())?;
    let mut assembler = RecordAssembler::new();
    let mut records: VecDeque<Vec<u8>> = VecDeque::new();
    let mut buffer = [0; 16384];
    let mut key = None;
    let mut grant = None;
    let mut flushed = 0;
    let mut pending = PeerRequests::default();
    let deadline = Instant::now() + shared.deps.handshake_timeout;
    let mut events = tokio::time::interval(Duration::from_millis(50));
    events.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let next_control = control.borrow_and_update().clone();
        if let Some(status) = next_control.close {
            if channel.is_open() {
                let _ = send_status(&mut stream, &mut channel, status).await;
            }
            break;
        }
        if context.authenticated {
            if let Err(reason) = evaluate_mobile_access(&shared.policy(), &context) {
                send_status(&mut stream, &mut channel, refusal(reason)).await?;
                break;
            }
        }
        if let Some(next) = next_control.grant {
            if grant.is_none() {
                if let Err(reason) = evaluate_mobile_access(&shared.policy(), &context) {
                    send_status(&mut stream, &mut channel, refusal(reason)).await?;
                    break;
                }
                grant = Some(next);
                flushed = shared.deps.app.ledger.latest_sequence();
                send_status(
                    &mut stream,
                    &mut channel,
                    mobile_connection_status(Status::Ready, None),
                )
                .await?;
            } else {
                grant = Some(next);
            }
        }
        if pending.0.len() < 32 {
            if let Some(record) = records.pop_front() {
                if !channel.is_open() {
                    channel
                        .read_handshake_message(&record)
                        .map_err(|e| e.to_string())?;
                    let reply = channel
                        .next_handshake_message(&[])
                        .map_err(|e| e.to_string())?;
                    timeout(Duration::from_millis(500), stream.write_all(&reply))
                        .await
                        .map_err(|_| "Handshake write timed out.".to_owned())?
                        .map_err(|e| e.to_string())?;
                    context.authenticated = channel.is_open();
                    if let Err(reason) = evaluate_mobile_access(&shared.policy(), &context) {
                        send_status(&mut stream, &mut channel, refusal(reason)).await?;
                        break;
                    }
                    let public_key = hex(&channel
                        .peer_static_public_key()
                        .ok_or("Missing peer key.")?);
                    if let Some(peer) = shared.peers().get_mut(&id) {
                        peer.public_key = Some(public_key.clone());
                    }
                    let allowed = shared
                        .deps
                        .authorize_peer
                        .as_ref()
                        .and_then(|authorize| authorize(&public_key));
                    key = Some(public_key);
                    if let Some(allowed) = allowed {
                        if let Some(peer) = shared.peers().get(&id) {
                            peer.control.send_modify(|state| {
                                if state.close.is_none() {
                                    state.grant = Some(allowed.clone());
                                }
                            });
                        }
                        continue;
                    }
                    let status = shared
                        .deps
                        .on_unpaired_peer
                        .as_ref()
                        .map(|handler| handler(key.as_deref().expect("key"), None))
                        .unwrap_or_else(|| mobile_connection_status(Status::AccessDenied, None));
                    let hold = matches!(
                        status.code,
                        Status::PairingRequired | Status::PairingPending
                    );
                    send_status(&mut stream, &mut channel, status).await?;
                    if !hold {
                        break;
                    }
                    continue;
                }
                let request: MobileRequestFrame =
                    serde_json::from_slice(&channel.decrypt(&record).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                if request.kind == MobileRequestKind::Pair {
                    if grant.is_some() {
                        send(&mut stream, &mut channel, json!({"id": request.id, "kind": "reply", "ok": true, "value": {"paired": true}})).await?;
                    } else {
                        let status = shared
                            .deps
                            .on_unpaired_peer
                            .as_ref()
                            .map(|handler| {
                                handler(
                                    key.as_deref().unwrap_or_default(),
                                    Some(
                                        request
                                            .payload
                                            .get("tokenId")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default(),
                                    ),
                                )
                            })
                            .unwrap_or_else(|| {
                                mobile_connection_status(Status::PairingRequired, None)
                            });
                        let hold = matches!(
                            status.code,
                            Status::PairingRequired | Status::PairingPending
                        );
                        send_status(&mut stream, &mut channel, status).await?;
                        if !hold {
                            break;
                        }
                    }
                } else if let Some(allowed) = grant.clone() {
                    if request.kind == MobileRequestKind::Replay {
                        flushed = replay_after(&request.payload);
                        let oldest = shared.deps.app.ledger.oldest_retained_sequence();
                        let mut value = json!({"replaying": true, "latestSequence": shared.deps.app.ledger.latest_sequence()});
                        if flushed < oldest.saturating_sub(1) {
                            value["truncated"] = json!(true);
                        }
                        flush_events(&shared, &allowed, &mut flushed, &mut stream, &mut channel)
                            .await?;
                        send(
                            &mut stream,
                            &mut channel,
                            json!({"id": request.id, "kind": "reply", "ok": true, "value": value}),
                        )
                        .await?;
                    } else {
                        // In-flight mutations finish and record their ledger outcome after revocation,
                        // matching the TS host. Other requests, including cancel, remain serviceable.
                        pending.0.spawn(dispatch(shared.clone(), allowed, request));
                    }
                } else {
                    send(&mut stream, &mut channel, json!({"id": request.id, "kind": "reply", "ok": false, "code": "pairing-pending", "error": "This phone is waiting for confirmation on the desktop."})).await?;
                }
                continue;
            }
        }
        tokio::select! {
            biased;
            changed = control.changed() => { if changed.is_err() { break; } }
            _ = tokio::time::sleep_until(deadline), if grant.is_none() => break,
            result = pending.0.join_next(), if !pending.0.is_empty() => {
                let reply = result.ok_or("Missing request outcome.")?.map_err(|e| e.to_string())?;
                if let Some(allowed) = &grant { flush_events(&shared, allowed, &mut flushed, &mut stream, &mut channel).await?; }
                send(&mut stream, &mut channel, reply).await?;
            }
            _ = events.tick(), if grant.is_some() => { flush_events(&shared, grant.as_ref().expect("grant"), &mut flushed, &mut stream, &mut channel).await?; }
            result = stream.read(&mut buffer), if pending.0.len() < 32 => {
                let count = result.map_err(|e| e.to_string())?;
                if count == 0 { break; }
                records.extend(assembler.push(&buffer[..count]).map_err(|e| e.to_string())?);
            }
        }
    }
    let _ = timeout(Duration::from_millis(500), stream.shutdown()).await;
    Ok(())
}
#[cfg(test)]
pub(crate) mod tests;
