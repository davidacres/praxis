//! The Rust mobile listener serving a stand-in "Electron" that answers `mobile.*` host calls.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use praxis_host::mobile_bridge::MobileBridge;
use praxis_host::{HostCallClient, HostInboundReply, HostWireFrame};
use praxis_mobile::noise::KeyPair;
use praxis_mobile::{MobileClientNotice, MobileSecureClient, MobileSecureClientOptions};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

/// Wires a `HostCallClient` to `answer`, which plays the Electron side.
fn electron(
    answer: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
) -> (HostCallClient, Calls) {
    let log: Calls = Arc::new(Mutex::new(Vec::new()));
    let slot: Arc<OnceLock<HostCallClient>> = Arc::new(OnceLock::new());
    let (sink_log, sink_slot) = (Arc::clone(&log), Arc::clone(&slot));
    let answer = Arc::new(answer);
    let client = HostCallClient::new(move |frame| {
        let HostWireFrame::Call { id, method, params } = frame else {
            return false;
        };
        sink_log
            .lock()
            .unwrap()
            .push((method.clone(), params.clone()));
        let (slot, answer) = (Arc::clone(&sink_slot), Arc::clone(&answer));
        tokio::spawn(async move {
            let reply = match answer(&method, &params) {
                Ok(result) => HostInboundReply::CallResponse {
                    id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => HostInboundReply::CallResponse {
                    id,
                    ok: false,
                    result: None,
                    error: Some(error),
                },
            };
            if let Some(client) = slot.get() {
                client.handle_reply(reply);
            }
        });
        true
    });
    let _ = slot.set(client.clone());
    (client, log)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn start(bridge: &Arc<MobileBridge>, key: &KeyPair) -> SocketAddr {
    let params = json!({
        "port": 0,
        "policy": {"mode": "local-only", "allowedInterfaces": [], "allowedSubnets": []},
        "addresses": [{"interfaceName": "loopback", "address": "127.0.0.1"}],
        "hostPrivateKey": hex(&*key.private_key()),
    });
    let bridge = Arc::clone(bridge);
    let status = tokio::task::spawn_blocking(move || bridge.start(params))
        .await
        .unwrap()
        .unwrap();
    SocketAddr::from((
        [127, 0, 0, 1],
        status["port"].as_u64().expect("port") as u16,
    ))
}

fn phone(host: &KeyPair) -> (MobileSecureClient, UnboundedReceiver<MobileClientNotice>) {
    let mut options =
        MobileSecureClientOptions::new("test", KeyPair::generate(), host.public_key());
    options.connect_timeout = Duration::from_secs(2);
    options.request_timeout = Duration::from_secs(2);
    options.legacy_ready_after = Duration::ZERO;
    MobileSecureClient::new(options)
}

fn request(operation: &str, project: &str) -> Value {
    json!({"protocolVersion": 1, "requestId": "req", "operation": operation,
        "target": {"hostId": "host", "projectId": project},
        "caller": {"deviceId": "forged", "subject": "admin", "capabilities": ["view", "execute", "approve"]}})
}

fn paired_electron() -> (HostCallClient, Calls, Arc<AtomicUsize>) {
    let commands = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&commands);
    let (calls, log) = electron(move |method, params| match method {
        "mobile.authorizePeer" => Ok(
            json!({"deviceId": "phone-1", "capabilities": ["view", "execute"], "projectIds": ["p1"]}),
        ),
        "mobile.read" => Ok(json!({"callerSeenByElectron": params["caller"]})),
        "mobile.command" => {
            seen.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"created": params["commandId"]}))
        }
        other => Err(format!("unexpected {other}")),
    });
    (calls, log, commands)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forwards_stamped_reads_and_replays_commands_without_re_forwarding() {
    let (calls, log, commands) = paired_electron();
    let bridge = MobileBridge::new(tokio::runtime::Handle::current(), calls);
    let key = KeyPair::generate();
    let address = start(&bridge, &key).await;

    let (phone, _notices) = phone(&key);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");

    // The forged caller claim is replaced by the paired identity before Electron sees it.
    let reply = phone.read(request("work.list", "p1")).await.expect("read");
    assert_eq!(reply["callerSeenByElectron"]["deviceId"], "phone-1");
    assert!(reply["callerSeenByElectron"].get("subject").is_none());
    assert_eq!(
        reply["callerSeenByElectron"]["capabilities"],
        json!(["view", "execute"])
    );

    // A project outside the grant never reaches Electron.
    let before = log
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == "mobile.read")
        .count();
    assert!(phone.read(request("work.list", "p2")).await.is_err());
    assert_eq!(
        log.lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "mobile.read")
            .count(),
        before
    );

    let mut command = request("sessions.create", "p1");
    command["commandId"] = json!("command-0001");
    command["issuedAt"] = json!("2026-11-09T10:00:00.000Z");
    command["payload"] = json!({});
    let first = phone.command(command.clone()).await.expect("command");
    let second = phone.command(command).await.expect("replay");
    assert_eq!(first, second);
    assert_eq!(
        commands.load(Ordering::SeqCst),
        1,
        "a retry replays the recorded outcome"
    );

    phone.close();
    let stopper = Arc::clone(&bridge);
    tokio::task::spawn_blocking(move || stopper.shutdown())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_electron_failure_reaches_the_phone_and_unknown_peers_fail_closed() {
    // Electron refuses to authorise anyone and reports pairing is required.
    let (calls, log) = electron(|method, _| match method {
        "mobile.authorizePeer" => Ok(Value::Null),
        "mobile.unpairedPeer" => Ok(
            json!({"code": "pairing-required", "message": "scan an invitation", "retryable": false}),
        ),
        other => Err(format!("unexpected {other}")),
    });
    let bridge = MobileBridge::new(tokio::runtime::Handle::current(), calls);
    let key = KeyPair::generate();
    let address = start(&bridge, &key).await;

    let (phone, mut notices) = phone(&key);
    let _ = phone.connect(move || TcpStream::connect(address)).await;
    let saw_pairing = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(notice) = notices.recv().await {
            if matches!(notice, MobileClientNotice::Status(ref s) if format!("{:?}", s.code).contains("PairingRequired")) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(saw_pairing, "the unpaired peer is told to pair");
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "mobile.unpairedPeer")
    );
    assert!(phone.read(request("work.list", "p1")).await.is_err());

    let stopper = Arc::clone(&bridge);
    tokio::task::spawn_blocking(move || stopper.shutdown())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_rejects_bad_keys_and_control_calls_work_before_any_server() {
    let (calls, _log) = electron(|_, _| Ok(Value::Null));
    let bridge = MobileBridge::new(tokio::runtime::Handle::current(), calls);
    let b = Arc::clone(&bridge);
    let outcome = tokio::task::spawn_blocking(move || {
        let bad = b.start(json!({"port": 0, "policy": {"mode": "off", "allowedInterfaces": [], "allowedSubnets": []},
            "addresses": [], "hostPrivateKey": "zz"}));
        let status = b.status_value();
        let stopped = b.stop();
        let dropped = b.drop_device(&json!({"deviceId": "x", "status": {"code": "device-revoked", "message": "", "retryable": false}}));
        (bad, status, stopped, dropped)
    })
    .await
    .unwrap();
    assert!(outcome.0.is_err());
    assert_eq!(outcome.1["listening"], false);
    assert_eq!(outcome.2["listening"], false);
    assert_eq!(outcome.3.unwrap(), json!(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_streams_reach_electron_and_state_changes_are_reported() {
    use praxis_mobile::host::identity::{MobileRelayIdentity, ed25519_pkcs8_der};
    use praxis_mobile::host::relay_client::run_relay_stream;
    use praxis_mobile::relay::{RelayServer, RelayServerOptions};

    let (calls, log, _commands) = paired_electron_with_relay_state();
    let mut relay = RelayServer::start(RelayServerOptions {
        address: Some("127.0.0.1:0".parse().unwrap()),
        ..RelayServerOptions::default()
    })
    .await
    .expect("relay");
    let bridge = MobileBridge::new(tokio::runtime::Handle::current(), calls);
    let key = KeyPair::generate();
    let identity = MobileRelayIdentity::generate();
    let params = json!({
        "relayUrl": format!("ws://127.0.0.1:{}", relay.port()),
        "relaySigningKey": hex(&ed25519_pkcs8_der(&identity.signing_key)),
        "hostPrivateKey": hex(&*key.private_key()),
    });
    let b = Arc::clone(&bridge);
    tokio::task::spawn_blocking(move || {
        b.relay_start(params.clone()).expect("relay start");
        // The same URL is idempotent.
        b.relay_start(params).expect("relay restart");
        b.apply_policy(
            &json!({"policy": {"mode": "internet", "allowedInterfaces": [], "allowedSubnets": []}}),
        )
    })
    .await
    .unwrap()
    .expect("policy");

    let channel = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let reported = log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p)| m == "mobile.relayState" && p["state"] == "registered")
                .map(|(_, p)| p["channel"].as_str().unwrap().to_owned())
                .next();
            if let Some(channel) = reported {
                return channel;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("registered state reported to Electron");

    let (phone, _notices) = phone(&key);
    let port = relay.port();
    phone
        .connect(move || async move {
            let (ws, _) = tokio_tungstenite::connect_async(format!(
                "ws://127.0.0.1:{port}/v1/connect?channel={channel}"
            ))
            .await
            .map_err(std::io::Error::other)?;
            let (stream, far) = tokio::io::duplex(65536);
            tokio::spawn(async move {
                let _ = run_relay_stream(ws, far).await;
            });
            Ok(stream)
        })
        .await
        .expect("relay phone");
    let reply = phone
        .read(request("work.list", "p1"))
        .await
        .expect("read over relay");
    assert_eq!(reply["callerSeenByElectron"]["deviceId"], "phone-1");

    let b = Arc::clone(&bridge);
    let stopped = tokio::task::spawn_blocking(move || b.relay_stop())
        .await
        .unwrap();
    assert_eq!(stopped["state"], "stopped");
    let stopper = Arc::clone(&bridge);
    tokio::task::spawn_blocking(move || stopper.shutdown())
        .await
        .unwrap();
    relay.stop();
}

fn paired_electron_with_relay_state() -> (HostCallClient, Calls, Arc<AtomicUsize>) {
    let commands = Arc::new(AtomicUsize::new(0));
    let (calls, log) = electron(|method, params| match method {
        "mobile.authorizePeer" => {
            Ok(json!({"deviceId": "phone-1", "capabilities": ["view"], "projectIds": ["p1"]}))
        }
        "mobile.read" => Ok(json!({"callerSeenByElectron": params["caller"]})),
        "mobile.relayState" => Ok(Value::Null),
        other => Err(format!("unexpected {other}")),
    });
    (calls, log, commands)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_start_rejects_insecure_urls_and_bad_keys() {
    let (calls, _log) = electron(|_, _| Ok(Value::Null));
    let bridge = MobileBridge::new(tokio::runtime::Handle::current(), calls);
    let key = KeyPair::generate();
    let b = Arc::clone(&bridge);
    let host_key = hex(&*key.private_key());
    let outcomes = tokio::task::spawn_blocking(move || {
        let identity = praxis_mobile::host::identity::MobileRelayIdentity::generate();
        let der = hex(&praxis_mobile::host::identity::ed25519_pkcs8_der(&identity.signing_key));
        (
            b.relay_start(json!({"relayUrl": "ws://relay.example", "relaySigningKey": der, "hostPrivateKey": host_key})),
            b.relay_start(json!({"relayUrl": "wss://relay.example", "relaySigningKey": "00", "hostPrivateKey": host_key})),
            b.status_value(),
        )
    })
    .await
    .unwrap();
    assert!(outcomes.0.is_err(), "plain ws to a remote host is refused");
    assert!(outcomes.1.is_err(), "a non-Ed25519 key is refused");
    assert_eq!(outcomes.2["relay"]["state"], "stopped");
}
