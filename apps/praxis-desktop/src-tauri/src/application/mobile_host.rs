//! The desktop side of mobile access: the listener lifecycle, pairing ledger, host identity,
//! LAN discovery and the Settings snapshot (`mobileListenerInstance.ts`, `mobilePairingInstance.ts`,
//! `mobileDiscoveryAdvertiser.ts` and `mobileHostIdentity.ts` ports).
//!
//! The Noise/TCP listener itself is `praxis_host::mobile_bridge`; it asks this module, in
//! process, who a phone is (`mobile.authorizePeer` / `mobile.unpairedPeer`).

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use praxis_host::{HostCallClient, HostContext, HostInboundReply, HostWireFrame};
use praxis_mobile::host::access::{
    DEFAULT_MOBILE_LISTENER_PORT, MobileAccessMode, MobileListener,
    mobile_access_policy_from_settings, resolve_mobile_listener_change,
};
use praxis_mobile::host::identity::{MobileHostIdentity, MobileIdentityOverrides, MobileSecretStore};
use praxis_mobile::host::pairing::{
    MobileEndpoint, MobileInvitationDetails, MobileRelayRoute, fingerprint_mobile_host_key,
};
use praxis_mobile::host::pairing_registry::{
    JsonFilePairingPersist, MobilePairingGrant, MobilePairingRegistry, unpaired_peer_status,
};
use praxis_mobile::host::protocol::MobileCapability;
use praxis_mobile::wire::{MobileConnectionStatusCode, mobile_connection_status};
use serde_json::{Value, json};

use super::runtime::block_on;
use super::Result;

const DISCOVERY_ADDRESS: Ipv4Addr = Ipv4Addr::new(239, 255, 90, 90);
const DISCOVERY_PORT: u16 = 43199;
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(1500);

struct HostSecrets(HostContext);

#[async_trait]
impl MobileSecretStore for HostSecrets {
    async fn get(&self, key: &str) -> std::result::Result<Option<String>, String> {
        Ok(self.0.secrets().get(key))
    }
    async fn store(&self, key: &str, value: &str) -> std::result::Result<(), String> {
        self.0.secrets().set(key, value);
        Ok(())
    }
    async fn delete(&self, key: &str) -> std::result::Result<(), String> {
        self.0.secrets().delete(key);
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Non-loopback IPv4 interfaces (`lanInterfaces`), plus the loopback ones when `include_internal`.
fn interfaces(include_internal: bool) -> Vec<(String, Ipv4Addr)> {
    use nix::ifaddrs::getifaddrs;
    use nix::net::if_::InterfaceFlags;
    let mut found: Vec<(String, Ipv4Addr)> = Vec::new();
    if let Ok(all) = getifaddrs() {
        for entry in all {
            if !entry.flags.contains(InterfaceFlags::IFF_UP) {
                continue;
            }
            let internal = entry.flags.contains(InterfaceFlags::IFF_LOOPBACK);
            if internal && !include_internal {
                continue;
            }
            let Some(address) = entry.address.as_ref().and_then(|a| a.as_sockaddr_in()) else { continue };
            let ip = Ipv4Addr::from(address.ip());
            if !found.iter().any(|(_, existing)| *existing == ip) {
                found.push((entry.interface_name.clone(), ip));
            }
        }
    }
    found
}

fn machine_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Praxis desktop".to_owned())
}

/// Untrusted LAN discovery hints while the listener is bound (never a token or key).
struct Advertiser {
    running: Arc<AtomicBool>,
}

impl Advertiser {
    fn start(payload: String) -> Option<Self> {
        let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
        let _ = socket.set_multicast_ttl_v4(1);
        let running = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&running);
        std::thread::spawn(move || {
            while flag.load(Ordering::SeqCst) {
                let _ = socket.send_to(payload.as_bytes(), SocketAddr::from((DISCOVERY_ADDRESS, DISCOVERY_PORT)));
                std::thread::sleep(DISCOVERY_INTERVAL);
            }
        });
        Some(Self { running })
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

pub struct MobileHost {
    host: HostContext,
    registry: Mutex<MobilePairingRegistry>,
    identity: MobileHostIdentity<HostSecrets>,
    listener: Mutex<Option<MobileListener>>,
    bind_error: Mutex<Option<String>>,
    advertiser: Mutex<Option<Advertiser>>,
    projects: Mutex<Vec<Value>>,
    change: Mutex<()>,
}

fn capabilities(grant: &Value) -> Vec<MobileCapability> {
    grant["capabilities"]
        .as_array()
        .map(|items| items.iter().filter_map(|c| serde_json::from_value(c.clone()).ok()).collect())
        .unwrap_or_default()
}

impl MobileHost {
    pub fn new(host: &HostContext) -> Arc<Self> {
        let path = host.config().user_data_dir.join("mobile-pairing.json");
        Arc::new(Self {
            host: host.clone(),
            registry: Mutex::new(MobilePairingRegistry::new(Box::new(JsonFilePairingPersist::new(path)))),
            identity: MobileHostIdentity::new(HostSecrets(host.clone()), MobileIdentityOverrides::from_env()),
            listener: Mutex::new(None),
            bind_error: Mutex::new(None),
            advertiser: Mutex::new(None),
            projects: Mutex::new(Vec::new()),
            change: Mutex::new(()),
        })
    }

