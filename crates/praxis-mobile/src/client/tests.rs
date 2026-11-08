//! Ports of `client.test.ts`: a scripted Noise responder on a loopback TCP port.

use std::sync::Mutex as StdMutex;

use serde_json::json;
use tokio::net::{TcpListener, TcpStream};

use super::*;

enum PeerCommand {
    Send(Value),
    End,
}

#[derive(Clone)]
struct Peer(mpsc::UnboundedSender<PeerCommand>);

impl Peer {
    fn send(&self, frame: Value) {
        let _ = self.0.send(PeerCommand::Send(frame));
    }
    fn end(&self) {
        let _ = self.0.send(PeerCommand::End);
    }
}

type OnOpen = Box<dyn Fn(&Peer) + Send + Sync>;
type OnFrame = Box<dyn Fn(&Peer, &MobileRequestFrame) + Send + Sync>;

struct Script {
    on_open: OnOpen,
    on_frame: OnFrame,
}

fn script(
    on_open: impl Fn(&Peer) + Send + Sync + 'static,
    on_frame: impl Fn(&Peer, &MobileRequestFrame) + Send + Sync + 'static,
) -> Arc<Script> {
    Arc::new(Script {
        on_open: Box::new(on_open),
        on_frame: Box::new(on_frame),
    })
}

async fn serve(socket: TcpStream, host_key: KeyPair, script: Arc<Script>) {
    let (mut reader, mut writer) = socket.into_split();
    let mut channel =
        SecureChannel::responder(SecureChannelOptions::new(host_key)).expect("responder");
    let mut assembler = RecordAssembler::new();
    let (commands, mut queued) = mpsc::unbounded_channel();
    let peer = Peer(commands);
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            read = reader.read(&mut buffer) => {
                let Ok(count) = read else { return };
                if count == 0 {
                    return;
                }
                for record in assembler.push(&buffer[..count]).expect("assemble") {
                    if !channel.is_open() {
                        if channel.read_handshake_message(&record).is_err() {
                            return; // destroy the socket, as the TS fixture does
                        }
                        let reply = channel.next_handshake_message(&[]).expect("handshake reply");
                        writer.write_all(&reply).await.expect("write handshake");
                        (script.on_open)(&peer);
                        continue;
                    }
                    let plain = channel.decrypt(&record).expect("decrypt");
                    let frame: MobileRequestFrame = serde_json::from_slice(&plain).expect("request frame");
                    (script.on_frame)(&peer, &frame);
                }
            }
            command = queued.recv() => match command {
                Some(PeerCommand::Send(frame)) => {
                    let record = channel.encrypt(&serde_json::to_vec(&frame).expect("json")).expect("encrypt");
                    if writer.write_all(&record).await.is_err() {
                        return;
                    }
                }
                Some(PeerCommand::End) | None => {
                    let _ = writer.shutdown().await;
                    return;
                }
            }
        }
    }
}

async fn responder(host_key: &KeyPair, script: Arc<Script>) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("address").port();
    let host_key = host_key.clone();
    let server = tokio::spawn(async move {
        let mut connections = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            connections.push(tokio::spawn(serve(
                socket,
                host_key.clone(),
                script.clone(),
            )));
        }
    });
    (port, server)
}

fn client(
    port: u16,
    pinned: [u8; DHLEN],
) -> (
    MobileSecureClient,
    mpsc::UnboundedReceiver<MobileClientNotice>,
) {
    let mut options =
        MobileSecureClientOptions::new(format!("127.0.0.1:{port}"), KeyPair::generate(), pinned);
    options.connect_timeout = Duration::from_millis(2_000);
    options.request_timeout = Duration::from_millis(2_000);
    MobileSecureClient::new(options)
}

fn connector(
    port: u16,
) -> impl FnOnce() -> std::pin::Pin<Box<dyn Future<Output = std::io::Result<TcpStream>> + Send>>
+ Send
+ 'static {
    move || Box::pin(TcpStream::connect(("127.0.0.1", port)))
}

fn status(code: MobileConnectionStatusCode) -> Value {
    json!({ "kind": "status", "status": mobile_connection_status(code, None) })
}

fn drain(notices: &mut mpsc::UnboundedReceiver<MobileClientNotice>) -> Vec<MobileClientNotice> {
    let mut out = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        out.push(notice);
    }
    out
}

