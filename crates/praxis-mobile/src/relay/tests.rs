//! Ports of `relayServer.test.ts`, driven by a `tokio-tungstenite` client.

use std::sync::Mutex as StdMutex;

use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{self, Message as WsMessage};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use super::*;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct HostKey {
    signing: SigningKey,
    public_key_hex: String,
}

fn host_key() -> HostKey {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("random seed");
    let signing = SigningKey::from_bytes(&seed);
    let public_key_hex = hex(signing.verifying_key().as_bytes());
    HostKey {
        signing,
        public_key_hex,
    }
}

fn sign_nonce(key: &HostKey, nonce: &str) -> String {
    hex(&key
        .signing
        .sign(format!("{RELAY_SIGNATURE_CONTEXT}{nonce}").as_bytes())
        .to_bytes())
}

struct TestRelay {
    server: RelayServer,
    url: String,
    logs: Arc<StdMutex<Vec<String>>>,
}

async fn with_relay(limits: RelayLimits) -> TestRelay {
    let logs = Arc::new(StdMutex::new(Vec::new()));
    let sink = logs.clone();
    let options = RelayServerOptions {
        address: Some(SocketAddr::from(([127, 0, 0, 1], 0))),
        limits,
        on_log: Some(Arc::new(move |line: &str| {
            sink.lock().expect("logs").push(line.to_owned())
        })),
    };
    let server = RelayServer::start(options).await.expect("relay starts");
    let url = format!("ws://127.0.0.1:{}", server.port());
    TestRelay { server, url, logs }
}

async fn open(url: &str) -> Ws {
    connect_async(url).await.expect("websocket opens").0
}

async fn next_message(ws: &mut Ws) -> WsMessage {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("message in time")
        {
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
            Some(Ok(message)) => return message,
            other => panic!("socket ended: {other:?}"),
        }
    }
}

async fn next_json(ws: &mut Ws) -> Value {
    match next_message(ws).await {
        WsMessage::Text(text) => serde_json::from_str(text.as_str()).expect("json"),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    match next_message(ws).await {
        WsMessage::Binary(bytes) => bytes.to_vec(),
        other => panic!("expected binary, got {other:?}"),
    }
}

/// The close code the relay sent (1006 when the socket ended without one).
async fn closed(ws: &mut Ws) -> u16 {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close in time")
        {
            Some(Ok(WsMessage::Close(Some(frame)))) => return u16::from(frame.code),
            Some(Ok(WsMessage::Close(None))) | None | Some(Err(_)) => return 1006,
            Some(Ok(_)) => continue,
        }
    }
}

async fn send_binary(ws: &mut Ws, bytes: &[u8]) {
    ws.send(WsMessage::Binary(bytes.to_vec().into()))
        .await
        .expect("send");
}

async fn send_text(ws: &mut Ws, text: String) {
    ws.send(WsMessage::Text(text.into())).await.expect("send");
}

async fn register(url: &str, key: &HostKey) -> (Ws, String) {
    let mut control = open(&format!("{url}/v1/host?key={}", key.public_key_hex)).await;
    let challenge = next_json(&mut control).await;
    assert_eq!(challenge["type"], "challenge");
    assert_eq!(challenge["version"], RELAY_PROTOCOL_VERSION);
    let nonce = challenge["nonce"].as_str().expect("nonce").to_owned();
    send_text(
        &mut control,
        json!({ "type": "auth", "signature": sign_nonce(key, &nonce) }).to_string(),
    )
    .await;
    let registered = next_json(&mut control).await;
    assert_eq!(registered["type"], "registered");
    let channel = registered["channel"].as_str().expect("channel").to_owned();
    (control, channel)
}

async fn incoming_conn(control: &mut Ws) -> String {
    let incoming = next_json(control).await;
    assert_eq!(incoming["type"], "incoming");
    incoming["conn"].as_str().expect("conn").to_owned()
}

#[tokio::test]
async fn a_host_registers_a_phone_connects_and_bytes_flow_both_ways_in_order() {
    let relay = with_relay(RelayLimits::default()).await;
    let key = host_key();
    let (mut control, channel) = register(&relay.url, &key).await;
    assert_eq!(
        Some(channel.clone()),
        channel_id_for_key(&key.public_key_hex)
    );

    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    // Sent before the host attaches: must be buffered and delivered first, in order.
    send_binary(&mut phone, b"one").await;
    send_binary(&mut phone, b"two").await;
    let conn = incoming_conn(&mut control).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut accept = open(&format!(
        "{}/v1/accept?channel={channel}&conn={conn}",
        relay.url
    ))
    .await;
    send_binary(&mut phone, b"three").await;
    let mut seen = Vec::new();
    for _ in 0..3 {
        seen.push(String::from_utf8(next_binary(&mut accept).await).expect("utf8"));
    }
    assert_eq!(seen, ["one", "two", "three"]);

    send_binary(&mut accept, b"pong").await;
    assert_eq!(next_binary(&mut phone).await, b"pong");
}