    fn rpc(&self, channel: &str, params: Value) -> std::result::Result<Value, String> {
        let response = self.host.dispatch_rpc(praxis_contracts::RustRpcRequest {
            id: "mobile-host".into(),
            channel: channel.into(),
            args: vec![params],
        });
        if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response.error.map_or_else(|| "The mobile listener returned no error.".into(), |e| e.message))
        }
    }

    /// The stable id the host presents to phones.
    pub fn host_id(&self) -> String {
        block_on(self.identity.host_id())
    }

    pub fn host_name(&self) -> String {
        self.host_label()
    }

    /// Phone events are not streamed from this build yet, so the log has no sequence to report.
    pub fn latest_sequence(&self) -> u64 {
        0
    }

    /// The pairing record behind a device id, the host key's fingerprint and the access mode.
    pub fn device_view(&self, device_id: &str) -> (Option<praxis_mobile::host::pairing::MobilePairedDevice>, Option<String>, String) {
        let device = lock(&self.registry)
            .list_devices()
            .iter()
            .find(|candidate| candidate.device_id == device_id && candidate.revoked_at.is_none())
            .cloned();
        let fingerprint = block_on(self.identity.static_key()).ok().map(|key| fingerprint_mobile_host_key(&hex(&key.public_key())));
        (device, fingerprint, self.host.settings().read().mobile_access.mode.clone())
    }

    fn log(&self, line: &str) {
        super::log_bus::log(&self.host, line);
    }

    fn mode(&self) -> MobileAccessMode {
        MobileAccessMode::parse(&self.host.settings().read().mobile_access.mode)
    }

    fn host_label(&self) -> String {
        let name = self.host.settings().read().mobile_access.host_name.trim().to_owned();
        if name.is_empty() { machine_name() } else { name }
    }