fn status_codes(notices: &[MobileClientNotice]) -> Vec<&'static str> {
    notices
        .iter()
        .filter_map(|n| match n {
            MobileClientNotice::Status(s) => Some(s.code.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn connects_on_ready_correlates_replies_and_delivers_pushed_events() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::Ready)),
            |peer, frame| {
                peer.send(json!({ "kind": "event", "envelope": { "sequence": 7 } }));
                peer.send(json!({ "id": frame.id, "kind": "reply", "ok": true, "value": { "echoed": frame.payload } }));
            },
        ),
    )
    .await;
    let (phone, mut notices) = client(port, host_key.public_key());
    phone.connect(connector(port)).await.expect("connect");
    assert!(phone.is_ready());
    let value = phone
        .read(json!({ "operation": "host.info" }))
        .await
        .expect("read");
    assert_eq!(value, json!({ "echoed": { "operation": "host.info" } }));
    let events: Vec<_> = drain(&mut notices)
        .into_iter()
        .filter_map(|n| match n {
            MobileClientNotice::Event(envelope) => envelope.get("sequence").and_then(Value::as_u64),
            _ => None,
        })
        .collect();
    assert_eq!(events, [7]);
    phone.close();
    server.abort();
}

#[tokio::test]
async fn presents_the_invitation_token_and_stays_pending_until_the_desktop_confirms() {
    let host_key = KeyPair::generate();
    let tokens = Arc::new(StdMutex::new(Vec::new()));
    let seen_tokens = tokens.clone();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::PairingRequired)),
            move |peer, frame| {
                if frame.kind != MobileRequestKind::Pair {
                    return;
                }
                seen_tokens
                    .lock()
                    .expect("tokens")
                    .push(frame.payload.clone());
                peer.send(status(MobileConnectionStatusCode::PairingPending));
                // Confirmation arrives long after the connect timeout: pending must not time out.
                let peer = peer.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    peer.send(status(MobileConnectionStatusCode::Ready));
                });
            },
        ),
    )
    .await;
    let mut options = MobileSecureClientOptions::new(
        format!("127.0.0.1:{port}"),
        KeyPair::generate(),
        host_key.public_key(),
    );
    options.pairing_token_id = Some("invite-123".into());
    options.connect_timeout = Duration::from_millis(300);
    let (phone, mut notices) = MobileSecureClient::new(options);
    phone.connect(connector(port)).await.expect("connect");
    assert_eq!(
        status_codes(&drain(&mut notices)),
        ["pairing-required", "pairing-pending", "ready"]
    );
    assert_eq!(
        *tokens.lock().expect("tokens"),
        [json!({ "tokenId": "invite-123" })]
    );
    phone.close();
    server.abort();
}

#[tokio::test]
async fn an_unknown_phone_without_an_invitation_is_told_to_pair() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::PairingRequired)),
            |_, _| {},
        ),
    )
    .await;
    let (phone, _notices) = client(port, host_key.public_key());
    let error = phone
        .connect(connector(port))
        .await
        .expect_err("must refuse");
    assert_eq!(
        error.code,
        MobileConnectionErrorCode::Status(MobileConnectionStatusCode::PairingRequired)
    );
    assert!(
        error.message.contains("Scan a current pairing invitation"),
        "{}",
        error.message
    );
    server.abort();
}

#[tokio::test]
async fn a_refusal_status_survives_the_socket_closing_and_names_the_reason() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::PairingRequired)),
            |peer, _| {
                peer.send(status(MobileConnectionStatusCode::InvitationExpired));
                peer.end();
            },
        ),
    )
    .await;
    let mut options = MobileSecureClientOptions::new(
        format!("127.0.0.1:{port}"),
        KeyPair::generate(),
        host_key.public_key(),
    );
    options.pairing_token_id = Some("old-token".into());
    let (phone, _notices) = MobileSecureClient::new(options);
    let error = phone
        .connect(connector(port))
        .await
        .expect_err("must refuse");
    assert_eq!(
        error.code,
        MobileConnectionErrorCode::Status(MobileConnectionStatusCode::InvitationExpired)
    );
    assert!(!error.retryable);
    server.abort();
}

#[tokio::test]
async fn a_desktop_that_rejects_the_pinned_key_surfaces_as_a_handshake_rejection() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::Ready)),
            |_, _| {},
        ),
    )
    .await;
    let (phone, _notices) = client(port, KeyPair::generate().public_key());
    let error = phone
        .connect(connector(port))
        .await
        .expect_err("must refuse");
    assert_eq!(
        error.code,
        MobileConnectionErrorCode::Transport(MobileTransportFailureCode::HandshakeRejected)
    );
    assert!(
        error.message.contains("host key may have been reset"),
        "{}",
        error.message
    );
    server.abort();
}