#[tokio::test]
async fn a_host_that_cannot_sign_the_challenge_is_refused_and_registers_nothing() {
    let relay = with_relay(RelayLimits::default()).await;
    let real = host_key();
    let impostor = host_key();
    let mut control = open(&format!(
        "{}/v1/host?key={}",
        relay.url, real.public_key_hex
    ))
    .await;
    let nonce = next_json(&mut control).await["nonce"]
        .as_str()
        .expect("nonce")
        .to_owned();
    send_text(
        &mut control,
        json!({ "type": "auth", "signature": sign_nonce(&impostor, &nonce) }).to_string(),
    )
    .await;
    assert_eq!(closed(&mut control).await, close_code::AUTH_FAILED);
    assert_eq!(relay.server.channel_count(), 0);
}

#[tokio::test]
async fn a_signature_over_one_nonce_is_useless_for_another_connection() {
    let relay = with_relay(RelayLimits::default()).await;
    let key = host_key();
    let mut first = open(&format!("{}/v1/host?key={}", relay.url, key.public_key_hex)).await;
    let old_nonce = next_json(&mut first).await["nonce"]
        .as_str()
        .expect("nonce")
        .to_owned();
    first.close(None).await.expect("close");

    let mut second = open(&format!("{}/v1/host?key={}", relay.url, key.public_key_hex)).await;
    send_text(
        &mut second,
        json!({ "type": "auth", "signature": sign_nonce(&key, &old_nonce) }).to_string(),
    )
    .await;
    assert_eq!(closed(&mut second).await, close_code::AUTH_FAILED);
}

#[tokio::test]
async fn an_unauthenticated_host_times_out() {
    let relay = with_relay(RelayLimits {
        auth_timeout: Duration::from_millis(100),
        ..RelayLimits::default()
    })
    .await;
    let mut control = open(&format!(
        "{}/v1/host?key={}",
        relay.url,
        host_key().public_key_hex
    ))
    .await;
    assert_eq!(closed(&mut control).await, close_code::AUTH_FAILED);
}

#[tokio::test]
async fn a_guessed_channel_id_gets_no_route() {
    let relay = with_relay(RelayLimits::default()).await;
    let mut phone = open(&format!(
        "{}/v1/connect?channel={}",
        relay.url,
        "0".repeat(32)
    ))
    .await;
    assert_eq!(closed(&mut phone).await, close_code::HOST_OFFLINE);
}

#[tokio::test]
async fn an_unknown_path_or_bad_key_is_a_bad_request_and_plain_http_gets_404() {
    let relay = with_relay(RelayLimits::default()).await;
    let mut lost = open(&format!("{}/v2/elsewhere", relay.url)).await;
    assert_eq!(closed(&mut lost).await, close_code::BAD_REQUEST);
    let mut bad_key = open(&format!("{}/v1/host?key=xyz", relay.url)).await;
    assert_eq!(closed(&mut bad_key).await, close_code::BAD_REQUEST);

    let mut stream = TcpStream::connect(("127.0.0.1", relay.server.port()))
        .await
        .expect("tcp");
    tokio::io::AsyncWriteExt::write_all(
        &mut stream,
        b"GET / HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n",
    )
    .await
    .expect("write");
    let mut response = String::new();
    tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut response)
        .await
        .expect("read");
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    assert!(response.ends_with("praxis-relay"), "{response}");
}

#[tokio::test]
async fn accept_with_an_unknown_or_reused_connection_id_is_refused() {
    let relay = with_relay(RelayLimits::default()).await;
    let (mut control, channel) = register(&relay.url, &host_key()).await;
    let _phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    let conn = incoming_conn(&mut control).await;

    let mut forged = open(&format!(
        "{}/v1/accept?channel={channel}&conn={}",
        relay.url,
        "f".repeat(32)
    ))
    .await;
    assert_eq!(closed(&mut forged).await, close_code::BAD_REQUEST);

    let _accept = open(&format!(
        "{}/v1/accept?channel={channel}&conn={conn}",
        relay.url
    ))
    .await;
    let mut reused = open(&format!(
        "{}/v1/accept?channel={channel}&conn={conn}",
        relay.url
    ))
    .await;
    assert_eq!(closed(&mut reused).await, close_code::BAD_REQUEST);
}

#[tokio::test]
async fn a_phone_the_host_never_answers_is_closed_after_the_accept_timeout() {
    let relay = with_relay(RelayLimits {
        accept_timeout: Duration::from_millis(100),
        ..RelayLimits::default()
    })
    .await;
    let (_control, channel) = register(&relay.url, &host_key()).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    assert_eq!(closed(&mut phone).await, close_code::WAIT_TIMEOUT);
}

