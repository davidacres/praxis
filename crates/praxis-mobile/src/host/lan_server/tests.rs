use super::super::application::{
    MobileExecutionHandlers, MobileHostReads, command_handler, default_payload_digest, read_handler,
};
use super::super::ledger::{InMemoryMobileCommandLedger, MobileCommandLedger};
use super::super::protocol::{MobileCommandOperation, MobileEventEnvelope, MobileTarget};
use super::*;
use crate::{MobileClientNotice, MobileSecureClient, MobileSecureClientOptions};
use tokio::net::TcpStream;

pub(crate) fn grant() -> MobileLanAuthorizedPeer {
    MobileLanAuthorizedPeer {
        device_id: "paired-phone".into(),
        capabilities: vec![MobileCapability::View, MobileCapability::Execute],
        project_ids: vec!["p1".into()],
    }
}
pub(crate) fn app() -> MobileHostApplication {
    let mut reads = MobileHostReads::new();
    reads.insert(
        MobileReadOperation::ProjectsSnapshot,
        read_handler(|_| async {
            Ok(json!({"projects": [{"projectId": "p1"}, {"projectId": "p2"}]}))
        }),
    );
    reads.insert(
        MobileReadOperation::WorkList,
        read_handler(|request| async move { Ok(json!(request.caller)) }),
    );
    let mut commands = MobileExecutionHandlers::new();
    commands.insert(
        MobileCommandOperation::SessionsCreate,
        command_handler(|command| async move { Ok(json!(command.caller)) }),
    );
    MobileHostApplication {
        reads,
        commands,
        ledger: Arc::new(InMemoryMobileCommandLedger::new(3)),
        payload_digest: default_payload_digest(),
    }
}
pub(crate) fn read(operation: &str, project: Option<&str>) -> Value {
    json!({"protocolVersion": 1, "requestId": "req", "operation": operation,
        "target": {"hostId": "host", "projectId": project},
        "caller": {"deviceId": "forged", "subject": "admin", "capabilities": ["view", "execute", "approve"]}})
}
pub(crate) fn phone(
    host: &KeyPair,
) -> (
    MobileSecureClient,
    tokio::sync::mpsc::UnboundedReceiver<MobileClientNotice>,
) {
    let mut options =
        MobileSecureClientOptions::new("test", KeyPair::generate(), host.public_key());
    options.connect_timeout = Duration::from_secs(2);
    options.request_timeout = Duration::from_secs(2);
    options.legacy_ready_after = Duration::ZERO;
    MobileSecureClient::new(options)
}
async fn fixture(
    configure: impl FnOnce(&mut MobileLanServerDeps),
) -> (
    MobileLanServer,
    KeyPair,
    Arc<dyn MobileCommandLedger>,
    SocketAddr,
) {
    let key = KeyPair::generate();
    let app = app();
    let ledger = app.ledger.clone();
    let mut deps = MobileLanServerDeps::new(app, key.clone());
    deps.authorize_peer = Some(Arc::new(|_| Some(grant())));
    configure(&mut deps);
    let server = MobileLanServer::new(deps);
    let addresses = [MobileLocalAddress {
        interface_name: "loopback".into(),
        address: "127.0.0.1:0".parse().expect("address"),
    }];
    server
        .start(
            0,
            MobileAccessPolicy::with_mode(MobileAccessMode::LocalOnly),
            &addresses,
        )
        .await
        .expect("start");
    let address = SocketAddr::from(([127, 0, 0, 1], server.port().await.expect("port")));
    (server, key, ledger, address)
}
pub(crate) async fn closed(notices: &mut tokio::sync::mpsc::UnboundedReceiver<MobileClientNotice>) {
    timeout(Duration::from_secs(2), async {
        while let Some(notice) = notices.recv().await {
            if matches!(notice, MobileClientNotice::Closed(_)) {
                return;
            }
        }
        panic!("no close notice");
    })
    .await
    .expect("closed");
}
async fn status(
    notices: &mut tokio::sync::mpsc::UnboundedReceiver<MobileClientNotice>,
    expected: Status,
) {
    timeout(Duration::from_secs(2), async {
        while let Some(notice) = notices.recv().await {
            if matches!(notice, MobileClientNotice::Status(ref status) if status.code == expected) {
                return;
            }
        }
        panic!("no status");
    })
    .await
    .expect("status");
}
fn event(ledger: &dyn MobileCommandLedger, sequence: u64, project: Option<&str>, kind: &str) {
    ledger.append_event(MobileEventEnvelope {
        protocol_version: 1,
        event_id: format!("e{sequence}"),
        sequence,
        emitted_at: "now".into(),
        target: MobileTarget {
            host_id: "host".into(),
            project_id: project.map(str::to_owned),
            ..MobileTarget::default()
        },
        event: json!({"type": kind}),
    });
}
async fn next_event(notices: &mut tokio::sync::mpsc::UnboundedReceiver<MobileClientNotice>) -> u64 {
    timeout(Duration::from_secs(2), async {
        loop {
            if let Some(MobileClientNotice::Event(event)) = notices.recv().await {
                return event["sequence"].as_u64().expect("sequence");
            }
        }
    })
    .await
    .expect("event")
}