#[tokio::test]
async fn a_closed_port_is_reported_as_unreachable_with_the_endpoint() {
    let probe = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = probe.local_addr().expect("address").port();
    drop(probe);
    let (phone, _notices) = client(port, KeyPair::generate().public_key());
    let error = phone.connect(connector(port)).await.expect_err("must fail");
    assert_eq!(
        error.code,
        MobileConnectionErrorCode::Transport(MobileTransportFailureCode::Unreachable)
    );
    assert!(error.retryable);
    assert!(
        error.message.contains(&format!("127.0.0.1:{port}")),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn losing_an_established_session_reports_why_status_first_otherwise_connection_lost() {
    let host_key = KeyPair::generate();
    let peers = Arc::new(StdMutex::new(Vec::<Peer>::new()));
    let opened = peers.clone();
    let (port, server) = responder(
        &host_key,
        script(
            move |peer| {
                peer.send(status(MobileConnectionStatusCode::Ready));
                opened.lock().expect("peers").push(peer.clone());
            },
            |_, _| {},
        ),
    )
    .await;

    let (revoked, mut revoked_notices) = client(port, host_key.public_key());
    revoked.connect(connector(port)).await.expect("connect");
    let peer = peers.lock().expect("peers")[0].clone();
    peer.send(status(MobileConnectionStatusCode::DeviceRevoked));
    peer.end();
    let reason = loop {
        match revoked_notices.recv().await.expect("notice") {
            MobileClientNotice::Closed(error) => break error,
            _ => continue,
        }
    };
    assert_eq!(
        reason.code,
        MobileConnectionErrorCode::Status(MobileConnectionStatusCode::DeviceRevoked)
    );

    let (dropped, mut dropped_notices) = client(port, host_key.public_key());
    dropped.connect(connector(port)).await.expect("connect");
    peers.lock().expect("peers")[1].end();
    let reason = loop {
        match dropped_notices.recv().await.expect("notice") {
            MobileClientNotice::Closed(error) => break error,
            _ => continue,
        }
    };
    assert_eq!(
        reason.code,
        MobileConnectionErrorCode::Transport(MobileTransportFailureCode::ConnectionLost)
    );
    assert!(reason.retryable);
    server.abort();
}

#[tokio::test]
async fn a_desktop_from_before_status_frames_is_treated_as_ready_after_a_quiet_handshake() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |_| {},
            |peer, frame| {
                peer.send(json!({ "id": frame.id, "kind": "reply", "ok": true, "value": "legacy" }))
            },
        ),
    )
    .await;
    let mut options = MobileSecureClientOptions::new(
        format!("127.0.0.1:{port}"),
        KeyPair::generate(),
        host_key.public_key(),
    );
    options.legacy_ready_after = Duration::from_millis(100);
    let (phone, _notices) = MobileSecureClient::new(options);
    phone.connect(connector(port)).await.expect("connect");
    assert_eq!(phone.status(), None);
    assert_eq!(phone.read(json!({})).await.expect("read"), json!("legacy"));
    phone.close();
    server.abort();
}

#[tokio::test]
async fn a_rejected_request_carries_the_desktop_reason_and_code() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::Ready)),
            |peer, frame| peer.send(json!({ "id": frame.id, "kind": "reply", "ok": false, "code": "unsupported-operation", "error": "" })),
        ),
    )
    .await;
    let (phone, _notices) = client(port, host_key.public_key());
    phone.connect(connector(port)).await.expect("connect");
    let failure = phone
        .command(json!({ "operation": "x" }))
        .await
        .expect_err("rejected");
    assert_eq!(
        failure,
        MobileRequestFailure::Rejected(MobileRequestError {
            message: "The desktop rejected the request.".into(),
            code: Some(MobileReplyErrorCode::UnsupportedOperation),
        })
    );
    phone.close();
    server.abort();
}

#[tokio::test]
async fn close_is_silent_and_later_requests_are_refused() {
    let host_key = KeyPair::generate();
    let (port, server) = responder(
        &host_key,
        script(
            |peer| peer.send(status(MobileConnectionStatusCode::Ready)),
            |_, _| {},
        ),
    )
    .await;
    let (phone, mut notices) = client(port, host_key.public_key());
    phone.connect(connector(port)).await.expect("connect");
    phone.close();
    assert!(!phone.is_ready());
    let failure = phone.read(json!({})).await.expect_err("closed");
    assert!(
        matches!(failure, MobileRequestFailure::Connection(ref e) if e.code == MobileConnectionErrorCode::Transport(MobileTransportFailureCode::ConnectionLost))
    );
    assert!(
        !drain(&mut notices)
            .iter()
            .any(|n| matches!(n, MobileClientNotice::Closed(_)))
    );
    let again = phone
        .connect(connector(port))
        .await
        .expect_err("one connect only");
    assert!(again.message.contains("may only be called once"));
    server.abort();
}

#[test]
fn request_ids_use_base36_like_the_typescript() {
    assert_eq!(base36(0), "0");
    assert_eq!(base36(35), "z");
    assert_eq!(base36(36), "10");
    assert_eq!(base36(1_762_598_400_000), "mhq5ktmo");
}