#[tokio::test]
async fn pending_connections_per_channel_are_capped() {
    let relay = with_relay(RelayLimits {
        max_pending_per_channel: 2,
        ..RelayLimits::default()
    })
    .await;
    let (mut control, channel) = register(&relay.url, &host_key()).await;
    let url = format!("{}/v1/connect?channel={channel}", relay.url);
    let _a = open(&url).await;
    incoming_conn(&mut control).await;
    let _b = open(&url).await;
    incoming_conn(&mut control).await;
    let mut c = open(&url).await;
    assert_eq!(closed(&mut c).await, close_code::TOO_MANY_PEERS);
}

#[tokio::test]
async fn an_oversized_message_closes_the_socket() {
    let relay = with_relay(RelayLimits {
        max_message_bytes: 1024,
        ..RelayLimits::default()
    })
    .await;
    let (_control, channel) = register(&relay.url, &host_key()).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    send_binary(&mut phone, &[0u8; 4096]).await;
    assert_eq!(closed(&mut phone).await, close_code::MESSAGE_TOO_BIG);
}

#[tokio::test]
async fn a_phone_that_floods_before_the_host_attaches_hits_the_buffer_limit() {
    let relay = with_relay(RelayLimits {
        max_buffered_bytes: 100,
        ..RelayLimits::default()
    })
    .await;
    let (_control, channel) = register(&relay.url, &host_key()).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    send_binary(&mut phone, &[0u8; 200]).await;
    assert_eq!(closed(&mut phone).await, close_code::RATE_LIMITED);
}

#[tokio::test]
async fn sustained_traffic_beyond_the_byte_budget_is_cut_off() {
    let relay = with_relay(RelayLimits {
        bytes_per_second: 10.0,
        burst_bytes: 100.0,
        ..RelayLimits::default()
    })
    .await;
    let (_control, channel) = register(&relay.url, &host_key()).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    send_binary(&mut phone, &[0u8; 90]).await;
    send_binary(&mut phone, &[0u8; 90]).await;
    assert_eq!(closed(&mut phone).await, close_code::RATE_LIMITED);
}

#[tokio::test]
async fn the_host_going_offline_closes_its_phones_and_frees_the_channel() {
    let relay = with_relay(RelayLimits::default()).await;
    let (mut control, channel) = register(&relay.url, &host_key()).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    let conn = incoming_conn(&mut control).await;
    let _accept = open(&format!(
        "{}/v1/accept?channel={channel}&conn={conn}",
        relay.url
    ))
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    control.close(None).await.expect("close");
    assert_eq!(closed(&mut phone).await, close_code::HOST_OFFLINE);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(relay.server.channel_count(), 0);
}

#[tokio::test]
async fn a_newer_registration_replaces_the_older_one() {
    let relay = with_relay(RelayLimits::default()).await;
    let key = host_key();
    let (mut first, _) = register(&relay.url, &key).await;
    let (_second, _) = register(&relay.url, &key).await;
    assert_eq!(closed(&mut first).await, close_code::REPLACED);
    assert_eq!(relay.server.channel_count(), 1);
}

#[tokio::test]
async fn connections_per_address_are_rate_limited_before_the_upgrade() {
    let relay = with_relay(RelayLimits {
        max_connects_per_minute: 2,
        ..RelayLimits::default()
    })
    .await;
    let url = format!("{}/v1/connect?channel={}", relay.url, "0".repeat(32));
    let mut a = open(&url).await;
    let mut b = open(&url).await;
    closed(&mut a).await;
    closed(&mut b).await;
    match connect_async(&url).await {
        Err(tungstenite::Error::Http(response)) => assert_eq!(response.status().as_u16(), 429),
        other => panic!("expected a 429 refusal, got {:?}", other.map(|_| ())),
    }
}

#[tokio::test]
async fn payloads_and_keys_never_reach_the_log() {
    let relay = with_relay(RelayLimits::default()).await;
    let key = host_key();
    let (mut control, channel) = register(&relay.url, &key).await;
    let mut phone = open(&format!("{}/v1/connect?channel={channel}", relay.url)).await;
    send_binary(&mut phone, b"TOP-SECRET-PAYLOAD").await;
    let conn = incoming_conn(&mut control).await;
    let mut accept = open(&format!(
        "{}/v1/accept?channel={channel}&conn={conn}",
        relay.url
    ))
    .await;
    assert_eq!(next_binary(&mut accept).await, b"TOP-SECRET-PAYLOAD");
    let joined = relay.logs.lock().expect("logs").join("\n");
    assert!(joined.contains("registered"), "{joined}");
    assert!(!joined.contains("TOP-SECRET-PAYLOAD"));
    assert!(!joined.contains(&key.public_key_hex));
    assert!(
        !joined.contains(&channel),
        "the full channel id is not logged"
    );
}

#[test]
fn the_byte_budget_refills_at_its_rate_up_to_the_burst() {
    let mut budget = ByteBudget::new(1000.0, 100.0);
    assert!(budget.take(100));
    assert!(!budget.take(1));
    budget.last -= Duration::from_millis(50);
    assert!(budget.take(50));
    assert!(!budget.take(10));
}