#[tokio::test]
async fn encrypted_reads_bind_identity_and_filter_discovery_and_project_access() {
    let (server, key, _, address) = fixture(|_| {}).await;
    let (phone, _) = phone(&key);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");
    assert_eq!(
        phone
            .read(read("projects.snapshot", None))
            .await
            .expect("projects"),
        json!({"projects": [{"projectId": "p1"}]})
    );
    let caller = phone
        .read(read("work.list", Some("p1")))
        .await
        .expect("read");
    assert_eq!(caller["deviceId"], "paired-phone");
    assert!(caller.get("subject").is_none());
    assert_eq!(caller["capabilities"], json!(["view", "execute"]));
    assert!(
        phone
            .read(read("work.list", Some("p2")))
            .await
            .expect_err("scope")
            .to_string()
            .contains("not authorised for project p2")
    );
    assert!(
        phone
            .read(read("work.list", None))
            .await
            .expect_err("scope")
            .to_string()
            .contains("requires an authorised project")
    );
    assert!(
        phone
            .read(read("providers.list", None))
            .await
            .expect_err("unsupported")
            .to_string()
            .contains("Update Praxis")
    );
    phone.close();
    server.stop().await;
}
#[tokio::test]
async fn wire_claims_cannot_elevate_a_view_only_device() {
    let (server, key, _, address) = fixture(|deps| {
        deps.authorize_peer = Some(Arc::new(|_| {
            let mut grant = grant();
            grant.capabilities = vec![MobileCapability::View];
            Some(grant)
        }))
    })
    .await;
    let (phone, _) = phone(&key);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");
    let mut command = read("sessions.create", Some("p1"));
    command["commandId"] = json!("command-0001");
    command["issuedAt"] = json!("2026-11-09T10:00:00.000Z");
    command["payload"] = json!({});
    assert!(
        phone
            .command(command)
            .await
            .expect_err("capability")
            .to_string()
            .contains("execute capability")
    );
    phone.close();
    server.stop().await;
}
#[tokio::test]
async fn absent_authorizer_and_disallowed_subnets_refuse_with_status() {
    for missing_authorizer in [true, false] {
        let (server, key, _, address) = fixture(|deps| {
            if missing_authorizer {
                deps.authorize_peer = None;
            }
        })
        .await;
        if !missing_authorizer {
            server.apply_policy(
                MobileAccessPolicy {
                    allowed_subnets: vec!["10.0.0.0/24".into()],
                    ..MobileAccessPolicy::with_mode(MobileAccessMode::LocalOnly)
                },
                false,
            );
        }
        let (phone, _) = phone(&key);
        assert!(
            phone
                .connect(move || TcpStream::connect(address))
                .await
                .is_err()
        );
        assert_eq!(phone.status().expect("status").code, Status::AccessDenied);
        server.stop().await;
    }
}
#[tokio::test]
async fn pairing_presents_token_and_promotion_readies_the_same_socket() {
    let seen = Arc::new(Mutex::new(vec![]));
    let captured = seen.clone();
    let (server, host, _, address) = fixture(move |deps| {
        deps.authorize_peer = None;
        deps.on_unpaired_peer = Some(Arc::new(move |key, token| {
            captured
                .lock()
                .expect("seen")
                .push((key.to_owned(), token.map(str::to_owned)));
            mobile_connection_status(
                if token == Some("invitation") {
                    Status::PairingPending
                } else {
                    Status::PairingRequired
                },
                None,
            )
        }));
    })
    .await;
    let phone_key = KeyPair::generate();
    let public_key = hex(&phone_key.public_key());
    let mut options = MobileSecureClientOptions::new("test", phone_key, host.public_key());
    options.pairing_token_id = Some("invitation".into());
    options.legacy_ready_after = Duration::ZERO;
    let (phone, mut notices) = MobileSecureClient::new(options);
    let connecting = phone.clone();
    let task = tokio::spawn(async move {
        connecting
            .connect(move || TcpStream::connect(address))
            .await
    });
    status(&mut notices, Status::PairingPending).await;
    assert!(!phone.is_ready());
    assert!(
        seen.lock()
            .expect("seen")
            .iter()
            .any(|(_, token)| token.as_deref() == Some("invitation"))
    );
    server.promote_pending(&public_key.to_uppercase(), grant());
    task.await.expect("task").expect("ready");
    assert!(phone.read(read("work.list", Some("p1"))).await.is_ok());
    phone.close();
    server.stop().await;
}
#[tokio::test]
async fn rejects_wrong_host_key_and_pairing_prologue() {
    let (server, key, _, address) =
        fixture(|deps| deps.pairing_code = Some("secret prologue".into())).await;
    let (phone1, _) = phone(&key);
    assert!(
        phone1
            .connect(move || TcpStream::connect(address))
            .await
            .is_err()
    );
    let mut options = MobileSecureClientOptions::new("test", KeyPair::generate(), key.public_key());
    options.prologue = Some(b"secret prologue".to_vec());
    options.legacy_ready_after = Duration::ZERO;
    let (phone2, _) = MobileSecureClient::new(options);
    phone2
        .connect(move || TcpStream::connect(address))
        .await
        .expect("prologue");
    phone2.close();
    let (phone3, _) = phone(&KeyPair::generate());
    assert!(
        phone3
            .connect(move || TcpStream::connect(address))
            .await
            .is_err()
    );
    server.stop().await;
}
#[tokio::test]
async fn events_start_live_and_filter_both_live_delivery_and_truncated_replay() {
    let (server, key, ledger, address) = fixture(|_| {}).await;
    event(&*ledger, 1, Some("p1"), "session.snapshot");
    event(&*ledger, 2, Some("p1"), "session.snapshot");
    let (phone, mut notices) = phone(&key);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");
    event(&*ledger, 3, Some("p2"), "session.snapshot");
    event(&*ledger, 4, Some("p1"), "session.snapshot");
    event(&*ledger, 5, None, "host.appearance");
    assert_eq!(next_event(&mut notices).await, 4);
    assert_eq!(next_event(&mut notices).await, 5);
    let replay = phone.replay(0).await.expect("replay");
    assert_eq!(replay.truncated, Some(true));
    assert_eq!(replay.latest_sequence, 5);
    assert_eq!(next_event(&mut notices).await, 4);
    assert_eq!(next_event(&mut notices).await, 5);
    phone.close();
    server.stop().await;
}
#[tokio::test]
async fn revocation_key_reset_policy_narrowing_and_stop_close_established_sockets() {
    for action in 0..4 {
        let public = Arc::new(Mutex::new(String::new()));
        let captured = public.clone();
        let (server, key, _, address) = fixture(move |deps| {
            deps.authorize_peer = Some(Arc::new(move |key| {
                *captured.lock().expect("key") = key.into();
                Some(grant())
            }))
        })
        .await;
        let (phone, mut notices) = phone(&key);
        phone
            .connect(move || TcpStream::connect(address))
            .await
            .expect("connect");
        let expected = match action {
            0 => {
                assert_eq!(
                    server.drop_device(
                        "paired-phone",
                        mobile_connection_status(Status::DeviceRevoked, None)
                    ),
                    1
                );
                Status::DeviceRevoked
            }
            1 => {
                assert_eq!(
                    server.drop_public_key(
                        &public.lock().expect("key").to_uppercase(),
                        mobile_connection_status(Status::HostKeyReset, None)
                    ),
                    1
                );
                Status::HostKeyReset
            }
            2 => {
                server.apply_policy(MobileAccessPolicy::off(), false);
                Status::AccessDisabled
            }
            _ => {
                server.stop().await;
                Status::HostShutdown
            }
        };
        status(&mut notices, expected).await;
        closed(&mut notices).await;
        assert!(!phone.is_ready());
        server.stop().await;
    }
}
#[tokio::test]
async fn silent_pending_peers_expire_and_release_admission_capacity() {
    let (server, key, _, address) = fixture(|deps| {
        deps.handshake_timeout = Duration::from_millis(100);
        deps.max_peers_per_address = 1;
    })
    .await;
    let mut silent = TcpStream::connect(address).await.expect("socket");
    timeout(Duration::from_secs(1), async {
        while server.connection_count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("accepted");
    let (phone1, _) = phone(&key);
    assert!(
        phone1
            .connect(move || TcpStream::connect(address))
            .await
            .is_err()
    );
    assert_eq!(
        timeout(Duration::from_secs(1), silent.read(&mut [0; 1]))
            .await
            .expect("timeout")
            .expect("read"),
        0
    );
    let (phone2, _) = phone(&key);
    phone2
        .connect(move || TcpStream::connect(address))
        .await
        .expect("capacity released");
    phone2.close();
    server.stop().await;
}
#[tokio::test]
async fn binds_only_explicit_local_addresses_and_rolls_back_failed_rebinds() {
    let (server, _, _, _) = fixture(|_| {}).await;
    assert_eq!(
        server.addresses().await[0].address.ip().to_string(),
        "127.0.0.1"
    );
    let unavailable = [MobileLocalAddress {
        interface_name: "other".into(),
        address: "0.0.0.0:0".parse().expect("address"),
    }];
    assert!(
        server
            .start(
                0,
                MobileAccessPolicy::with_mode(MobileAccessMode::LocalOnly),
                &unavailable
            )
            .await
            .is_err()
    );
    let occupied = TcpListener::bind("127.0.0.1:0").await.expect("occupied");
    assert!(
        server
            .start(
                occupied.local_addr().expect("address").port(),
                MobileAccessPolicy::with_mode(MobileAccessMode::LocalOnly),
                &server.addresses().await
            )
            .await
            .is_err()
    );
    assert!(server.port().await.is_none());
    assert!(server.bind_error().await.is_some());
    server.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_admissions_reserve_a_command_id_once() {
    let ledger = Arc::new(InMemoryMobileCommandLedger::default());
    let barrier = Arc::new(tokio::sync::Barrier::new(32));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let ledger = ledger.clone();
        let barrier = barrier.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            ledger.admit("one-command", "same", "now").expect("admit").1
        });
    }
    let mut fresh = 0;
    while let Some(result) = tasks.join_next().await {
        if !result.expect("task") {
            fresh += 1;
        }
    }
    assert_eq!(fresh, 1);
}