    fn configured_port(&self) -> Option<u16> {
        std::env::var("PRAXIS_MOBILE_PORT").ok().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0)
    }

    fn emit_pairing_changed(&self) {
        let snapshot = self.snapshot();
        self.host.events().emit("mobile:pairingChanged", Some(snapshot));
    }

    // ── the listener's questions ─────────────────────────────────────────

    pub fn authorize_peer(&self, public_key: &str) -> Value {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut registry = lock(&self.registry);
        let Some(device) = registry.authorize(public_key, &now).cloned() else { return Value::Null };
        registry.touch(public_key, &now);
        json!({
            "deviceId": device.device_id,
            "capabilities": device.granted_capabilities(),
            "projectIds": device.project_ids
        })
    }

    pub fn unpaired_peer(&self, public_key: &str, token_id: Option<&str>) -> Value {
        let label = self.host_label();
        let status = unpaired_peer_status(&mut lock(&self.registry), self.mode(), &label, public_key, token_id);
        if token_id.is_some() {
            self.emit_pairing_changed();
        }
        serde_json::to_value(status).unwrap_or(Value::Null)
    }

    // ── the listener lifecycle ───────────────────────────────────────────

    /// Brings the bound listener in line with the persisted settings. `rebind` forgets the previous
    /// listener (after a host-key reset), so the socket is bound again with the new key.
    pub fn apply_mobile_access(&self, rebind: bool) {
        let _serial = lock(&self.change);
        let settings = self.host.settings().read().mobile_access.clone();
        let change = {
            let mut listener = lock(&self.listener);
            let previous = if rebind { None } else { *listener };
            let change = resolve_mobile_listener_change(previous.as_ref(), &settings, self.configured_port());
            *listener = Some(change.listener);
            change
        };
        if change.bind || change.unbind || change.drop_connections {
            self.log(&format!("[mobile] {}", change.reason));
        }
        let policy = mobile_access_policy_from_settings(&settings);
        *lock(&self.bind_error) = None;
        let outcome: std::result::Result<(), String> = (|| {
            if change.unbind {
                self.rpc("mobile:stop", Value::Null)?;
            } else if let (true, Some(port)) = (change.bind, change.listener.port) {
                let key = block_on(self.identity.static_key())?;
                // A Noise prologue is opt-in (`PRAXIS_MOBILE_PAIRING_CODE`): an invitation does not carry
                // one, so a generated code the phone cannot know would refuse every real pairing.
                let code = std::env::var("PRAXIS_MOBILE_PAIRING_CODE").ok().map(|c| c.trim().to_owned()).filter(|c| !c.is_empty());
                let addresses: Vec<Value> = interfaces(true)
                    .into_iter()
                    .map(|(name, address)| json!({ "interfaceName": name, "address": address.to_string() }))
                    .collect();
                self.rpc(
                    "mobile:start",
                    json!({
                        "port": port, "policy": policy, "addresses": addresses,
                        "hostPrivateKey": hex(key.private_key().as_ref()), "pairingCode": code
                    }),
                )?;
                if change.drop_connections {
                    self.rpc("mobile:applyPolicy", json!({ "policy": policy, "dropConnections": true }))?;
                }
            } else if change.listener.bound || change.drop_connections {
                self.rpc("mobile:applyPolicy", json!({ "policy": policy, "dropConnections": change.drop_connections }))?;
            }
            Ok(())
        })();
        if let Err(message) = outcome {
            self.log(&format!("[mobile] listener change failed: {message}"));
            *lock(&self.bind_error) = Some(message);
        }
        self.refresh_discovery();
        self.emit_pairing_changed();
    }

    fn listening_port(&self) -> Option<u16> {
        let status = self.rpc("mobile:status", Value::Null).ok()?;
        status["listening"].as_bool().filter(|l| *l)?;
        status["port"].as_u64().map(|p| p as u16)
    }

    fn refresh_discovery(&self) {
        let Some(port) = self.listening_port() else {
            *lock(&self.advertiser) = None;
            return;
        };
        let (Ok(key), host_id) = (block_on(self.identity.static_key()), block_on(self.identity.host_id())) else {
            *lock(&self.advertiser) = None;
            return;
        };
        let addresses: Vec<String> = interfaces(false).into_iter().map(|(_, a)| a.to_string()).collect();
        let payload = json!({
            "v": 1, "hostId": host_id, "displayName": self.host_label(),
            "fingerprint": fingerprint_mobile_host_key(&hex(&key.public_key())), "port": port, "addresses": addresses
        })
        .to_string();
        *lock(&self.advertiser) = Advertiser::start(payload);
    }

    /// Called once at startup; binds nothing while the mode is `off`.
    pub fn init(self: &Arc<Self>) {
        let host = Arc::clone(self);
        std::thread::spawn(move || host.apply_mobile_access(false));
        let host = Arc::clone(self);
        self.host.events().on_event(move |event| {
            if event.channel == "settings:changed" {
                let host = Arc::clone(&host);
                std::thread::spawn(move || host.apply_mobile_access(false));
            }
        });
    }

    // ── Settings ─────────────────────────────────────────────────────────

    pub fn remember_projects(&self, projects: Vec<Value>) {
        *lock(&self.projects) = projects
            .into_iter()
            .map(|p| json!({ "id": p["id"], "name": p["name"] }))
            .collect();
    }

    fn endpoints(&self, port: u16) -> Vec<MobileEndpoint> {
        let addresses: Vec<String> = interfaces(false).into_iter().map(|(_, a)| a.to_string()).collect();
        let addresses = if addresses.is_empty() { vec!["127.0.0.1".to_owned()] } else { addresses };
        addresses.into_iter().map(|address| MobileEndpoint { address, port }).collect()
    }

    pub fn snapshot(&self) -> Value {
        let settings = self.host.settings().read().mobile_access.clone();
        let key = block_on(self.identity.static_key()).ok();
        let host_id = block_on(self.identity.host_id());
        let public_key = key.as_ref().map(|k| hex(&k.public_key())).unwrap_or_default();
        let fingerprint = fingerprint_mobile_host_key(&public_key);
        let host_name = self.host_label();
        let status = self.rpc("mobile:status", Value::Null).unwrap_or(Value::Null);
        let listening = status["listening"].as_bool().unwrap_or(false);
        let port = status["port"].as_u64().map(|p| p as u16).or(self.configured_port()).unwrap_or(if settings.listen_port != 0 { settings.listen_port } else { DEFAULT_MOBILE_LISTENER_PORT });
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let details = MobileInvitationDetails {
            display_name: host_name.clone(),
            public_key_hex: public_key.clone(),
            endpoints: self.endpoints(port),
            relay: None::<MobileRelayRoute>,
        };
        let registry = lock(&self.registry);
        let invitation = registry.active_invitation(&now, &details);
        let nics = interfaces(false);
        let mut listener = json!({
            "listening": listening,
            "mode": settings.mode,
            "addresses": nics.iter().map(|(_, a)| a.to_string()).collect::<Vec<_>>(),
            "interfaces": nics.iter().map(|(n, a)| json!({ "name": n, "address": a.to_string() })).collect::<Vec<_>>(),
            "connectionCount": status["connectionCount"].as_u64().unwrap_or(0),
            "discovery": {
                "advertised": lock(&self.advertiser).is_some(), "hostId": host_id,
                "displayName": host_name, "fingerprint": fingerprint
            }
        });
        if listening || settings.mode != "off" {
            listener["port"] = json!(port);
        }
        if let Some(error) = status["bindError"].as_str().map(str::to_owned).or_else(|| lock(&self.bind_error).clone()) {
            listener["lastError"] = json!(error);
        }
        let mut snapshot = json!({
            "hostId": host_id,
            "hostName": host_name,
            "publicKeyHex": public_key,
            "fingerprint": fingerprint,
            "pending": registry.list_pending(),
            "devices": registry.list_devices(),
            "listener": listener,
            "projects": *lock(&self.projects)
        });
        if let Some(invitation) = invitation {
            snapshot["invitation"] = serde_json::to_value(invitation).unwrap_or(Value::Null);
        }
        snapshot
    }

    pub fn create_invitation(&self) -> Value {
        let snapshot = self.snapshot();
        let port = snapshot["listener"]["port"].as_u64().map_or(DEFAULT_MOBILE_LISTENER_PORT, |p| p as u16);
        let host_id = snapshot["hostId"].as_str().unwrap_or_default().to_owned();
        let pending = lock(&self.registry).list_pending();
        for waiting in pending {
            let status = mobile_connection_status(
                MobileConnectionStatusCode::InvitationExpired,
                Some("The desktop created a new pairing invitation, which replaced the one this phone used. Scan the new invitation."),
            );
            let _ = self.rpc("mobile:dropPublicKey", json!({ "publicKey": waiting.device_public_key, "status": status }));
        }
        let details = MobileInvitationDetails {
            display_name: snapshot["hostName"].as_str().unwrap_or_default().to_owned(),
            public_key_hex: snapshot["publicKeyHex"].as_str().unwrap_or_default().to_owned(),
            endpoints: self.endpoints(port),
            relay: None,
        };
        lock(&self.registry).issue_invitation(&host_id, &details, Utc::now());
        self.emit_pairing_changed();
        self.snapshot()
    }

    pub fn confirm_pairing(&self, request_id: &str, grant: &Value) -> Value {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let grant = MobilePairingGrant {
            label: grant["label"].as_str().map(str::to_owned),
            capabilities: capabilities(grant),
            project_ids: grant["projectIds"]
                .as_array()
                .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
        };
        let (confirmed, superseded) = {
            let mut registry = lock(&self.registry);
            let confirmed = registry.confirm(request_id, &grant, &now);
            (confirmed, registry.take_superseded())
        };
        if let Ok(device) = confirmed {
            for other in superseded {
                let status = mobile_connection_status(MobileConnectionStatusCode::InvitationUsed, None);
                let _ = self.rpc("mobile:dropPublicKey", json!({ "publicKey": other.device_public_key, "status": status }));
            }
            let _ = self.rpc(
                "mobile:promote",
                json!({
                    "publicKey": device.public_key_hex,
                    "grant": {
                        "deviceId": device.device_id,
                        "capabilities": device.granted_capabilities(),
                        "projectIds": device.project_ids
                    }
                }),
            );
        }
        self.emit_pairing_changed();
        self.snapshot()
    }

    pub fn deny_pairing(&self, request_id: &str) -> Value {
        let pending = lock(&self.registry).list_pending().into_iter().find(|p| p.request_id == request_id);
        lock(&self.registry).deny(request_id);
        if let Some(pending) = pending {
            let status = mobile_connection_status(MobileConnectionStatusCode::PairingRejected, None);
            let _ = self.rpc("mobile:dropPublicKey", json!({ "publicKey": pending.device_public_key, "status": status }));
        }
        self.emit_pairing_changed();
        self.snapshot()
    }

    pub fn revoke_device(&self, device_id: &str) -> Value {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        lock(&self.registry).revoke(device_id, &now);
        let status = mobile_connection_status(MobileConnectionStatusCode::DeviceRevoked, None);
        let _ = self.rpc("mobile:dropDevice", json!({ "deviceId": device_id, "status": status }));
        self.emit_pairing_changed();
        self.snapshot()
    }

    /// Every paired phone must distrust the new key; the listener rebinds with it.
    pub fn rotate_host_key(&self) -> Value {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        lock(&self.registry).revoke_all(&now);
        let status = mobile_connection_status(MobileConnectionStatusCode::HostKeyReset, None);
        let _ = self.rpc("mobile:dropAll", json!({ "status": status }));
        if let Err(error) = block_on(self.identity.rotate()) {
            self.log(&format!("[mobile] host key rotation failed to store: {error}"));
        }
        self.apply_mobile_access(true);
        self.snapshot()
    }

    pub fn dispatch(&self, channel: &str, args: &[Value], projects: Vec<Value>) -> Option<Result<Value>> {
        self.remember_projects(projects);
        let text = |index: usize| args.get(index).and_then(Value::as_str).unwrap_or_default().to_owned();
        Some(Ok(match channel {
            "settings:getMobileHostInfo" => self.snapshot(),
            "settings:createMobilePairingInvitation" => self.create_invitation(),
            "settings:confirmMobilePairing" => self.confirm_pairing(&text(0), args.get(1).unwrap_or(&Value::Null)),
            "settings:denyMobilePairing" => self.deny_pairing(&text(0)),
            "settings:revokeMobilePairedDevice" => self.revoke_device(&text(0)),
            "settings:rotateMobileHostKey" => self.rotate_host_key(),
            _ => return None,
        }))
    }
}

