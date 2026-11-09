//! Rust mobile transport serving the TypeScript mobile application (TASK-520, transport-only).
//!
//! Rust owns Noise/TCP; every decoded, identity-stamped read and command is forwarded to
//! Electron over [`HostCallClient`] (`mobile.read` / `mobile.command`). Pairing decisions
//! (`mobile.authorizePeer` / `mobile.unpairedPeer`) are asked of Electron at handshake time and
//! fail closed. Electron drives lifecycle through the `mobile:*` RPC channels registered by
//! [`register_mobile_channels`] and feeds the event log via `mobile:appendEvent`.
//!
//! Command-id admission and replay run in the Rust ledger on this transport; the TypeScript
//! ledger keeps serving Electron IPC, so a phone must stay on one runtime between restarts.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use praxis_contracts::RustRpcError;
use praxis_mobile::host::access::{MobileAccessPolicy, MobilePeerContext};
use praxis_mobile::host::application::{
    MobileExecutionHandlers, MobileHostApplication, MobileHostError, MobileHostReads,
    command_handler, default_payload_digest, read_handler,
};
use praxis_mobile::host::identity::{MobileRelayIdentity, ed25519_from_pkcs8_der};
use praxis_mobile::host::lan_server::{
    MobileLanAuthorizedPeer, MobileLanServer, MobileLanServerDeps, MobileLocalAddress,
    MobilePeerAuthorizer, UnpairedPeerHandler,
};
use praxis_mobile::host::ledger::{
    InMemoryMobileCommandLedger, MOBILE_EVENT_RETENTION, MobileCommandLedger,
};
use praxis_mobile::host::protocol::{
    MobileCapability, MobileCommandOperation, MobileEventEnvelope, MobileReadOperation,
};
use praxis_mobile::host::relay_client::{
    MobileRelayClient, MobileRelayClientOptions, MobileRelaySnapshot, MobileRelayState,
};
use praxis_mobile::noise::KeyPair;
use praxis_mobile::wire::{
    MobileConnectionStatus, MobileConnectionStatusCode, mobile_connection_status,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::call_client::HostCallClient;
use crate::context::HostContext;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(5);

/// Builds the application whose handlers forward every operation to Electron.
#[must_use]
pub fn proxy_application(
    calls: HostCallClient,
    ledger: Arc<dyn MobileCommandLedger>,
) -> MobileHostApplication {
    let mut reads = MobileHostReads::new();
    for &operation in MobileReadOperation::ALL {
        let calls = calls.clone();
        reads.insert(
            operation,
            read_handler(move |request| {
                let calls = calls.clone();
                async move {
                    let params = serde_json::to_value(&request)
                        .map_err(|error| MobileHostError::new(error.to_string()))?;
                    calls
                        .call("mobile.read", params, READ_TIMEOUT)
                        .await
                        .map_err(|error| MobileHostError::new(error.to_string()))
                }
            }),
        );
    }
    let mut commands = MobileExecutionHandlers::new();
    for &operation in MobileCommandOperation::ALL {
        let calls = calls.clone();
        commands.insert(
            operation,
            command_handler(move |command| {
                let calls = calls.clone();
                async move {
                    let params = serde_json::to_value(&command)
                        .map_err(|error| MobileHostError::new(error.to_string()))?;
                    calls
                        .call("mobile.command", params, COMMAND_TIMEOUT)
                        .await
                        .map_err(|error| MobileHostError::new(error.to_string()))
                }
            }),
        );
    }
    MobileHostApplication {
        reads,
        commands,
        ledger,
        payload_digest: default_payload_digest(),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantDto {
    pub device_id: String,
    #[serde(default)]
    pub capabilities: Vec<MobileCapability>,
    #[serde(default)]
    pub project_ids: Vec<String>,
}

impl From<GrantDto> for MobileLanAuthorizedPeer {
    fn from(dto: GrantDto) -> Self {
        Self {
            device_id: dto.device_id,
            capabilities: dto.capabilities,
            project_ids: dto.project_ids,
        }
    }
}

/// Blocks the current multi-thread runtime worker on an Electron call. The listener's
/// authorizer callbacks are synchronous, so this is how a pairing decision is awaited.
fn call_blocking(
    handle: &Handle,
    calls: &HostCallClient,
    method: &str,
    params: Value,
) -> Option<Value> {
    let run = || {
        handle
            .block_on(calls.call(method, params, PAIRING_TIMEOUT))
            .ok()
    };
    if Handle::try_current().is_ok() {
        tokio::task::block_in_place(run)
    } else {
        run()
    }
}

fn authorizer(handle: Handle, calls: HostCallClient) -> MobilePeerAuthorizer {
    Arc::new(move |public_key| {
        let value = call_blocking(
            &handle,
            &calls,
            "mobile.authorizePeer",
            json!({ "publicKey": public_key }),
        )?;
        serde_json::from_value::<Option<GrantDto>>(value)
            .ok()
            .flatten()
            .map(Into::into)
    })
}

fn unpaired_handler(handle: Handle, calls: HostCallClient) -> UnpairedPeerHandler {
    Arc::new(move |public_key, token_id| {
        call_blocking(
            &handle,
            &calls,
            "mobile.unpairedPeer",
            json!({ "publicKey": public_key, "tokenId": token_id }),
        )
        .and_then(|value| serde_json::from_value::<MobileConnectionStatus>(value).ok())
        // Fail closed: no answer from Electron means the phone is not admitted.
        .unwrap_or_else(|| mobile_connection_status(MobileConnectionStatusCode::AccessDisabled, None))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayParams {
    relay_url: String,
    /// Hex PKCS#8 DER of the desktop's Ed25519 relay key (the TypeScript secret-store format).
    relay_signing_key: String,
    host_private_key: String,
    #[serde(default)]
    pairing_code: Option<String>,
}

fn relay_snapshot_json(snapshot: &MobileRelaySnapshot) -> Value {
    let state = match snapshot.state {
        MobileRelayState::Stopped => "stopped",
        MobileRelayState::Connecting => "connecting",
        MobileRelayState::Registered => "registered",
        MobileRelayState::Error => "error",
    };
    json!({ "state": state, "channel": snapshot.channel, "error": snapshot.error })
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return Err("expected hex".into());
    }
    (0..hex.len() / 2)
        .map(|i| {
            u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| "expected hex".to_string())
        })
        .collect()
}

fn decode_key(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 || !hex.is_ascii() {
        return Err("host key must be 64 hex characters".into());
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| "host key must be hex".to_string())?;
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    port: u16,
    policy: MobileAccessPolicy,
    addresses: Vec<AddressDto>,
    /// Hex X25519 private key; the public half is derived.
    host_private_key: String,
    #[serde(default)]
    pairing_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressDto {
    interface_name: String,
    address: IpAddr,
}

/// Owns the running listener and the injected event ledger.
pub struct MobileBridge {
    handle: Handle,
    calls: HostCallClient,
    ledger: Arc<InMemoryMobileCommandLedger>,
    server: Mutex<Option<(String, MobileLanServer)>>,
    relay: Mutex<Option<RunningRelay>>,
}

struct RunningRelay {
    url: String,
    client: Arc<MobileRelayClient>,
    watcher: tokio::task::JoinHandle<()>,
}

impl MobileBridge {
    #[must_use]
    pub fn new(handle: Handle, calls: HostCallClient) -> Arc<Self> {
        Arc::new(Self {
            handle,
            calls,
            ledger: Arc::new(InMemoryMobileCommandLedger::new(MOBILE_EVENT_RETENTION)),
            server: Mutex::new(None),
            relay: Mutex::new(None),
        })
    }

    fn server(&self) -> Option<MobileLanServer> {
        self.server
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|(_, server)| server.clone())
    }

    /// The running server for this host key, creating (or replacing) it when the key changed.
    fn ensure_server(
        &self,
        host_private_key: &str,
        pairing_code: Option<String>,
    ) -> Result<MobileLanServer, String> {
        let keypair = KeyPair::from_private_key(decode_key(host_private_key)?);
        let fingerprint = format!("{:?}", keypair.public_key());
        let existing = {
            let guard = self.server.lock().unwrap_or_else(PoisonError::into_inner);
            guard
                .as_ref()
                .filter(|(key, _)| *key == fingerprint)
                .map(|(_, server)| server.clone())
        };
        if let Some(server) = existing {
            return Ok(server);
        }
        let ledger: Arc<dyn MobileCommandLedger> = self.ledger.clone();
        let mut deps =
            MobileLanServerDeps::new(proxy_application(self.calls.clone(), ledger), keypair);
        deps.pairing_code = pairing_code;
        deps.authorize_peer = Some(authorizer(self.handle.clone(), self.calls.clone()));
        deps.on_unpaired_peer = Some(unpaired_handler(self.handle.clone(), self.calls.clone()));
        let server = MobileLanServer::new(deps);
        let old = self
            .server
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace((fingerprint, server.clone()));
        if let Some((_, old)) = old {
            // A replaced server (key rotation) drops its phones; relay streams must re-attach.
            self.stop_relay();
            self.handle.block_on(old.stop());
        }
        Ok(server)
    }

    /// Binds (or rebinds) the listener. A new host key replaces the server wholesale.
    pub fn start(&self, params: Value) -> Result<Value, String> {
        let params: StartParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        let server = self.ensure_server(&params.host_private_key, params.pairing_code.clone())?;
        let addresses: Vec<MobileLocalAddress> = params
            .addresses
            .into_iter()
            .map(|a| MobileLocalAddress {
                interface_name: a.interface_name,
                address: SocketAddr::new(a.address, 0),
            })
            .collect();
        self.handle
            .block_on(server.start(params.port, params.policy, &addresses))?;
        Ok(self.status_value())
    }

    pub fn stop(&self) -> Value {
        if let Some(server) = self.server() {
            self.handle.block_on(server.stop());
        }
        self.status_value()
    }

    #[must_use]
    pub fn status_value(&self) -> Value {
        let Some(server) = self.server() else {
            return json!({ "listening": false, "connectionCount": 0, "addresses": [], "relay": self.relay_snapshot_value() });
        };
        let port = self.handle.block_on(server.port());
        let addresses: Vec<String> = self
            .handle
            .block_on(server.addresses())
            .iter()
            .map(|a| a.address.ip().to_string())
            .collect();
        json!({
            "listening": port.is_some(),
            "port": port,
            "addresses": addresses,
            "bindError": self.handle.block_on(server.bind_error()),
            "connectionCount": server.connection_count(),
            "relay": self.relay_snapshot_value(),
        })
    }

    pub fn append_event(&self, params: Value) -> Result<(), String> {
        let envelope: MobileEventEnvelope =
            serde_json::from_value(params).map_err(|e| e.to_string())?;
        self.ledger.append_event(envelope);
        Ok(())
    }

    pub fn apply_policy(&self, params: &Value) -> Result<(), String> {
        let policy: MobileAccessPolicy =
            serde_json::from_value(params["policy"].clone()).map_err(|e| e.to_string())?;
        let drop = params["dropConnections"].as_bool().unwrap_or(false);
        if let Some(server) = self.server() {
            server.apply_policy(policy, drop);
        }
        Ok(())
    }

    fn status_arg(params: &Value) -> Result<MobileConnectionStatus, String> {
        serde_json::from_value(params["status"].clone()).map_err(|e| e.to_string())
    }

    pub fn drop_device(&self, params: &Value) -> Result<Value, String> {
        let status = Self::status_arg(params)?;
        let id = params["deviceId"].as_str().ok_or("deviceId required")?;
        Ok(json!(
            self.server().map_or(0, |s| s.drop_device(id, status))
        ))
    }

    pub fn drop_public_key(&self, params: &Value) -> Result<Value, String> {
        let status = Self::status_arg(params)?;
        let key = params["publicKey"].as_str().ok_or("publicKey required")?;
        Ok(json!(
            self.server().map_or(0, |s| s.drop_public_key(key, status))
        ))
    }

    pub fn promote(&self, params: &Value) -> Result<(), String> {
        let key = params["publicKey"].as_str().ok_or("publicKey required")?;
        let grant: GrantDto =
            serde_json::from_value(params["grant"].clone()).map_err(|e| e.to_string())?;
        if let Some(server) = self.server() {
            server.promote_pending(key, grant.into());
        }
        Ok(())
    }

    /// Registers with the relay and feeds relayed phone streams to the listener. Idempotent
    /// for the same URL; a new URL replaces the connection.
    pub fn relay_start(&self, params: Value) -> Result<Value, String> {
        let params: RelayParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        let server = self.ensure_server(&params.host_private_key, params.pairing_code.clone())?;
        let already_running = self
            .relay
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|r| r.url == params.relay_url);
        if already_running {
            return Ok(self.relay_snapshot_value());
        }
        self.stop_relay();
        let der = decode_hex(&params.relay_signing_key)?;
        let signing_key =
            ed25519_from_pkcs8_der(&der).ok_or("relay signing key is not PKCS#8 Ed25519")?;
        let serving = server.clone();
        let options = MobileRelayClientOptions::new(
            params.relay_url.clone(),
            MobileRelayIdentity::from_signing_key(signing_key),
            Arc::new(move |stream| {
                serving.accept_stream(
                    stream,
                    MobilePeerContext {
                        remote_address: "relay".into(),
                        relay_route: true,
                        ..MobilePeerContext::default()
                    },
                );
            }),
        );
        let client = Arc::new(MobileRelayClient::new(options)?);
        // Report every state change so Electron can publish the route to its pairing UI.
        let mut states = client.subscribe();
        let report = self.calls.clone();
        let watcher = self.handle.spawn(async move {
            while states.changed().await.is_ok() {
                let snapshot = relay_snapshot_json(&states.borrow().clone());
                let _ = report
                    .call("mobile.relayState", snapshot, PAIRING_TIMEOUT)
                    .await;
            }
        });
        let started = Arc::clone(&client);
        self.handle.block_on(async move { started.start().await });
        *self.relay.lock().unwrap_or_else(PoisonError::into_inner) = Some(RunningRelay {
            url: params.relay_url,
            client,
            watcher,
        });
        Ok(self.relay_snapshot_value())
    }

    pub fn relay_stop(&self) -> Value {
        self.stop_relay();
        self.relay_snapshot_value()
    }

    fn stop_relay(&self) {
        let taken = self
            .relay
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(running) = taken {
            running.watcher.abort();
            let client = running.client;
            self.handle.block_on(async move { client.stop().await });
        }
    }

    fn relay_snapshot_value(&self) -> Value {
        match &*self.relay.lock().unwrap_or_else(PoisonError::into_inner) {
            Some(running) => relay_snapshot_json(&running.client.snapshot()),
            None => relay_snapshot_json(&MobileRelaySnapshot::default()),
        }
    }

    /// Drops every phone (host shutdown) and releases the sockets.
    pub fn shutdown(&self) {
        self.stop_relay();
        let taken = self
            .server
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((_, server)) = taken {
            self.handle.block_on(server.stop());
        }
    }
}

fn rpc_error(message: String) -> RustRpcError {
    RustRpcError {
        code: "MOBILE_BRIDGE_ERROR".into(),
        message,
    }
}

/// Registers the `mobile:*` control channels on `host`.
pub fn register_mobile_channels(host: &HostContext, bridge: &Arc<MobileBridge>) {
    fn arg(args: &[Value]) -> Value {
        args.first().cloned().unwrap_or(Value::Null)
    }
    let b = Arc::clone(bridge);
    host.register_handler("mobile:start", move |_, args| {
        b.start(arg(args)).map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:relayStart", move |_, args| {
        b.relay_start(arg(args)).map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:relayStop", move |_, _| Ok(b.relay_stop()));
    let b = Arc::clone(bridge);
    host.register_handler("mobile:stop", move |_, _| Ok(b.stop()));
    let b = Arc::clone(bridge);
    host.register_handler("mobile:status", move |_, _| Ok(b.status_value()));
    let b = Arc::clone(bridge);
    host.register_handler("mobile:appendEvent", move |_, args| {
        b.append_event(arg(args))
            .map(|()| Value::Null)
            .map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:applyPolicy", move |_, args| {
        b.apply_policy(&arg(args))
            .map(|()| Value::Null)
            .map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:dropDevice", move |_, args| {
        b.drop_device(&arg(args)).map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:dropPublicKey", move |_, args| {
        b.drop_public_key(&arg(args)).map_err(rpc_error)
    });
    let b = Arc::clone(bridge);
    host.register_handler("mobile:promote", move |_, args| {
        b.promote(&arg(args))
            .map(|()| Value::Null)
            .map_err(rpc_error)
    });
}