#[tokio::test]
#[ignore = "requires built TypeScript mobile-protocol; set PRAXIS_TS_WORKSPACE to the dependency checkout"]
async fn real_typescript_phone_interoperates_over_lan_and_relay_without_plaintext_leaks() {
    let dependency_root = std::env::var("PRAXIS_TS_WORKSPACE").expect("PRAXIS_TS_WORKSPACE");
    let (server, host, ledger, address) = fixture(|_| {}).await;
    event(&*ledger, 1, Some("p1"), "session.snapshot");
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/host_transport_client.cjs"
    );
    let run = |port: u16, channel: Option<String>| {
        let mut command = tokio::process::Command::new("node");
        command
            .arg(script)
            .arg(&dependency_root)
            .arg(port.to_string())
            .arg(hex(&host.public_key()));
        if let Some(channel) = channel {
            command.arg(channel);
        }
        command.kill_on_drop(true);
        async move {
            let output = timeout(Duration::from_secs(10), command.output())
                .await
                .expect("node timeout")
                .expect("node");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            println!("{}", String::from_utf8_lossy(&output.stdout));
        }
    };
    run(address.port(), None).await;
    use super::super::identity::MobileRelayIdentity;
    use super::super::relay_client::{MobileRelayClient, MobileRelayClientOptions};
    let mut relay = crate::relay::RelayServer::start(crate::relay::RelayServerOptions {
        address: Some("127.0.0.1:0".parse().expect("address")),
        ..crate::relay::RelayServerOptions::default()
    })
    .await
    .expect("relay");
    server.apply_policy(
        MobileAccessPolicy::with_mode(MobileAccessMode::Internet),
        false,
    );
    let serving = server.clone();
    let client = MobileRelayClient::new(MobileRelayClientOptions::new(
        format!("ws://127.0.0.1:{}", relay.port()),
        MobileRelayIdentity::generate(),
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
    ))
    .expect("client");
    let mut state = client.subscribe();
    client.start().await;
    let channel = timeout(Duration::from_secs(3), async {
        loop {
            if let Some(channel) = state.borrow().channel.clone() {
                break channel;
            }
            state.changed().await.expect("state");
        }
    })
    .await
    .expect("registered");
    run(relay.port(), Some(channel)).await;
    client.stop().await;
    server.stop().await;
    relay.stop();
}