/// A reverse-call client whose frames are answered inside this process: the listener asks
/// `mobile.authorizePeer` / `mobile.unpairedPeer`, and this module answers.
pub fn in_process_calls(host: &HostContext) -> HostCallClient {
    let cell: Arc<std::sync::OnceLock<HostCallClient>> = Arc::new(std::sync::OnceLock::new());
    let reply_cell = Arc::clone(&cell);
    let host = host.clone();
    let client = HostCallClient::new(move |frame| {
        let HostWireFrame::Call { id, method, params } = frame else { return true };
        let (host, cell) = (host.clone(), Arc::clone(&reply_cell));
        std::thread::spawn(move || {
            let internal = format!("mobile:internal:{}", method.trim_start_matches("mobile."));
            let response = host.dispatch_rpc(praxis_contracts::RustRpcRequest { id: id.clone(), channel: internal, args: vec![params] });
            let reply = HostInboundReply::CallResponse {
                id,
                ok: response.ok,
                result: response.result,
                error: response.error.map(|e| e.message),
            };
            if let Some(client) = cell.get() {
                client.handle_reply(reply);
            }
        });
        true
    });
    let _ = cell.set(client.clone());
    client
}

/// Registers the in-process answers the listener's reverse calls resolve to.
pub fn register_internal_channels(host: &HostContext, mobile: &Arc<MobileHost>) {
    let m = Arc::clone(mobile);
    host.register_handler("mobile:internal:authorizePeer", move |_, args| {
        Ok(m.authorize_peer(args.first().and_then(|p| p["publicKey"].as_str()).unwrap_or_default()))
    });
    let m = Arc::clone(mobile);
    host.register_handler("mobile:internal:unpairedPeer", move |_, args| {
        let params = args.first().cloned().unwrap_or(Value::Null);
        Ok(m.unpaired_peer(params["publicKey"].as_str().unwrap_or_default(), params["tokenId"].as_str()))
    });
    // The phone's reads and commands run on the desktop's own session, run, project and schedule channels.
    super::mobile_services::register(host, mobile);
}