#[tokio::test]
async fn revocation_is_responsive_while_an_admitted_mutation_finishes_its_ledger_outcome() {
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let beginning = started.clone();
    let finishing = finish.clone();
    let (server, host, ledger, address) = fixture(move |deps| {
        deps.app.commands.insert(
            MobileCommandOperation::SessionsCreate,
            command_handler(move |_| {
                let beginning = beginning.clone();
                let finishing = finishing.clone();
                async move {
                    beginning.notify_one();
                    finishing.notified().await;
                    Ok(json!({"completed": true}))
                }
            }),
        );
    })
    .await;
    let (phone, mut notices) = phone(&host);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");
    let mut command = read("sessions.create", Some("p1"));
    command["commandId"] = json!("slow-command-01");
    command["issuedAt"] = json!("2026-11-09T10:00:00.000Z");
    command["payload"] = json!({});
    let sending = phone.clone();
    let request = tokio::spawn(async move { sending.command(command).await });
    timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("started");
    assert!(
        phone.read(read("work.list", Some("p1"))).await.is_ok(),
        "a long command must not block other requests on the same phone"
    );
    server.drop_device(
        "paired-phone",
        mobile_connection_status(Status::DeviceRevoked, None),
    );
    status(&mut notices, Status::DeviceRevoked).await;
    closed(&mut notices).await;
    assert!(request.await.expect("request").is_err());
    finish.notify_one();
    timeout(Duration::from_secs(2), async {
        loop {
            if ledger.get("slow-command-01").expect("record").state
                == crate::host::ledger::MobileCommandState::Completed
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("durable outcome");
    assert_eq!(
        ledger.get("slow-command-01").expect("record").outcome,
        Some(json!({"completed": true}))
    );
    server.stop().await;
}

async fn raw_record(stream: &mut TcpStream) -> Vec<u8> {
    let length = timeout(Duration::from_secs(2), stream.read_u32())
        .await
        .expect("timeout")
        .expect("header") as usize;
    assert!(length <= crate::MAX_RECORD);
    let mut bytes = vec![0; length];
    timeout(Duration::from_secs(2), stream.read_exact(&mut bytes))
        .await
        .expect("timeout")
        .expect("record");
    bytes
}
async fn raw_phone(address: SocketAddr, host: &KeyPair) -> (TcpStream, SecureChannel) {
    let mut options = SecureChannelOptions::new(KeyPair::generate());
    options.remote_static_public_key = Some(host.public_key());
    let mut channel = SecureChannel::initiator(options).expect("channel");
    let mut stream = TcpStream::connect(address).await.expect("stream");
    // Force framing and handshake parsing across many socket reads.
    for byte in channel.next_handshake_message(&[]).expect("handshake") {
        stream.write_all(&[byte]).await.expect("write");
    }
    channel
        .read_handshake_message(&raw_record(&mut stream).await)
        .expect("handshake");
    (stream, channel)
}
#[tokio::test]
async fn unknown_phone_cannot_dispatch_claimed_capabilities_and_terminal_pair_refusals_close() {
    let calls = Arc::new(AtomicU64::new(0));
    let observed = calls.clone();
    let (server, host, _, address) = fixture(move |deps| {
        deps.authorize_peer = None;
        deps.on_unpaired_peer = Some(Arc::new(|_, token| {
            mobile_connection_status(
                if token.is_some() {
                    Status::InvitationExpired
                } else {
                    Status::PairingRequired
                },
                None,
            )
        }));
        deps.app.reads.insert(
            MobileReadOperation::WorkList,
            read_handler(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                async { Ok(json!("private")) }
            }),
        );
    })
    .await;
    let (mut stream, mut channel) = raw_phone(address, &host).await;
    let first: Value = serde_json::from_slice(
        &channel
            .decrypt(&raw_record(&mut stream).await)
            .expect("decrypt"),
    )
    .expect("status");
    assert_eq!(first["status"]["code"], "pairing-required");
    let request =
        json!({"id": "claimed", "kind": "read", "payload": read("work.list", Some("p1"))});
    stream
        .write_all(
            &channel
                .encrypt(&serde_json::to_vec(&request).expect("json"))
                .expect("encrypt"),
        )
        .await
        .expect("write");
    let reply: Value = serde_json::from_slice(
        &channel
            .decrypt(&raw_record(&mut stream).await)
            .expect("decrypt"),
    )
    .expect("reply");
    assert_eq!(reply["code"], "pairing-pending");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let pair = json!({"id": "pair", "kind": "pair", "payload": {"tokenId": "expired"}});
    stream
        .write_all(
            &channel
                .encrypt(&serde_json::to_vec(&pair).expect("json"))
                .expect("encrypt"),
        )
        .await
        .expect("write");
    let refusal: Value = serde_json::from_slice(
        &channel
            .decrypt(&raw_record(&mut stream).await)
            .expect("decrypt"),
    )
    .expect("status");
    assert_eq!(refusal["status"]["code"], "invitation-expired");
    assert_eq!(
        timeout(Duration::from_secs(2), stream.read(&mut [0; 1]))
            .await
            .expect("timeout")
            .expect("read"),
        0
    );
    server.stop().await;
}
#[tokio::test]
async fn oversized_and_malformed_frames_close_only_the_offending_connection() {
    let (server, host, _, address) = fixture(|_| {}).await;
    for oversized in [true, false] {
        let (mut stream, mut channel) = raw_phone(address, &host).await;
        channel
            .decrypt(&raw_record(&mut stream).await)
            .expect("ready");
        let bytes = if oversized {
            ((crate::MAX_RECORD + 1) as u32).to_be_bytes().to_vec()
        } else {
            channel.encrypt(b"not json").expect("encrypt")
        };
        stream.write_all(&bytes).await.expect("write");
        assert_eq!(
            timeout(Duration::from_secs(2), stream.read(&mut [0; 1]))
                .await
                .expect("timeout")
                .expect("read"),
            0
        );
    }
    let (phone, _) = phone(&host);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("healthy peer");
    assert!(phone.read(read("work.list", Some("p1"))).await.is_ok());
    phone.close();
    server.stop().await;
}

#[tokio::test]
async fn dropping_the_last_server_handle_releases_its_listener_and_connected_peers() {
    let (server, host, _, address) = fixture(|_| {}).await;
    let (phone, mut notices) = phone(&host);
    phone
        .connect(move || TcpStream::connect(address))
        .await
        .expect("connect");
    drop(server);
    closed(&mut notices).await;
    assert!(!phone.is_ready());
    timeout(Duration::from_secs(2), async {
        loop {
            if TcpStream::connect(address).await.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("listener released");
}
